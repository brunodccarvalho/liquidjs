import { getPerformance } from '../util/performance'
import { Drop } from '../drop/drop'
import { __assign } from 'tslib'
import { NormalizedFullOptions, defaultOptions, RenderOptions } from '../liquid-options'
import { Scope } from './scope'
import { hasOwnProperty, isArray, isNil, isUndefined, isString, isFunction, toLiquid, InternalUndefinedVariableError, toValueSync, isObject, Limiter, toValue } from '../util'

type PropertyKey = string | number;

export class Context {
  /**
   * insert a Context-level empty scope,
   * for tags like `{% capture %}` `{% assign %}` to operate
   */
  private scopes: Scope[] = [{}]
  private registers = {}
  /**
   * user passed in scope
   * `{% increment %}`, `{% decrement %}` changes this scope,
   * whereas `{% capture %}`, `{% assign %}` only hide this scope
   */
  public environments: Scope
  /**
   * global scope used as fallback for missing variables
   */
  public globals: Scope
  public sync: boolean
  public breakCalled = false
  public continueCalled = false
  /**
   * The normalized liquid options object
   */
  public opts: NormalizedFullOptions
  /**
   * Throw when accessing undefined variable?
   */
  public strictVariables: boolean;
  public ownPropertyOnly: boolean;
  public memoryLimit: Limiter;
  public renderLimit: Limiter;
  public constructor (env: object = {}, opts: NormalizedFullOptions = defaultOptions, renderOptions: RenderOptions = {}, { memoryLimit, renderLimit }: { [key: string]: Limiter } = {}) {
    this.sync = !!renderOptions.sync
    this.opts = opts
    this.globals = renderOptions.globals ?? opts.globals
    this.environments = isObject(env) ? env : Object(env)
    this.strictVariables = renderOptions.strictVariables ?? this.opts.strictVariables
    this.ownPropertyOnly = renderOptions.ownPropertyOnly ?? opts.ownPropertyOnly
    this.memoryLimit = memoryLimit ?? new Limiter('memory alloc', renderOptions.memoryLimit ?? opts.memoryLimit)
    this.renderLimit = renderLimit ?? new Limiter('template render', getPerformance().now() + (renderOptions.renderLimit ?? opts.renderLimit))
  }
  public getRegister (key: string) {
    return (this.registers[key] = this.registers[key] || {})
  }
  public setRegister (key: string, value: any) {
    return (this.registers[key] = value)
  }
  public saveRegister (...keys: string[]): [string, any][] {
    return keys.map(key => [key, this.getRegister(key)])
  }
  public restoreRegister (keyValues: [string, any][]) {
    return keyValues.forEach(([key, value]) => this.setRegister(key, value))
  }
  public getAll () {
    return [this.globals, this.environments, ...this.scopes]
      .reduce((ctx, val) => __assign(ctx, val), {})
  }
  /**
   * @deprecated use `_get()` or `getSync()` instead
   */
  public get (paths: PropertyKey[]): unknown {
    return this.getSync(paths)
  }
  public getSync (paths: PropertyKey[]): unknown {
    return toValueSync(this._get(paths))
  }
  public * _get (paths: (PropertyKey | Drop)[]): IterableIterator<unknown> {
    const scope = this.findScope(paths[0] as string) // first prop should always be a string
    return yield this._getFromScope(scope, paths)
  }
  /**
   * @deprecated use `_get()` instead
   */
  public getFromScope (scope: unknown, paths: PropertyKey[] | string): IterableIterator<unknown> {
    return toValueSync(this._getFromScope(scope, paths))
  }
  public * _getFromScope (scope: unknown, paths: (PropertyKey | Drop)[] | string, strictVariables = this.strictVariables): IterableIterator<unknown> {
    if (isString(paths)) paths = paths.split('.')
    for (let i = 0; i < paths.length; i++) {
      scope = yield readProperty(scope as object, paths[i], this.ownPropertyOnly)
      if (strictVariables && isUndefined(scope)) {
        throw new InternalUndefinedVariableError((paths as string[]).slice(0, i + 1).join!('.'))
      }
    }
    return scope
  }
  public push (ctx: object) {
    return this.scopes.push(ctx)
  }
  public pop () {
    return this.scopes.pop()
  }
  public bottom () {
    return this.scopes[0]
  }
  public spawn (scope = {}) {
    return new Context(scope, this.opts, {
      sync: this.sync,
      globals: this.globals,
      strictVariables: this.strictVariables
    }, {
      renderLimit: this.renderLimit,
      memoryLimit: this.memoryLimit
    })
  }
  private findScope (key: string | number) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const candidate = this.scopes[i]
      if (key in candidate) return candidate
    }
    if (key in this.environments) return this.environments
    return this.globals
  }
}

export function readProperty (obj: Scope, key: (PropertyKey | Drop), ownPropertyOnly: boolean) {
  obj = toLiquid(obj)
  key = toValue(key) as PropertyKey
  if (isNil(obj)) return obj
  if (isArray(obj) && (key as number) < 0) return obj[obj.length + +key]
  const value = readJSProperty(obj, key, ownPropertyOnly)
  if (value === undefined && obj instanceof Drop) return obj.liquidMethodMissing(key)
  if (isFunction(value)) return value.call(obj)
  if (key === 'size') return readSize(obj)
  else if (key === 'first') return readFirst(obj)
  else if (key === 'last') return readLast(obj)
  return value
}
export function readJSProperty (obj: Scope, key: PropertyKey, ownPropertyOnly: boolean) {
  if (ownPropertyOnly && !hasOwnProperty.call(obj, key) && !(obj instanceof Drop)) return undefined
  return obj[key]
}

function readFirst (obj: Scope) {
  if (isArray(obj)) return obj[0]
  return obj['first']
}

function readLast (obj: Scope) {
  if (isArray(obj)) return obj[obj.length - 1]
  return obj['last']
}

function readSize (obj: Scope) {
  if (hasOwnProperty.call(obj, 'size') || obj['size'] !== undefined) return obj['size']
  if (isArray(obj) || isString(obj)) return obj.length
  if (typeof obj === 'object') return Object.keys(obj).length
}
