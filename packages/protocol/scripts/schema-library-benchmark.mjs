// Development-only experiment. No repository dependencies or source are rewritten.
// Run through hstack-exec: node --expose-gc .../schema-library-benchmark.mjs
import { createRequire, stripTypeScriptTypes, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createExternalScratch } from './schemaLibraryScratch.mjs';

const repo = process.cwd();
const req = createRequire(new URL('../package.json', import.meta.url));
const childMode = process.argv[2] === 'child';
const specs = ['valibot@1.5.0', '@valibot/to-json-schema@1.8.0', 'arktype@2.2.7', 'typebox@1.3.35'];
if (process.argv[2] === 'post-slice') {
  console.log(JSON.stringify({event:'post-slice-basis',host:hostname(),node:process.version}));
  const tasks = [
    ['scratch-guard',['--test','packages/protocol/scripts/schemaLibraryScratch.test.mjs']],
    ['slice-typecheck',['packages/protocol/scripts/schema-library-census-codemod.mjs','slice-typecheck','packages/protocol/src/plugins/actions/internalProtocolZodAdapter.ts','packages/protocol/src/plugins/actions/internalProtocolZodAdapter.test.ts']],
    ['protocol-root',['--experimental-transform-types','--expose-gc','packages/protocol/scripts/schema-library-benchmark.mjs','bridge-census']],
    ['browser-protocol-contribution',['packages/protocol/scripts/profile-schema-browser-bundle.mjs']],
    ['cold-daemon',['../../node_modules/vitest/vitest.mjs','run','src/ui/auth.lazyRenderer.test.ts','--config','../../packages/protocol/scripts/daemon-schema-memory.config.ts','--maxWorkers=1'],resolve(repo,'apps/cli')],
  ];
  for (const [task,args,cwd] of tasks) {
    console.log(JSON.stringify({event:'start',task,args,cwd:cwd ?? repo}));
    const result = spawnSync(process.execPath,args,{cwd:cwd ?? repo,stdio:'inherit'});
    console.log(JSON.stringify({event:'result',task,status:result.status,signal:result.signal,error:result.error?.message}));
    if (result.status !== 0) process.exitCode = 1;
  }
} else if (process.argv[2] === 'bridge-census') {
  // Observe repeated admission of the same immutable neutral definition, not
  // equality of JSON projections (different parsers may have the same shape).
  const counts = new WeakMap(); let calls = 0; let unique = 0;
  globalThis.__schemaLibraryBridgeObserve = schema => {
    calls++;
    if (!counts.has(schema)) unique++;
    counts.set(schema,(counts.get(schema) ?? 0) + 1);
  };
  registerHooks({load(url,context,nextLoad) {
    const result = nextLoad(url,context);
    if (!url.endsWith('/packages/protocol/src/plugins/actions/internalProtocolZodAdapter.ts')) return result;
    const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
    const anchor = '): z.ZodType<TOutput, TInput> {';
    assert.ok(source.includes(anchor),'bridge observation anchor');
    return {...result,source:source.replace(anchor,anchor+'\n  globalThis.__schemaLibraryBridgeObserve(schema);')};
  }});
  process.argv[2] = 'protocol'; process.argv.push('--native');
  await import('./profile-schema-memory.mjs');
  console.log(JSON.stringify({event:'bridge-census',host:hostname(),node:process.version,calls,unique,repeated:calls-unique}));
} else if (!childMode) {
  const scratch = createExternalScratch(repo, 'happier-schema-libs-');
  const install = spawnSync('npm', ['install', '--prefix', scratch, '--ignore-scripts', '--no-audit', '--no-fund', ...specs], { encoding: 'utf8' });
  if (install.status !== 0) { process.stderr.write(install.stderr + install.stdout); process.exit(install.status ?? 1); }
  console.log(JSON.stringify({ event: 'basis', host: hostname(), node: process.version, scratch, specs }));
  const contractsOnly = process.argv[2] === 'contracts';
  for (let repetition = 0; repetition < (contractsOnly ? 1 : 3); repetition++) {
    for (const library of (process.argv[2] && !contractsOnly ? process.argv[2].split(',') : ['classic', 'mini', 'mini-collapsed', 'core', 'valibot', 'arktype', 'typebox'])) {
      for (let family = 0; family < 4; family++) {
      const run = spawnSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname, 'child', library, scratch, String(repetition), String(family), ...(contractsOnly ? ['contracts'] : [])], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      process.stdout.write(run.stdout); process.stderr.write(run.stderr);
      if (run.status !== 0) process.exitCode = 1;
      }
    }
  }
} else {
  const library = process.argv[3];
  const scratchReq = createRequire(resolve(process.argv[4], 'package.json'));
  const load = async (name, local = false) => import(pathToFileURL((local ? req : scratchReq).resolve(name)).href);
  const c = await load('zod', true);
  const m = await load('zod/mini', true);
  const core = await load('zod/v4/core', true);
  // Explicit locale is necessary when mini is the only loaded Zod flavor.
  core.config((await load('zod/locales', true)).en());
  const v = library === 'valibot' ? await load('valibot') : null;
  const a = library === 'arktype' ? await load('arktype') : null;
  const t = library === 'typebox' ? (await load('typebox')).default : null;
  const tv = library === 'typebox' ? await load('typebox/value') : null;
  const vjson = library === 'valibot' ? await load('@valibot/to-json-schema') : null;

  // Capture real source factories as a small expression graph. Callbacks and
  // constraints come from current source, not reconstructed DTO examples.
  class Expr {
    constructor(kind, args) { this.kind = kind; this.args = args; }
  }
  const methods = ['strict', 'strip', 'passthrough', 'min', 'max', 'trim', 'int', 'nonnegative', 'positive', 'finite', 'optional', 'nullable', 'default', 'catch', 'refine', 'superRefine', 'transform', 'extend'];
  for (const method of methods) Expr.prototype[method] = function (...args) { return new Expr(method, [this, ...args]); };
  const capture = Object.fromEntries(['string', 'number', 'boolean', 'literal', 'enum', 'object', 'array', 'union', 'discriminatedUnion', 'preprocess'].map(kind => [kind, (...args) => new Expr(kind, args)]));
  capture.ZodIssueCode = { custom: 'custom' };
  const text = path => readFileSync(resolve(repo, 'packages/protocol/src', path), 'utf8');
  const ts = req('typescript');
  function expression(path, name) {
    const source = ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true);
    let result;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) result = node.initializer.getText(source);
      ts.forEachChild(node, visit);
    }
    visit(source); assert.ok(result, name); return result;
  }
  function evaluate(source, z) {
    const factory = stripTypeScriptTypes(`(function(z, lazyZodSchema) { ${source} })`, { mode: 'transform' });
    return new Function(`return ${factory}`)()(z, fn => fn());
  }
  const browserSource = `return [${expression('actions/specs/browser.ts', 'BrowserSandboxInstallInputV1Schema')}, ${expression('actions/specs/browser.ts', 'BrowserSandboxInstallResultV1Schema')}];`;
  const settingsText = text('account/settings/accountSettings.ts');
  const settingsStart = settingsText.indexOf('const SESSION_HANDOFF_DEFAULT_KEYS');
  const settingsEnd = settingsText.indexOf('export type SessionHandoffDefaultsV1');
  // Account bounded-string admission uses its canonical helper, extracted below.
  const settingsPrefix = settingsText.slice(settingsStart, settingsEnd).replaceAll('export const', 'const');
  const helperAst = ts.createSourceFile('accountSettings.ts', settingsText, ts.ScriptTarget.Latest, true);
  const helper = helperAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'accountBoundedString');
  assert.ok(helper, 'bounded string function');
  const boundedHelper = helper.getText(helperAst).replace(/^export\s+/, '');
  const settingsSource = `${boundedHelper}\n${settingsPrefix}\nreturn [SessionHandoffDefaultsV1Schema];`;
  const terminalText = text('sessions/metadata/terminalMetadata.ts');
  const terminalSource = `const WINDOWS_REMOTE_SESSION_LAUNCH_MODES = ['hidden','windows_terminal','console'];\n${terminalText.slice(terminalText.indexOf("type TerminalMetadataContext"), terminalText.indexOf('export const SessionTerminalMetadataSchema')).replaceAll('export ', '')}\nreturn [createSessionTerminalMetadataSchema(z, 'owner')];`;
  const windowText = text('sessions/metadata/windowsTerminalWindowName.ts').replace(/import[^\n]+\n/, '').replaceAll('export ', '');
  const windowSource = `${windowText}\nreturn [WindowsTerminalWindowNameSchema];`;
  const sources = [browserSource, settingsSource, terminalSource, windowSource];
  const graphs = sources.map(source => evaluate(source, capture));
  const baseline = sources.map(source => evaluate(source, c));

  function zodBuild(node, flavor) {
    const z = flavor === 'classic' ? c : m;
    const { kind: k, args: xs } = node;
    const sub = x => zodBuild(x, flavor);
    if (k === 'object') return z.object(Object.fromEntries(Object.entries(xs[0]).map(([key, child]) => [key, sub(child)])));
    if (k === 'union') return z.union(xs[0].map(sub));
    if (k === 'discriminatedUnion') return z.discriminatedUnion(xs[0], xs[1].map(sub));
    if (k === 'preprocess') return flavor === 'classic' ? z.preprocess(xs[0], sub(xs[1])) : z.pipe(z.transform(xs[0]), sub(xs[1]));
    if (['string','number','boolean','literal','enum'].includes(k)) return z[k](...xs);
    if (k === 'array') return z.array(sub(xs[0]));
    if (flavor === 'mini-collapsed' && ['min','max','trim','int','finite','refine','superRefine'].includes(k)) {
      const constraints = []; let next = node;
      while (['min','max','trim','int','finite','refine','superRefine'].includes(next.kind)) {
        constraints.unshift(next); next = next.args[0];
      }
      const base = sub(next);
      const checks = constraints.filter(item => item.kind !== 'finite').map(item => {
        const name = item.kind === 'min' ? (base._zod.def.type === 'number' ? 'minimum' : 'minLength') : item.kind === 'max' ? (base._zod.def.type === 'number' ? 'maximum' : 'maxLength') : item.kind;
        return z[name](...item.args.slice(1));
      });
      return checks.length ? base.check(...checks) : base;
    }
    const base = sub(xs[0]); const tail = xs.slice(1);
    if (k === 'extend') {
      const shape = Object.fromEntries(Object.entries(tail[0]).map(([key, child]) => [key, sub(child)]));
      return flavor === 'classic' ? base.extend(shape) : z.extend(base, shape);
    }
    if (flavor === 'classic') return base[k](...tail);
    if (['strict','strip','passthrough'].includes(k)) return k === 'strict' ? z.strictObject(base.shape) : k === 'passthrough' ? z.looseObject(base.shape) : z.object(base.shape);
    if (k === 'extend') return z.extend(base, Object.fromEntries(Object.entries(tail[0]).map(([key, child]) => [key, sub(child)])));
    if (['optional','nullable','default','catch'].includes(k)) return z[k === 'default' ? '_default' : k](base, ...tail);
    if (k === 'transform') return z.pipe(base, z.transform(tail[0]));
    if (k === 'refine' || k === 'superRefine') return base.check(z[k](...tail));
    if (k === 'min' || k === 'max') return base.check((base._zod.def.type === 'number' ? (k === 'min' ? z.minimum : z.maximum) : (k === 'min' ? z.minLength : z.maxLength))(...tail));
    if (k === 'int') return base.check(z.int());
    if (k === 'finite') return base; // Zod4 number rejects infinities without a check.
    return base.check(z[k](...tail));
  }
  // Core construction translates definition data/checks, not classic schemas.
  // Mini temporary objects are discarded. Construction includes this cost;
  // retained core families contain no mini schema instances.
  const coreClasses = { string: '$ZodString', number: '$ZodNumber', boolean: '$ZodBoolean', literal: '$ZodLiteral', enum: '$ZodEnum', object: '$ZodObject', union: '$ZodUnion', array: '$ZodArray', optional: '$ZodOptional', nullable: '$ZodNullable', default: '$ZodDefault', catch: '$ZodCatch', transform: '$ZodTransform', pipe: '$ZodPipe', never: '$ZodNever', unknown: '$ZodUnknown' };
  function lowerCore(schema) {
    const def = { ...schema._zod.def };
    for (const key of ['innerType', 'in', 'out', 'element', 'catchall']) if (def[key]?._zod) def[key] = lowerCore(def[key]);
    if (def.shape) def.shape = Object.fromEntries(Object.entries(def.shape).map(([key, child]) => [key, lowerCore(child)]));
    if (def.options) def.options = def.options.map(lowerCore);
    const name = def.type === 'union' && def.discriminator ? '$ZodDiscriminatedUnion' : coreClasses[def.type];
    assert.ok(name, `core ${def.type}`); return new core[name](def);
  }
  function valibotBuild(node) {
    const { kind: k, args: xs } = node; const sub = valibotBuild;
    if (['string','number','boolean','literal'].includes(k)) return v[k](...xs);
    if (k === 'enum') return v.picklist(xs[0]);
    if (k === 'object') return v.object(Object.fromEntries(Object.entries(xs[0]).map(([key, child]) => [key, sub(child)])));
    if (k === 'array') return v.array(sub(xs[0]));
    if (k === 'union') return v.union(xs[0].map(sub));
    if (k === 'discriminatedUnion') return v.variant(xs[0], xs[1].map(sub));
    if (k === 'preprocess') return v.pipe(v.unknown(), v.transform(xs[0]), sub(xs[1]));
    const base = sub(xs[0]); const tail = xs.slice(1);
    if (['strict','strip','passthrough'].includes(k)) return v[k === 'strict' ? 'strictObject' : k === 'passthrough' ? 'looseObject' : 'object'](base.entries);
    if (k === 'extend') return v.object({ ...base.entries, ...Object.fromEntries(Object.entries(tail[0]).map(([key, child]) => [key, sub(child)])) });
    if (k === 'optional' || k === 'nullable') return v[k](base);
    if (k === 'default') return v.optional(base, tail[0]);
    if (k === 'catch') return v.fallback(base, tail[0]);
    if (k === 'transform') return v.pipe(base, v.transform(tail[0]));
    if (k === 'refine') return v.pipe(base, v.check(tail[0], tail[1]?.message));
    if (k === 'superRefine') return v.pipe(base, v.rawCheck(({ dataset, addIssue }) => {
      if (!dataset.typed) return;
      tail[0](dataset.value, { addIssue: issue => addIssue({ message: issue.message, ...(issue.path ? { path: issue.path.map(key => ({ type: 'object', origin: 'value', input: dataset.value, key, value: dataset.value?.[key] })) } : {}) }) });
    }));
    if (k === 'trim') return v.pipe(base, v.trim());
    if (k === 'min' || k === 'max') {
      const numeric = (() => { let n = xs[0]; while (n.args[0] instanceof Expr) n = n.args[0]; return n.kind === 'number'; })();
      return v.pipe(base, v[numeric ? (k === 'min' ? 'minValue' : 'maxValue') : (k === 'min' ? 'minLength' : 'maxLength')](...tail));
    }
    if (k === 'int') return v.pipe(base, v.integer());
    if (k === 'nonnegative') return v.pipe(base, v.minValue(0));
    if (k === 'positive') return v.pipe(base, v.check(value => value > 0));
    if (k === 'finite') return v.pipe(base, v.finite());
    throw new Error(`valibot unsupported ${k}`);
  }
  function arktypeBuild(node) {
    const { kind: k, args: xs } = node; const sub = arktypeBuild;
    if (['string','number','boolean'].includes(k)) return a.type(k);
    if (k === 'literal') return a.type.unit(xs[0]);
    if (k === 'enum') return a.type.enumerated(...xs[0]);
    if (k === 'object') return a.type(Object.fromEntries(Object.entries(xs[0]).map(([key, child]) => [key, sub(child)])));
    if (k === 'array') return sub(xs[0]).array();
    if (k === 'union') return xs[0].map(sub).reduce((left, right) => left.or(right));
    if (k === 'discriminatedUnion') return xs[1].map(sub).reduce((left, right) => left.or(right));
    if (k === 'preprocess') return a.type('unknown').pipe(xs[0]).pipe(sub(xs[1]));
    const base = sub(xs[0]); const tail = xs.slice(1);
    if (['strict','strip','passthrough'].includes(k)) return base.onUndeclaredKey(k === 'strict' ? 'reject' : k === 'strip' ? 'delete' : 'ignore');
    if (k === 'extend') return base.merge(Object.fromEntries(Object.entries(tail[0]).map(([key, child]) => [key, sub(child)])));
    if (k === 'optional') return base.optional();
    if (k === 'nullable') return base.or('null');
    if (k === 'default') return base.default(tail[0] && typeof tail[0] === 'object' ? () => structuredClone(tail[0]) : tail[0]);
    if (k === 'transform' || k === 'trim') return base.pipe(k === 'trim' ? value => value.trim() : tail[0]);
    if (k === 'refine' || k === 'superRefine') return base.narrow((value, ctx) => {
      const issues = [];
      if (k === 'superRefine') tail[0](value, { addIssue: issue => issues.push(issue) });
      else if (!tail[0](value)) issues.push({ message: tail[1]?.message, path: tail[1]?.path });
      for (const issue of issues) ctx.reject({ expected: issue.message, relativePath: issue.path });
      return issues.length === 0;
    });
    if (k === 'min' || k === 'max') {
      let n = xs[0]; while (n.args[0] instanceof Expr) n = n.args[0];
      // ArkType constraints after a morph require a pipe; narrow preserves trim-first order.
      return base.narrow(value => (n.kind === 'number' ? value : value.length) >= (k === 'min' ? tail[0] : -Infinity) && (n.kind === 'number' ? value : value.length) <= (k === 'max' ? tail[0] : Infinity));
    }
    if (k === 'int') return base.and('number.integer');
    if (k === 'finite') return base.narrow(Number.isFinite);
    throw new Error(`arktype unsupported ${k}`);
  }
  // TypeBox lacks a native general refinement/morph schema. An experiment-only
  // derived wrapper executes captured callbacks and reports its separate cost.
  // It is deliberately not a proposed second production parser.
  function typeboxBuild(node) {
    const { kind: k, args: xs } = node; const sub = typeboxBuild;
    const simple = { string: 'String', number: 'Number', boolean: 'Boolean', literal: 'Literal' };
    if (simple[k]) return { schema: t[simple[k]](...xs), normalize: value => value };
    if (k === 'enum') return { schema: t.Union(xs[0].map(value => t.Literal(value))), normalize: value => value };
    if (k === 'object') {
      const children = Object.fromEntries(Object.entries(xs[0]).map(([key, child]) => [key, sub(child)]));
      return { schema: t.Object(Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.schema]))), normalize(value) {
        const output = {}; for (const [key, child] of Object.entries(children)) { const normalized = child.normalize(value[key]); if (normalized !== undefined || Object.hasOwn(value, key)) output[key] = normalized; } return output;
      }, children, policy: 'strip' };
    }
    if (k === 'array') { const child = sub(xs[0]); return { schema: t.Array(child.schema), normalize: value => value.map(child.normalize) }; }
    if (k === 'union' || k === 'discriminatedUnion') {
      const children = (k === 'union' ? xs[0] : xs[1]).map(sub);
      return { schema: t.Union(children.map(child => child.schema)), normalize: value => children.find(child => tv.Check(child.schema, value))?.normalize(value) ?? value };
    }
    if (k === 'preprocess') { const base = sub(xs[1]); return { ...base, preprocess: xs[0] }; }
    const base = sub(xs[0]); const tail = xs.slice(1);
    if (k === 'optional') return { ...base, schema: t.Optional(base.schema), normalize: value => value === undefined ? undefined : base.normalize(value) };
    if (k === 'nullable') return { schema: t.Union([base.schema, t.Null()]), normalize: value => value === null ? null : base.normalize(value) };
    if (k === 'default') return { ...base, schema: t.Optional({ ...base.schema, default: tail[0] }), normalize: value => value === undefined ? structuredClone(tail[0]) : base.normalize(value) };
    if (k === 'strict' || k === 'strip' || k === 'passthrough') return { ...base, schema: { ...base.schema, additionalProperties: k === 'strict' ? false : true }, normalize: value => k === 'passthrough' ? { ...value, ...base.normalize(value) } : base.normalize(value) };
    if (k === 'extend') {
      let object = xs[0]; while (object.kind !== 'object') object = object.args[0];
      return typeboxBuild(new Expr('object', [{ ...object.args[0], ...tail[0] }]));
    }
    if (k === 'min' || k === 'max') return { ...base, schema: { ...base.schema, [base.schema.type === 'number' || base.schema.type === 'integer' ? (k === 'min' ? 'minimum' : 'maximum') : base.schema.type === 'array' ? (k === 'min' ? 'minItems' : 'maxItems') : (k === 'min' ? 'minLength' : 'maxLength')]: tail[0] } };
    if (k === 'int') return { ...base, schema: { ...base.schema, type: 'integer' } };
    if (k === 'finite') return base;
    if (k === 'trim' || k === 'transform') return { ...base, normalize: value => (k === 'trim' ? value => value.trim() : tail[0])(base.normalize(value)) };
    if (k === 'superRefine' || k === 'refine') return { ...base, normalize(input) {
      const value = base.normalize(input);
      const issues = []; if (k === 'superRefine') tail[0](value, { addIssue: issue => issues.push(issue) });
      else if (!tail[0](value)) issues.push({ code: 'custom', ...tail[1] });
      if (issues.length) throw { issues };
      return value;
    } };
    throw new Error(`typebox unsupported ${k}`);
  }
  const build = graph => library === 'classic' || library.startsWith('mini') ? zodBuild(graph, library) : library === 'core' ? lowerCore(zodBuild(graph, 'mini')) : library === 'valibot' ? valibotBuild(graph) : library === 'arktype' ? arktypeBuild(graph) : typeboxBuild(graph);
  const parse = (schema, input) => {
    if (library === 'classic' || library.startsWith('mini')) return schema.parse(input);
    if (library === 'core') return core.parse(schema, input);
    if (library === 'valibot') return v.parse(schema, input);
    if (library === 'arktype') { const result = schema(input); if (result instanceof a.ArkErrors) throw result; return result; }
    const value = schema.preprocess ? schema.preprocess(input) : input;
    tv.Assert(schema.schema, value); const output = schema.normalize(value); schema.refinement?.(output); return output;
  };
  const names = ['action-browser-sandbox-install', 'account-session-handoff-defaults', 'metadata-owner-terminal', 'metadata-windows-window-transform'];
  const cases = [
    [[{ machineId: ' machine ' }, { machineId: '' }, { machineId: 'm', extra: true }], [{ status: 'installed' }, { status: 'failed', code: 'cancelled' }, { status: 'failed', code: 'wrong' }]],
    [[{}, { v: 1, ignoredIncludeGlobs: [' src/** '], workspaceSyncRelationshipId: 'legacy' }, { ignoredIncludeGlobs: ['/etc/**'] }, { token: 'secret' }, { ignoredIncludeGlobs: ['é'.repeat(300)] }]],
    [[{ mode: 'plain' }, { mode: 'plain', hostKind: 'herdr', requested: 'plain', requestedHostKind: 'herdr' }, {}, { controlServiceabilityV1: { v: 1, state: 'unknown', observedAt: 1, retired: true } }, { mode: 'plain', unexpected: 1 }]],
    [['  last  ', ' NEW ', ' work ', 7]],
  ];
  function outcome(parseValue) { try { return { success: true, data: parseValue() }; } catch (error) { return { success: false, issues: error.issues ?? error }; } }
  function issuesOf(result) {
    if (result.success) return [];
    if (library === 'arktype') return Array.from(result.issues, issue => ({ path: Array.from(issue.path), code: issue.code, message: issue.message }));
    if (library === 'typebox' && !Array.isArray(result.issues)) return [{ message: result.issues.message }];
    if (!Array.isArray(result.issues)) return [{ harnessError: String(result.issues), stack: result.issues.stack }];
    return result.issues.map(issue => ({ path: library === 'valibot' ? issue.path?.map(item => item.key) ?? [] : issue.path, code: issue.code ?? issue.type, message: issue.message }));
  }
  for (let f = 0; f < graphs.length; f++) {
    if (process.argv[6] !== undefined && f !== Number(process.argv[6])) continue;
    const make = () => graphs[f].map(build);
    const first = make();
    const semantics = cases[f].flatMap((inputs, schemaIndex) => inputs.map(input => {
      const expected = outcome(() => baseline[f][schemaIndex].parse(input));
      const actual = outcome(() => parse(first[schemaIndex], input));
      const equivalent = expected.success === actual.success && (!expected.success || JSON.stringify(expected.data) === JSON.stringify(actual.data));
      const expectedIssues = expected.success ? [] : expected.issues.map(({ path, code, message }) => ({ path, code, message }));
      return { input, equivalent, expected, actual: actual.success ? actual : { success: false, issues: issuesOf(actual) }, exactIssueShape: JSON.stringify(expectedIssues) === JSON.stringify(issuesOf(actual)), fullIssueShape: JSON.stringify(expected.issues ?? []) === JSON.stringify(actual.issues ?? []) };
    }));
    const jsonSchemas = first.map((schema, index) => {
      try {
        const json = library === 'classic' || library.startsWith('mini') ? (library === 'classic' ? c : m).toJSONSchema(schema, { target: 'draft-7' }) : library === 'core' ? core.toJSONSchema(schema, { target: 'draft-7' }) : library === 'valibot' ? vjson.toJsonSchema(schema, { target: 'draft-07' }) : library === 'arktype' ? schema.toJsonSchema() : schema.schema;
        let expected; try { expected = c.toJSONSchema(baseline[f][index], { target: 'draft-7' }); } catch (error) { expected = { error: error.message }; }
        return { success: true, json: JSON.parse(JSON.stringify(json)), expected };
      } catch (error) {
        if (library === 'valibot' && f === 0) {
          try {
            const json = vjson.toJsonSchema(schema, { target:'draft-07',ignoreActions:['trim'] });
            return { success:false,error:error.message,trimOnlyOverride:{ success:true,json,expected:c.toJSONSchema(baseline[f][index],{target:'draft-7'}) } };
          } catch (overrideError) { return { success:false,error:error.message,trimOnlyOverride:{success:false,error:overrideError.message} }; }
        }
        return { success: false, error: error.message };
      }
    });
    const canonicalInputJsonSchemas = first.map((schema,index) => {
      const options = { io:'input', target:'draft-2020-12', unrepresentable:'throw' };
      let expected;
      try { expected = { success:true,json:JSON.parse(JSON.stringify(c.toJSONSchema(baseline[f][index],options))) }; }
      catch(error) { expected = { success:false,error:error.message }; }
      try {
        const json = library === 'classic' || library.startsWith('mini') ? (library === 'classic' ? c : m).toJSONSchema(schema,options)
          : library === 'core' ? core.toJSONSchema(schema,options)
          : library === 'valibot' ? vjson.toJsonSchema(schema,{typeMode:'input',target:'draft-2020-12'})
          : library === 'arktype' ? schema.toJsonSchema() : schema.schema;
        const actual = {success:true,json:JSON.parse(JSON.stringify(json))};
        return {actual,expected,exact:JSON.stringify(actual)===JSON.stringify(expected)};
      } catch(error) { const actual = {success:false,error:error.message}; return {actual,expected,exact:JSON.stringify(actual)===JSON.stringify(expected)}; }
    });
    if (process.argv[7] === 'contracts') {
      console.log(JSON.stringify({library,family:names[f],semantics,canonicalInputJsonSchemas}));
      continue;
    }
    for (let warm = 0; warm < 20; warm++) make();
    global.gc(); const before = process.memoryUsage().heapUsed;
    const start = performance.now(); const families = Array.from({ length: 1200 }, make); const constructMs = performance.now() - start;
    await new Promise(done => setImmediate(done)); global.gc(); const after = process.memoryUsage().heapUsed;
    const inputs = cases[f].map(row => row[0]);
    for (let i = 0; i < 2000; i++) first.forEach((schema, index) => parse(schema, inputs[index]));
    const parseStart = performance.now();
    for (let i = 0; i < 20000; i++) first.forEach((schema, index) => parse(schema, inputs[index]));
    console.log(JSON.stringify({ library, repetition: Number(process.argv[5]), family: names[f], heapBytesPerFamily: (after - before) / families.length, constructionUsPerFamily: constructMs * 1000 / families.length, parseUsPerFamily: (performance.now() - parseStart) * 1000 / 20000, families: families.length, parses: 20000, semantics, jsonSchemas, retained: families.length, versions: { zod: req('zod/package.json').version } }));
  }
}
