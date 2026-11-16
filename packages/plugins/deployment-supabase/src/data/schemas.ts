import { DeploymentTargetPreparationBaseV1ProtocolSchema, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import type { DeploymentTargetPreparationBaseV1, JsonValue } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion,
  DeploymentDataParentBranchRefV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginJsonSchema, ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const string = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;
export const passwordSchema = defineProtocolObject({ ref: string, resourceRevision: defineProtocolNumber() }, closed);
const secretLabel = defineProtocolObject({ label: string }, closed);
const connectionRef = passwordSchema;
export const audienceSchema = defineProtocolObject({ accountGrants: defineProtocolArray(string).optional(), teamGrants: defineProtocolArray(string).optional(), groupGrants: defineProtocolArray(string).optional() }, closed);
export const selectionSchema = defineProtocolObject({ type: defineProtocolUnion([defineProtocolLiteral('specific'), defineProtocolLiteral('smartGroup')]), code: string }, closed);
export const resourceSchema = defineProtocolObject({ projectRef: string, branchRef: string, database: string }, closed);
export const connectionsSchema = defineProtocolObject({ DATABASE_URL: connectionRef.optional(), DIRECT_URL: connectionRef.optional() }, closed);
const previousSchema = defineProtocolObject({ status: defineProtocolUnion([defineProtocolLiteral('partial'), defineProtocolLiteral('complete')]), resource: resourceSchema,
  connections: connectionsSchema, incomplete: defineProtocolArray(string), modes: defineProtocolObject({ DATABASE_URL: string, DIRECT_URL: string }, closed), code: string.optional() }, closed);
export const operands = {
  'projects-list': defineProtocolObject({}, closed),
  'provision-options': defineProtocolObject({ desiredInstanceSize: string.optional(), continent: string.optional() }, closed),
  'projects-provision': defineProtocolObject({ name: string, password: passwordSchema, regionSelection: selectionSchema,
    desiredInstanceSize: string.optional() }, closed),
  'projects-link': defineProtocolObject({ projectRef: string }, closed),
  'projects-delete': defineProtocolObject({}, closed),
  'projects-observe': defineProtocolObject({}, closed),
  'branches-list': defineProtocolObject({}, closed),
  'branches-create': defineProtocolObject({ name: string, gitBranch: string.optional(), withData: defineProtocolLiteral(false),
    parentBranchRef: DeploymentDataParentBranchRefV1ProtocolSchema.optional() }, closed),
  'branches-delete': defineProtocolObject({}, closed),
  'connections-save': defineProtocolObject({ id: defineProtocolLiteral('database'), purpose: defineProtocolLiteral('data.connection'), audience: audienceSchema,
    password: passwordSchema.optional(), database: string.optional(),
    secrets: defineProtocolObject({ DATABASE_URL: secretLabel, DIRECT_URL: secretLabel }, closed), previous: previousSchema.optional() }, closed),
};
export type Operation = keyof typeof operands;
export type Scope = DeploymentTargetPreparationBaseV1;
export type Operands<K extends Operation> = ProtocolSchemaOutput<(typeof operands)[K]>;
const selected = new Set<Operation>(['branches-list', 'branches-create', 'branches-delete', 'connections-save']);

/** Compose the public common input contract with strict provider operands. */
export function actionSchema(operation: Operation): PluginJsonSchema {
  const base = operation === 'branches-list' ? DeploymentTargetRoleInputProtocolSchemasV1['branches.list']
    : operation === 'projects-delete' ? DeploymentTargetRoleInputProtocolSchemasV1['projects.delete']
    : operation === 'projects-observe' ? DeploymentTargetRoleInputProtocolSchemasV1['projects.observe']
    : selected.has(operation) ? DeploymentTargetRoleInputProtocolSchemasV1['branches.create']
      : DeploymentTargetPreparationBaseV1ProtocolSchema;
  const product = operands[operation];
  return { ...base.jsonSchema,
    // Selected roles strengthen custody without dropping preparation operands.
    properties: { ...product.jsonSchema.properties,
      ...DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties, ...base.jsonSchema.properties },
    required: [...new Set([...(base.jsonSchema.required ?? []), ...(product.jsonSchema.required ?? [])])], additionalProperties: false };
}

export function parseInput<K extends Operation>(operation: K, value: JsonValue): Scope & Operands<K> {
    const product = operands[operation];
    // Account dispatch already admitted the closed Action schema. Scope and
    // custody stay with that host owner; only product operands need projection.
    const source = value as Record<string, unknown>;
    const productInput: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (Object.hasOwn(product.jsonSchema.properties ?? {}, key)) productInput[key] = entry;
    }
    const parsed = product.parse(productInput);
    return { ...source, ...parsed } as Scope & Operands<K>;
}

