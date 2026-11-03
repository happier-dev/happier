import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { resolveValueRefPlaintextV1, type ValueRefV1 } from '../../valueRefs/valueRefV1.js';
import { McpRemoteUrlV1Schema } from '../remoteUrlV1.js';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryV1 } from './settingsV1.js';

const inputReference = lazyZodSchema(() => z.strictObject({ kind: z.literal('input'), key: z.string().check(z.minLength(1)) }));
const configurableString = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: z.string() }), inputReference,
]));
const inputDeclaration = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)), label: z.string().check(z.minLength(1)),
  purpose: z.string().check(z.minLength(1)), secret: z.boolean(), required: z.boolean(),
}));

/** Closed executable declarations; source values and bindings have no portable representation. */
export const BotTemplateMcpDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  name: McpServerCatalogEntryV1Schema.shape.name,
  description: McpServerCatalogEntryV1Schema.shape.description,
  transport: McpServerCatalogEntryV1Schema.shape.transport,
  stdio: z.optional(z.strictObject({
    command: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('literal'), value: McpServerCatalogEntryV1Schema.shape.stdio._zod.def.innerType.shape.command }), inputReference,
    ]),
    args: z.array(configurableString),
    cwd: z.optional(z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('session') }), inputReference])),
  })),
  remote: z.optional(z.strictObject({
    url: z.strictObject({
      baseUrl: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('literal'), value: McpRemoteUrlV1Schema.check(z.refine(value => {
          try { return new URL(value).search === ''; } catch { return false; }
        }, 'Query values must be declared inputs')) }), inputReference,
      ]),
      username: z.optional(inputReference), password: z.optional(inputReference),
      query: z.array(z.strictObject({ key: configurableString, value: inputReference })),
    }),
    headers: z.record(McpServerCatalogEntryV1Schema.shape.remote._zod.def.innerType.shape.headers._zod.def.keyType, inputReference),
  })),
  auth: McpServerCatalogEntryV1Schema.shape.remote._zod.def.innerType.shape.auth,
  env: z.record(McpServerCatalogEntryV1Schema.shape.env._zod.def.keyType, inputReference),
  inputs: z.array(inputDeclaration),
}).check(z.superRefine((value, ctx) => {
  if (value.transport === 'stdio' ? (!value.stdio || value.remote || value.auth) : (!value.remote || value.stdio)) {
    ctx.addIssue({ code: 'custom', message: 'Configuration must match the declared transport' });
  }
  const declarations = new Set<string>();
  for (const [index, input] of value.inputs.entries()) {
    if (declarations.has(input.key)) ctx.addIssue({ code: 'custom', message: 'Duplicate input key', path: ['inputs', index, 'key'] });
    declarations.add(input.key);
  }
  const references = [
    ...Object.values(value.env), ...Object.values(value.remote?.headers ?? {}),
    ...(value.remote?.url.query.flatMap(parameter => [parameter.key, parameter.value]) ?? []),
    ...[value.remote?.url.baseUrl, value.remote?.url.username, value.remote?.url.password, value.stdio?.command, value.stdio?.cwd],
    ...(value.stdio?.args ?? []),
  ];
  for (const reference of references) {
    if (reference?.kind === 'input' && !declarations.has(reference.key)) {
      ctx.addIssue({ code: 'custom', message: 'Input reference has no declaration' });
    }
  }
})));
export type BotTemplateMcpDefinitionV1 = z.infer<typeof BotTemplateMcpDefinitionV1Schema>;

