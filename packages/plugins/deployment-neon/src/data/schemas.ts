import { DeploymentTargetPreparationBaseV1ProtocolSchema, type JsonValue, type DeploymentTargetPreparationBaseV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolArray as array, defineProtocolLiteral as literal, defineProtocolNumber as number,
  defineProtocolObject as object, defineProtocolString as string, defineProtocolUnion as union,
  ScmHostingRepositoryIdentityV1ProtocolSchema, DeploymentDataParentBranchRefV1ProtocolSchema,
  type ProtocolComposableSchema, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
export const identifier = string({ minLength: 1 });
const flag = union([literal(true), literal(false)]);
export const audienceSchema = object({ accountGrants: array(identifier).optional(), teamGrants: array(identifier).optional(),
  groupGrants: array(identifier).optional() }, closed);
const reference = object({ ref: identifier, resourceRevision: number() }, closed);
const connectionName = union([literal('DATABASE_URL'), literal('DIRECT_URL')]);
const connections = object({ DATABASE_URL: reference.optional(), DIRECT_URL: reference.optional() }, closed);
const resource = { providerProjectId: identifier, branchId: identifier, endpointId: identifier, database: identifier, role: identifier };
export const connectionResult = object({ ...resource, secretId: identifier, audience: audienceSchema,
  status: union([literal('complete'), literal('partial')]), connections, incomplete: array(connectionName), code: identifier.optional(),
  applicationMode: literal('transaction-pooler'), migrationMode: literal('direct') }, closed);
export type ConnectionResult = ReturnType<typeof connectionResult.parse>;
export type ConnectionResource = Pick<ConnectionResult, 'providerProjectId' | 'branchId' | 'endpointId' | 'database' | 'role'>;
const save = { id: literal('database'), purpose: literal('data.connection'), audience: audienceSchema,
  labels: object({ DATABASE_URL: identifier, DIRECT_URL: identifier }, closed), database: identifier, role: identifier };
const createdSave = { ...save, rolePasswordLabel: identifier };
export type CreatedSaveIntent = SaveIntent & { rolePasswordLabel: string };
export const connectionInput = object({ ...save, endpointId: identifier, previous: connectionResult.optional() }, closed);
export type SaveIntent = Pick<ReturnType<typeof connectionInput.parse>, keyof typeof save>;
export const correlationSchema = object({ repository: ScmHostingRepositoryIdentityV1ProtocolSchema, pullRequestId: identifier }, closed);
export type Correlation = ReturnType<typeof correlationSchema.parse>;
const branch = object({ branchId: identifier, providerProjectId: identifier, name: identifier, status: identifier,
  ready: flag, parentBranchId: identifier.optional(), isDefault: flag, protected: flag }, closed);
const project = object({ providerProjectId: identifier, providerAccountId: identifier, name: identifier,
  regionId: identifier, engine: literal('postgres'), engineVersion: number({ integer: true }).optional(),
  providerConsole: object({ url: identifier, label: identifier }, closed) }, closed);
const providerIdentity = object({ providerAccountId: identifier, providerResourceId: identifier, providerEnvironment: identifier }, closed);
const operation = object({ id: identifier, status: identifier }, closed);
export const projectListInput = object({ cursor: identifier.optional(), search: identifier.optional(), projectId: identifier.optional(),
  includeBranches: flag.optional() }, closed);
export const projectListResult = object({ projects: array(project), unavailableProjectIds: array(identifier),
  branches: array(branch).optional(), nextCursor: identifier.optional() }, closed);
export const optionsInput = object({}, closed);
export const optionsResult = object({ providerAccountId: identifier, plan: identifier,
  regions: array(object({ id: identifier, title: identifier }, closed)), price: literal('unknown') }, closed);
export const linkInput = object({ projectId: identifier, branchId: identifier }, closed);
export const linkResult = object({ status: literal('configured'),
  providerProjectId: identifier, branchId: identifier, providerIdentity, providerEnvironment: object({ kind: literal('custom'), id: identifier }, closed),
  engine: literal('postgres'), engineVersion: number({ integer: true }).optional(),
  providerConsole: object({ url: identifier, label: identifier }, closed), ready: flag }, closed);
export const branchListInput = object({ cursor: identifier.optional(), search: identifier.optional(), branchId: identifier.optional(),
  operationIds: array(identifier).optional() }, closed);
export const branchListResult = object({ branches: array(branch), operations: array(operation), nextCursor: identifier.optional() }, closed);
export const provisionInput = object({ ...createdSave, name: identifier, regionId: identifier, requestKey: identifier,
  recover: literal(true).optional(), cursor: identifier.optional() }, closed);
const createBranch = { name: identifier, correlation: correlationSchema,
  initialization: union([literal('parent-schema'), literal('parent-data')]), recover: literal(true).optional(), cursor: identifier.optional(),
  parentBranchRef: DeploymentDataParentBranchRefV1ProtocolSchema.optional() };
export const createBranchInput = union([object(createBranch, closed), object({ ...createBranch, ...createdSave }, closed)]);
export type CreateBranchInput = ReturnType<typeof createBranchInput.parse>;
export const deleteBranchInput = object({ branchId: identifier, correlation: correlationSchema }, closed);
export const mutationResult = object({ status: union([literal('provisioned'), literal('configured'), literal('deleted'), literal('outcome_unknown')]),
  providerProjectId: identifier.optional(), branchId: identifier.optional(), endpointId: identifier.optional(), correlation: correlationSchema.optional(),
  providerIdentity: providerIdentity.optional(), providerEnvironment: object({ kind: literal('custom'), id: identifier }, closed).optional(),
  ready: flag.optional(), operationIds: array(identifier).optional(), recovered: flag.optional(),
  engine: literal('postgres').optional(), engineVersion: number({ integer: true }).optional(),
  providerConsole: object({ url: identifier, label: identifier }, closed).optional(),
  connectionSave: connectionResult.optional(), rolePassword: object({ role: identifier, ref: identifier,
    resourceRevision: number() }, closed).optional(),
  nextCursor: identifier.optional(), code: identifier.optional() }, closed);

/** Canonical custody fields retain their exact JSON Schema; this leaf adds only product operands. */
export function inputSchema(product: ProtocolComposableSchema<unknown>, selected = false): PluginJsonSchema {
  const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema;
  const variants = (product.jsonSchema.anyOf ?? [product.jsonSchema]).map(member => ({
    type: 'object' as const, properties: { ...base.properties, ...member.properties },
    required: [...base.required ?? [], ...member.required ?? [],
      ...(selected ? ['providerIdentity', 'targetLinkId', 'expectedTargetLinkRevision'] : [])], additionalProperties: false as const }));
  if (variants.length === 1) return variants[0]!;
  return { type: 'object', properties: Object.fromEntries(variants.flatMap(member => Object.entries(member.properties))),
    required: variants[0]!.required.filter(key => variants.every(member => member.required.includes(key))),
    additionalProperties: false, anyOf: variants };
}
export function readInput<T>(schema: ProtocolComposableSchema<T>, input: JsonValue): T & DeploymentTargetPreparationBaseV1 {
  // The Action owner validated the declared canonical custody schema at admission.
  const source = input as Readonly<Record<string, JsonValue>>;
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  return { ...source as unknown as DeploymentTargetPreparationBaseV1,
    ...schema.parse(pick([...new Set((schema.jsonSchema.anyOf ?? [schema.jsonSchema])
      .flatMap(member => Object.keys(member.properties ?? {})))])) };
}

export const targetSchema = object({}, closed);
