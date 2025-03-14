import { Hash, ValueToken, Liquid, Tag, evalToken, Emitter, TagToken, TopLevelToken, Context, Template, ParseStream } from '..'
import { assertEmpty, isValueToken, toEnumerable } from '../util'
import { ForloopDrop } from '../drop/forloop-drop'
import { Parser } from '../parser'
import { Arguments } from '../template'

const MODIFIERS = ['offset', 'limit', 'reversed']

type valueOf<T> = T[keyof T]

export default class extends Tag {
  variable: string
  collection: ValueToken
  hash: Hash
  templates: Template[]
  elseTemplates: Template[]

  constructor (token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remainTokens, liquid)
    const variable = this.tokenizer.readIdentifier()
    const inStr = this.tokenizer.readIdentifier()
    const collection = this.tokenizer.readValue()
    if (!variable.size() || inStr.content !== 'in' || !collection) {
      throw new Error(`illegal tag: ${token.getText()}`)
    }

    this.variable = variable.content
    this.collection = collection
    this.hash = new Hash(this.tokenizer, liquid.options.keyValueSeparator)
    this.templates = []
    this.elseTemplates = []

    let p
    const stream: ParseStream = parser.parseStream(remainTokens)
      .on('start', () => (p = this.templates))
      .on<TagToken>('tag:else', tag => { assertEmpty(tag.args); p = this.elseTemplates })
      .on<TagToken>('tag:endfor', tag => { assertEmpty(tag.args); stream.stop() })
      .on('template', (tpl: Template) => p.push(tpl))
      .on('end', () => { throw new Error(`tag ${token.getText()} not closed`) })

    stream.start()
  }
  * render (ctx: Context, emitter: Emitter): Generator<unknown, void | string, Template[]> {
    const r = this.liquid.renderer
    let collection = toEnumerable(yield evalToken(this.collection, ctx))

    if (!collection.length) {
      yield r.renderTemplates(this.elseTemplates, ctx, emitter)
      return
    }

    const continueKey = 'continue-' + this.variable + '-' + this.collection.getText()
    ctx.push({ continue: ctx.getRegister(continueKey) })
    const hash = yield this.hash.render(ctx)
    ctx.pop()

    const modifiers = this.liquid.options.orderedFilterParameters
      ? Object.keys(hash).filter(x => MODIFIERS.includes(x))
      : MODIFIERS.filter(x => hash[x] !== undefined)

    collection = modifiers.reduce((collection, modifier: valueOf<typeof MODIFIERS>) => {
      if (modifier === 'offset') return offset(collection, hash['offset'])
      if (modifier === 'limit') return limit(collection, hash['limit'])
      return reversed(collection)
    }, collection)

    ctx.setRegister(continueKey, (hash['offset'] || 0) + collection.length)
    const scope = { forloop: new ForloopDrop(collection.length, this.collection.getText(), this.variable) }
    ctx.push(scope)
    for (const item of collection) {
      scope[this.variable] = item
      ctx.continueCalled = ctx.breakCalled = false
      yield r.renderTemplates(this.templates, ctx, emitter)
      if (ctx.breakCalled) break
      scope.forloop.next()
    }
    ctx.continueCalled = ctx.breakCalled = false
    ctx.pop()
  }

  public * children (): Generator<unknown, Template[]> {
    const templates = this.templates.slice()
    if (this.elseTemplates) {
      templates.push(...this.elseTemplates)
    }
    return templates
  }

  public * arguments (): Arguments {
    yield this.collection

    for (const v of Object.values(this.hash.hash)) {
      if (isValueToken(v)) {
        yield v
      }
    }
  }

  public blockScope (): Iterable<string> {
    return [this.variable, 'forloop']
  }
}

function reversed<T> (arr: Array<T>) {
  return [...arr].reverse()
}

function offset<T> (arr: Array<T>, count: number) {
  return arr.slice(count)
}

function limit<T> (arr: Array<T>, count: number) {
  return arr.slice(0, count)
}