const s: PluginJsonSchema = { type: 'string' };
const b: PluginJsonSchema = { type: 'boolean' };
const literal = (value: string): PluginJsonSchema => ({ type: 'string', const: value });
const array = (items: PluginJsonSchema): PluginJsonSchema => ({ type: 'array', items });
const resultObject = (properties: Record<string, PluginJsonSchema>, optional: string[] = []): PluginJsonSchema => ({ type: 'object', properties,
  required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
const projectResult = resultObject({ ref: s, organizationSlug: s, name: s, status: s, region: s, version: s }, ['region', 'version']);
const branchResult = resultObject({ branchId: s, projectRef: s, parentProjectRef: s, name: s, persistent: b, gitBranch: s, status: s }, ['gitBranch', 'status']);
const identityResult = resultObject({ providerAccountId: s, providerResourceId: s, providerEnvironment: s });
const environmentResult = resultObject({ kind: literal('custom'), id: s });
const nativeResult = resultObject({ state: literal('provisioned'), ready: b, engine: literal('postgres'), status: s, version: s,
  providerResourceOrigin: literal('created'),
  providerIdentity: identityResult, providerEnvironment: environmentResult, providerConsole: resultObject({ url: s, label: s }) }, ['version', 'providerResourceOrigin']);
const unknownProject = resultObject({ status: literal('outcome_unknown'), organizationSlug: s, recovery: s, code: s, projectRef: s }, ['code', 'projectRef']);
const unavailable = resultObject({ status: literal('unavailable'), code: s });
const resourceResult = resourceSchema.jsonSchema;
const connectionResults = connectionsSchema.jsonSchema;
const modesResult = resultObject({ DATABASE_URL: s, DIRECT_URL: s });
const pairResult = resultObject({ status: { type: 'string', enum: ['complete', 'partial'] }, resource: resourceResult, connections: connectionResults,
  incomplete: array(s), modes: modesResult, code: s }, ['code']);

/** Closed product results keep vendor credential/error echoes out of projections. */
export function resultSchema(operation: Operation): PluginJsonSchema {
  switch (operation) {
    case 'projects-delete': return DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema;
    case 'projects-observe': return DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema;
    case 'projects-list': return resultObject({ projects: array(projectResult) });
    case 'provision-options': return resultObject({ organizationSlug: s, regions: array(resultObject({ code: s, name: s, type: s, provider: s, status: s }, ['provider', 'status'])),
      subscription: literal('organization'), price: literal('unknown'), entitlementsObserved: b, desiredInstanceSize: s }, ['desiredInstanceSize']);
    case 'projects-provision': return { anyOf: [nativeResult, unknownProject, unavailable] };
    case 'projects-link': return nativeResult;
    case 'branches-list': return resultObject({ branches: array(branchResult) });
    case 'branches-create': return { anyOf: [resultObject({ ...branchResult.properties, status: literal('provisioned'), providerStatus: s, ready: b,
      providerIdentity: identityResult, providerEnvironment: environmentResult }, ['gitBranch']), resultObject({ status: literal('outcome_unknown'), parentProjectRef: s, recovery: s, code: s, projectRef: s }, ['code', 'projectRef'])] };
    case 'branches-delete': return resultObject({ status: { type: 'string', enum: ['deleted', 'outcome_unknown'] }, branchProjectRef: s, code: s }, ['code']);
    case 'connections-save': return { anyOf: [pairResult, resultObject({ status: literal('unavailable'), code: s,
      resource: resultObject({ projectRef: s, branchRef: s, database: s }, ['database']), connections: connectionResults })] };
  }
}