/** Recipient values stay ValueRefs until the ordinary private MCP launch materializer. */
export function bindBotTemplateMcpDefinitionV1(input: Readonly<{ definition: BotTemplateMcpDefinitionV1;
  inputs: Readonly<Record<string, ValueRefV1>>; id: string; nowMs: number }>): McpServerCatalogEntryV1 {
  const definition = BotTemplateMcpDefinitionV1Schema.parse(input.definition);
  const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  if (Object.keys(input.inputs).some(key => !definition.inputs.some(declaration => declaration.key === key))) return refuse('invalid_request');
  for (const declaration of definition.inputs) {
    const value = input.inputs[declaration.key];
    if (!value && declaration.required) return refuse('missing_values');
    if (declaration.secret && value && (value.t === 'literal' || value.t === 'template'
      && Object.values(value.vars).some(variable => variable.t === 'literal' && variable.v !== ''))) return refuse('invalid_request');
  }
  const value = (reference: { key: string }) => input.inputs[reference.key];
  const literal = (reference: { kind: 'literal'; value: string } | { kind: 'input'; key: string }) => {
    if (reference.kind === 'literal') return reference.value;
    const bound = value(reference);
    if (!bound) return refuse('missing_values');
    const text = resolveValueRefPlaintextV1(bound, () => null);
    return text === null ? refuse('unsupported_entry') : text;
  };
  const env = Object.fromEntries(Object.entries(definition.env).flatMap(([name, ref]) => value(ref) ? [[name, value(ref)!]] : []));
  const base = { id: input.id, name: definition.name, ...(definition.description ? { description: definition.description } : {}),
    transport: definition.transport, env, createdAt: input.nowMs, updatedAt: input.nowMs };
  if (definition.transport === 'stdio') return McpServerCatalogEntryV1Schema.parse({ ...base, stdio: {
    command: literal(definition.stdio!.command), args: definition.stdio!.args.map(literal),
    ...(definition.stdio!.cwd ? { cwd: definition.stdio!.cwd.kind === 'session' ? { t: 'session' } : { t: 'path', path: literal(definition.stdio!.cwd) } } : {}),
  } });
  const remote = definition.remote!;
  const vars: Record<string, Extract<ValueRefV1, { t: 'literal' | 'savedSecret' }>> = {};
  let index = 0;
  const interpolate = (reference: { kind: 'literal'; value: string } | { kind: 'input'; key: string }) => {
    if (reference.kind === 'literal') return reference.value;
    const bound = value(reference);
    if (!bound) return refuse('missing_values');
    if (bound.t === 'sessionAttested') return refuse('unsupported_entry');
    if (bound.t === 'template') return bound.template.replace(/\{([^{}]*)\}/gu, (_match, key: string) => {
      const atom = bound.vars[key];
      if (!atom) return refuse('missing_values');
      const name = `input${index++}`; vars[name] = atom; return `{${name}}`;
    });
    const name = `input${index++}`; vars[name] = bound; return `{${name}}`;
  };
  const safeUrl = remote.url.baseUrl.kind === 'literal' ? remote.url.baseUrl.value
    : input.inputs[remote.url.baseUrl.key]?.t === 'literal' ? literal(remote.url.baseUrl) : 'https://input/';
  let template = interpolate(remote.url.baseUrl);
  if (remote.url.username || remote.url.password) {
    const separator = template.indexOf('://');
    if (separator < 0) return refuse('unsupported_entry');
    const credentials = `${remote.url.username ? interpolate(remote.url.username) : ''}${remote.url.password ? `:${interpolate(remote.url.password)}` : ''}@`;
    template = `${template.slice(0, separator + 3)}${credentials}${template.slice(separator + 3)}`;
  }
  const query = remote.url.query.map(parameter => `${interpolate(parameter.key)}=${interpolate(parameter.value)}`);
  if (query.length) template += `?${query.join('&')}`;
  const headers = Object.fromEntries(Object.entries(remote.headers).flatMap(([name, ref]) => value(ref) ? [[name, value(ref)!]] : []));
  return McpServerCatalogEntryV1Schema.parse({ ...base, remote: { url: safeUrl, headers,
    ...(Object.keys(vars).length ? { urlTemplate: { t: 'template', template, vars } } : {}),
    ...(definition.auth ? { auth: definition.auth } : {}),
  } });
}

/** Declaration-only projection: never resolves source ValueRefs or accesses source credentials. */
export function projectBotTemplateMcpDefinitionV1(source: McpServerCatalogEntryV1): BotTemplateMcpDefinitionV1 {
  const inputs: BotTemplateMcpDefinitionV1['inputs'] = [];
  const input = (key: string, label: string, purpose: string, secret = true) => {
    inputs.push({ key, label, purpose, secret, required: true });
    return { kind: 'input' as const, key };
  };
  const env = Object.fromEntries(Object.keys(source.env).map(key => [key, input(`env:${key}`, key, 'Environment variable')]));
  const common = { name: source.name, ...(source.description ? { description: source.description } : {}), transport: source.transport, env, inputs };
  if (source.transport === 'stdio') {
    const stdio = source.stdio!;
    return { ...common, stdio: {
      command: { kind: 'literal', value: stdio.command },
      args: stdio.args.map(value => ({ kind: 'literal', value })),
      ...(stdio.cwd ? { cwd: stdio.cwd.t === 'session' ? { kind: 'session' as const } : input('cwd', 'Working folder', 'Recipient working folder', false) } : {}),
    } };
  }
  const remote = source.remote!;
  let url = new URL(remote.url);
  let needsRecipientEndpoint = false;
  let alternateQueryKeys: string[] | undefined;
  if (remote.urlTemplate) {
    const template = remote.urlTemplate;
    // Probe only redacted refs through the existing interpolation owner. Different
    // endpoint results mean its host/path must be supplied by the recipient.
    const render = (marker: string) => resolveValueRefPlaintextV1({ ...template,
      vars: Object.fromEntries(Object.keys(template.vars).map(key => [key, { t: 'literal' as const, v: marker }])),
    }, () => null);
    const first = render('happier-input-a');
    const second = render('happier-input-b');
    if (first === null || second === null) throw new Error('Unresolved MCP URL template');
    url = new URL(first);
    const alternate = new URL(second);
    needsRecipientEndpoint = url.protocol !== alternate.protocol || url.origin !== alternate.origin || url.pathname !== alternate.pathname;
    alternateQueryKeys = [...alternate.searchParams.keys()];
  }
  const baseUrl = needsRecipientEndpoint ? input('url:base', 'Remote URL', 'Recipient remote endpoint')
    : { kind: 'literal' as const, value: `${url.origin}${url.pathname}` };
  const username = url.username ? input('url:username', 'URL username', 'Remote URL username') : undefined;
  const password = url.password ? input('url:password', 'URL password', 'Remote URL password') : undefined;
  const query = [...url.searchParams.keys()].map((key, index) => {
    const variableKey = alternateQueryKeys !== undefined && key !== alternateQueryKeys[index];
    const label = variableKey || !key ? `Query parameter ${index + 1}` : key;
    return {
      key: variableKey ? input(`url:query-key:${index}`, label, 'Remote URL query parameter name') : { kind: 'literal' as const, value: key },
      value: input(`url:query:${index}`, label, 'Remote URL query parameter'),
    };
  });
  const headers = Object.fromEntries(Object.keys(remote.headers).map(key => [key, input(`header:${key}`, key, 'HTTP header')]));
  return { ...common, remote: { url: { baseUrl, ...(username ? { username } : {}), ...(password ? { password } : {}), query }, headers },
    ...(remote.auth ? { auth: { kind: remote.auth.kind } } : {}),
  };
}
