import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../../actions/executor/types.js';
import type { PluginAgentToolsCapabilityV2 } from '../../plugins/contributions/v2.js';
import { ConnectedAccountDaemonControlResponseSchema, type ConnectedAccountDaemonControlCommand } from '../../connect/connectedAccountDaemonRpcV1.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 as connectedOutputs } from '../../connect/configurationActionsV1.js';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 as signInService } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { canonicalMcpOAuthResourceUrlV1 } from '../oauth/mcpOAuthResourceV1.js';
import { MCP_OAUTH_CLIENT_METADATA_URL_V1, McpOAuthClientRegistrationV1Schema } from '../oauth/mcpOAuthClientIdentityV1.js';
import { McpServerRuleV1Schema, McpServerCatalogEntryV1Schema, McpServerConfigOverrideV1Schema,
  McpServerToolPolicyV1Schema, McpServerToolSettingsPatchV1Schema, McpServerToolsSnapshotV1Schema, McpToolSettingV1Schema, McpToolSettingsV1Schema,
  McpPluginItemMetadataV1Schema, type McpPluginItemMetadataV1 } from './settingsV1.js';
import { isMcpPluginItemIdV1 } from './settingsV1.js';
import { McpServerPluginSettingsV1Schema } from './settingsV1.js';
import { ReachRulesChangeV1Schema, resolveCreateReachV1, type ReachRulesWriteContextV1 } from '../../reach/reachRulesChangeV1.js';
import { McpRulesSetInputV1Schema, McpRulesSetOutputV1Schema } from '../../actions/specs/capabilityRules.js';
import { McpServerCatalogSnapshotV1Schema,
  type McpServerCatalogSnapshotV1, type McpServerCatalogMutationV1 } from './catalogSchemasV1.js';
import { McpServerCatalogV1Schema, McpServerCatalogDiagnosticV1Schema, McpServerCatalogRowMutationResponseV1Schema,
  type McpServerCatalogMutationResponseV1 } from './catalogSchemasV1.js';
import { DaemonMcpServersTestAuthoringRequestSchema, DaemonMcpServersTestResponseSchema,
  DaemonMcpServersDetectRequestSchema, DaemonMcpServersDetectResponseSchema } from './daemonRpcV1.js';
import { DetectedMcpServerV1Schema } from './daemonRpcV1.js';
import type { McpServerActionIdV1 } from './serverActionIdsV1.js';
import { resolveMcpToolDecisionV1 } from './tools/resolveMcpToolDecisionV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../../registries/registryActionsV1.js';
import { RegistryItemPointerV1Schema } from '../../registries/registryItemsV1.js';
import { ValueRefV1Schema } from '../../valueRefs/valueRefV1.js';
import { mapMcpRegistryServerV1 } from './registry/mapMcpRegistryServerV1.js';
import { encodeMcpServerInstallLinkV1, parseMcpServerImportV1 } from './import/parseMcpServerImportV1.js';
import { McpImportPreviewV1Schema, McpImportCommitV1Schema, McpImportValuesV1Schema, McpImportValueChoiceV1Schema,
  prepareMcpServerImportV1, prepareDetectedMcpServerImportV1, materializeMcpServerImportV1 } from './import/mcpServerImportV1.js';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '../../account/settings/personalSavedSecretActionsV1.js';
import { uniqueMcpServerNameV1 } from './serverCatalogV1.js';
export { MCP_SERVER_ACTION_IDS_V1, isMcpServerActionIdV1, type McpServerActionIdV1 } from './serverActionIdsV1.js';

const revision = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
const catalogRevision = lazyZodSchema(() => z.union([revision, z.literal('absent')]));
const identity = lazyZodSchema(() => z.string().check(z.minLength(1)));
const createItem = lazyZodSchema(() => z.strictObject({ entry: McpServerCatalogEntryV1Schema,
  where: z.optional(ReachRulesChangeV1Schema) }));
const serverWrite = lazyZodSchema(() => z.strictObject({ expectedRevision: catalogRevision,
  entry: McpServerCatalogEntryV1Schema, configOverrides: z.optional(z.array(McpServerConfigOverrideV1Schema)) }));
const serverCreate = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(createItem, { expectedRevision: catalogRevision })),
  z.strictObject({ expectedRevision: catalogRevision, entries: z.array(createItem) }),
  z.strictObject({ expectedRevision: catalogRevision, from: z.strictObject({ registry: RegistryItemPointerV1Schema }),
    name: z.optional(z.string()), title: z.optional(z.string()), inputs: z.optional(z.record(z.string(), ValueRefV1Schema)),
    remote: z.optional(z.strictObject({ auth: z.strictObject({ kind: z.literal('oauth') }) })),
    where: z.optional(ReachRulesChangeV1Schema) }),
]));
const serverUpdate = lazyZodSchema(() => z.union([serverWrite,
  z.strictObject({ expectedRevision: catalogRevision, serverId: identity, from: z.strictObject({ registry: RegistryItemPointerV1Schema }),
    inputs: z.optional(z.record(z.string(), ValueRefV1Schema)) }),
]));
const serverListEntry = lazyZodSchema(() => {
  const { id, name, title, description, transport, createdAt, updatedAt } = McpServerCatalogEntryV1Schema.shape;
  return z.strictObject({ id, name, title, description, transport, createdAt, updatedAt });
});
const bindingListEntry = McpServerRuleV1Schema;
const listCatalog = lazyZodSchema(() => z.strictObject({ v: McpServerCatalogV1Schema.shape.v,
  servers: z.array(z.union([serverListEntry, McpPluginItemMetadataV1Schema])), bindings: z.array(bindingListEntry),
  pluginItemsStatus: z.optional(z.enum(['ready', 'unavailable'])) }));
const listSnapshot = lazyZodSchema(() => z.discriminatedUnion('status', [
  McpServerCatalogSnapshotV1Schema._zod.def.options[0], McpServerCatalogSnapshotV1Schema._zod.def.options[1],
  z.extend(McpServerCatalogSnapshotV1Schema._zod.def.options[2], { catalog: listCatalog }),
  z.extend(McpServerCatalogSnapshotV1Schema._zod.def.options[3], { catalog: listCatalog }),
]));
const readResult = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('plugin'), server: McpPluginItemMetadataV1Schema, bindings: z.array(McpServerRuleV1Schema),
    settings: z.optional(McpServerPluginSettingsV1Schema), revision: catalogRevision }),
  McpServerCatalogSnapshotV1Schema,
  z.strictObject({ status: z.literal('present'), server: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerRuleV1Schema), revision: catalogRevision,
    installLink: z.optional(z.url()),
    authority: z.enum(['active', 'inactive']), complete: z.boolean(), diagnostics: z.array(McpServerCatalogDiagnosticV1Schema) }),
  z.strictObject({ status: z.literal('not-found'), serverId: identity, revision: catalogRevision }),
]));

const toolsListResult = lazyZodSchema(() => z.strictObject({
  serverId: identity, revision: catalogRevision, snapshot: z.optional(McpServerToolsSnapshotV1Schema),
  settings: z.strictObject({ default: McpServerToolPolicyV1Schema.shape.default,
    tools: McpToolSettingsV1Schema }),
  tools: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerToolsSnapshotV1Schema.shape.tools._zod.def.element, {
    setting: z.union([McpToolSettingV1Schema, z.literal('inherit')]), source: z.enum(['tool', 'server_default']),
  }))),
  tokens: z.nullable(z.number().check(z.nonnegative())),
  perAgent: z.strictObject({ status: z.enum(['ready', 'unavailable']), machineId: z.optional(identity), agents: z.array(z.strictObject({
    agentId: identity, approval: z.nullable(z.enum(['native', 'host'])), off: z.nullable(z.enum(['hidden', 'blocked'])),
    loading: z.enum(['every_turn', 'on_demand']), tokens: z.nullable(z.number().check(z.nonnegative())),
  })) }),
}));

/** Semantic requests are closed and use the one catalog revision, never item-local versions. */
export const MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 = {
  'mcp.servers.list': lazyZodSchema(() => z.strictObject({})),
  'mcp.servers.read': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.tools.list': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.tools.set': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerToolSettingsPatchV1Schema, { serverId: identity }))),
  'mcp.servers.create': serverCreate,
  'mcp.servers.update': serverUpdate,
  'mcp.servers.duplicate': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.delete': lazyZodSchema(() => z.strictObject({ expectedRevision: catalogRevision,
    serverId: identity, removeBindings: z.boolean() })),
  'mcp.servers.test': DaemonMcpServersTestAuthoringRequestSchema,
  'mcp.found.list': lazyZodSchema(() => z.extend((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(DaemonMcpServersDetectRequestSchema), { machineId: z.optional(identity) })),
  'mcp.servers.import': lazyZodSchema(() => z.strictObject({ expectedRevision: z.optional(catalogRevision),
    source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('paste'), text: z.string() }),
      z.strictObject({ kind: z.literal('link'), url: z.string() })]), dryRun: z.boolean(),
    values: z.optional(McpImportValuesV1Schema), where: z.optional(ReachRulesChangeV1Schema) })),
  'mcp.found.adopt': lazyZodSchema(() => z.strictObject({ expectedRevision: z.optional(catalogRevision), machineId: identity,
    items: z.array(DetectedMcpServerV1Schema), where: z.optional(ReachRulesChangeV1Schema),
    values: z.optional(z.union([McpImportValuesV1Schema, z.record(z.string(), z.record(z.string(), McpImportValueChoiceV1Schema))])) })),
  'mcp.servers.signIn.start': lazyZodSchema(() => z.strictObject({ serverId: identity, stepUp: z.optional(z.boolean()),
    client: z.optional(McpOAuthClientRegistrationV1Schema) })),
} as const;
export const MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'mcp.servers.list': listSnapshot,
  'mcp.servers.read': readResult,
  'mcp.servers.tools.list': toolsListResult,
  'mcp.servers.tools.set': lazyZodSchema(() => z.strictObject({ revision,
    previous: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerToolSettingsPatchV1Schema, { tools: McpServerToolSettingsPatchV1Schema.shape.tools._zod.def.innerType })),
  })),
  'mcp.servers.create': lazyZodSchema(() => z.union([
    z.strictObject({ status: z.literal('updated'), revision, cursor: revision, serverId: identity }),
    z.strictObject({ status: z.literal('updated'), revision, cursor: revision, serverIds: z.array(identity) }),
  ])),
  'mcp.servers.update': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.duplicate': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.delete': lazyZodSchema(() => z.union([McpServerCatalogRowMutationResponseV1Schema,
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerCatalogRowMutationResponseV1Schema._zod.def.options[0], { signOut: z.union([
      z.strictObject({ status: z.literal('revoked'), remoteStatus: z.enum(['remoteRevoked', 'remoteUnsupported', 'remoteNotAttempted']) }),
      z.strictObject({ status: z.literal('not_connected') }),
      z.strictObject({ status: z.literal('pending') }),
    ]) })),
  ])),
  'mcp.servers.test': DaemonMcpServersTestResponseSchema,
  'mcp.found.list': DaemonMcpServersDetectResponseSchema,
  'mcp.servers.import': lazyZodSchema(() => z.union([McpImportPreviewV1Schema, McpImportCommitV1Schema])),
  'mcp.found.adopt': McpImportCommitV1Schema,
  'mcp.servers.signIn.start': lazyZodSchema(() => z.strictObject({ attemptId: identity, authorizationUrl: z.url(),
    expiresAtMs: z.number().check(z.int(), z.nonnegative()), machineId: identity,
    clientRegistration: z.optional(z.literal('not_needed')) })),
} as const;
export type McpServerActionRequestV1 = Readonly<{ actionId: McpServerActionIdV1 | 'mcp.rules.set'; input: unknown; context: ActionExecutorContext }>;
export type McpServerToolAgentFactV1 = Readonly<{ agentId: string }>
  & Pick<PluginAgentToolsCapabilityV2, 'mcpToolControl' | 'mcpToolLoading'>;
export type McpServerActionPortsV1 = Readonly<{
  /** Application hosts supply their canonical web-app URL; plugin metadata has no installable definition. */
  resolveWebappUrl?(context: ActionExecutorContext): string | Promise<string>;
  registryActionExecute?: ActionExecutorDeps['registryActionExecute'];
  personalSavedSecretActionExecute?: ActionExecutorDeps['personalSavedSecretActionExecute'];
  readImportLink?(url: string, context: ActionExecutorContext): Promise<string>;
  readPluginItems?(context: ActionExecutorContext): Promise<readonly McpPluginItemMetadataV1[] | null>;
  readCatalog(context: ActionExecutorContext): Promise<McpServerCatalogSnapshotV1>;
  mutate(change: McpServerCatalogMutationV1, expectedRevision: number | 'absent', context: ActionExecutorContext): Promise<McpServerCatalogMutationResponseV1>;
  ruleWriteContext?: () => ReachRulesWriteContextV1;
  readToolAgentFacts?(context: ActionExecutorContext): Promise<Readonly<{
    agents: readonly McpServerToolAgentFactV1[]; machineId?: string;
  }> | null>;
  resolveAdministrationMachine?(context: ActionExecutorContext): Promise<string | null>;
  describeConnectedService?(machineId: string,
    command: Extract<ConnectedAccountDaemonControlCommand, { operation: 'describeService' }>,
    context: ActionExecutorContext): Promise<unknown>;
  connectedServiceAction?: ActionExecutorDeps['connectedServiceAction'];
  machine(request: Readonly<{ actionId: 'mcp.servers.test' | 'mcp.found.list'; input: unknown;
    machineId: string; context: ActionExecutorContext }>): Promise<unknown>;
}>;

const catalogFailureCodes = new Set<string>([
  ...McpServerCatalogSnapshotV1Schema._zod.def.options[1].shape.reason.options,
  'invalid-mutation', 'reference-conflict', 'outcome_unknown', 'server_scope_mismatch',
  'not_authenticated', 'permission_denied', 'admission_unavailable', 'invalid_action_output',
  'machine_unreachable', 'mcp_catalog_unavailable', 'database_transaction_conflict_exhausted',
  'no_machine_online', 'mcp_server_not_found', 'mcp_sign_in_not_supported', 'client_refused', 'invalid_client', 'mcp_oauth_resource_requires_https', 'mcp_oauth_endpoints_require_https',
  'connected_account_configuration_target_unavailable',
  'mcp_catalog_conflict',
  'registry_unavailable', 'unsupported_entry', 'invalid_registry_input',
]);

/** Domain/transport causes can contain literal credentials; expose only owned refusal codes. */
export function projectMcpServerActionFailureV1(cause: unknown): ActionExecuteFailure {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  const aborted = cause && typeof cause === 'object' && 'name' in cause && cause.name === 'AbortError';
  const errorCode = code === 'action_account_scope_changed' ? 'scope-retired' : aborted ? 'cancelled'
    : typeof code === 'string' && catalogFailureCodes.has(code) ? code : 'mcp_catalog_operation_failed';
  return { ok: false, errorCode, error: errorCode };
}

/** The shared Action adapter selects semantic operations; catalog decisions stay at its owner. */
export function createMcpServerActionExecuteV1(ports: McpServerActionPortsV1) {
  return async ({ actionId, input, context }: McpServerActionRequestV1): Promise<ActionExecuteResult> => {
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const connected = async <TId extends keyof typeof connectedOutputs>(id: TId, operands: unknown, operationContext = context) => {
      if (!ports.connectedServiceAction) throw Object.assign(new Error('Connected Services unavailable'), { code: 'mcp_sign_in_not_supported' });
      const response = await ports.connectedServiceAction({ actionId: id, input: operands, context: operationContext, signal: operationContext.signal });
      if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
        throw Object.assign(new Error('Connected Services refused'), {
          code: 'errorCode' in response ? response.errorCode : 'mcp_sign_in_not_supported' });
      }
      return connectedOutputs[id].parse(response) as z.infer<(typeof connectedOutputs)[TId]>;
    };
    const describe = async (machineId: string, requiredOperation: 'credential_write' | 'credential_delete') => {
      if (!ports.describeConnectedService) throw Object.assign(new Error('Connected Services unavailable'), { code: 'mcp_sign_in_not_supported' });
      const description = ConnectedAccountDaemonControlResponseSchema.parse(await ports.describeConnectedService(machineId,
        { operation: 'describeService', service: signInService, requiredOperation }, context));
      if (description.status !== 'described' || description.service.pluginId !== signInService.pluginId
        || description.service.localId !== signInService.localId || description.operationTransport?.kind !== 'v4') {
        throw Object.assign(new Error('Connected Services unavailable'), { code: 'mcp_sign_in_not_supported' });
      }
      return description;
    };
    if (actionId === 'mcp.rules.set') {
      const inputRules = McpRulesSetInputV1Schema.parse(input);
      if (inputRules.change.kind === 'replace' && inputRules.items.length !== 1) {
        return { ok: true, result: { ok: false, code: 'replace_needs_one_item' } };
      }
      const snapshot = await ports.readCatalog(context);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') return { ok: true, result: { ok: false, code: 'catalog_unavailable' } };
      if (inputRules.expectedRevision !== undefined && inputRules.expectedRevision !== snapshot.revision) {
        return { ok: true, result: { ok: false, code: 'conflict' } };
      }
      const ids = inputRules.items.map(item => 'serverId' in item ? item.serverId
        : snapshot.catalog.servers.find(server => server.name === item.name)?.id);
      const pluginAdmissionNeeded = ids.some(id => id !== undefined && isMcpPluginItemIdV1(id) && !snapshot.catalog.servers.some(server => server.id === id));
      const plugins = pluginAdmissionNeeded && ports.readPluginItems ? await ports.readPluginItems(context) : [];
      if (pluginAdmissionNeeded && plugins == null) return { ok: true, result: { ok: false, code: 'catalog_unavailable' } };
      if (ids.some(id => id === undefined || !snapshot.catalog.servers.some(server => server.id === id) && !plugins?.some(item => item.id === id))) {
        return { ok: true, result: { ok: false, code: 'not_found' } };
      }
      const serverIds = [...new Set(ids.filter((id): id is string => id !== undefined))];
      const receipt = await ports.mutate({ kind: 'rules-change', serverIds, change: inputRules.change }, snapshot.revision, context);
      const result = receipt.status === 'updated' && receipt.items ? { ok: true, items: receipt.items, revision: receipt.revision }
        : { ok: false, code: receipt.status === 'conflict' || receipt.status === 'settings-conflict' ? 'conflict' : 'catalog_unavailable' };
      return { ok: true, result: McpRulesSetOutputV1Schema.parse(result) };
    }
    const createRules = (entryId: string, where?: z.infer<typeof ReachRulesChangeV1Schema>) => {
      const ctx = ports.ruleWriteContext?.() ?? { nowMs: Date.now(), newId: () => globalThis.crypto.randomUUID() };
      const reach = resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: context.surface ?? null, sessionId: context.defaultSessionId ?? undefined }, requested: where, ctx });
      if (!reach.ok) throw new Error(reach.code);
      return reach.rules.map(rule => ({ ...rule, serverId: entryId }));
    };
    const registryEntry = async (pointer: z.infer<typeof RegistryItemPointerV1Schema>, inputs?: Readonly<Record<string, z.infer<typeof ValueRefV1Schema>>>,
      previous?: z.infer<typeof McpServerCatalogEntryV1Schema>, name?: string, oauth?: boolean) => {
      if (!ports.registryActionExecute) throw Object.assign(new Error('Registry Action unavailable'), { code: 'registry_unavailable' });
      const sources = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(await ports.registryActionExecute({
        actionId: 'registries.sources.list', input: { kind: 'mcpServer' }, context }));
      const source = sources.sources.find(source => source.id === pointer.sourceId && source.enabled);
      if (!source) throw Object.assign(new Error('Registry source unavailable'), { code: 'registry_unavailable' });
      const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await ports.registryActionExecute({
        actionId: 'registries.items.read', input: { kind: 'mcpServer', ...pointer }, context }));
      if (item.payload.kind !== 'mcpServer' || item.summary.problem || item.summary.itemId !== pointer.itemId || item.summary.version !== pointer.version)
        throw Object.assign(new Error('Unsupported registry item'), { code: 'unsupported_entry' });
      const snapshot = await ports.readCatalog(context);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') throw Object.assign(new Error('Catalog unavailable'), { code: 'mcp_catalog_unavailable' });
      const ctx = ports.ruleWriteContext?.() ?? { nowMs: Date.now(), newId: () => globalThis.crypto.randomUUID() };
      const baseName = name ?? previous?.name ?? (item.payload.server.name.split('/').at(-1)!.toLowerCase().replace(/[^a-z0-9_-]/gu, '_') || 'server');
      const uniqueName = !name && !previous ? uniqueMcpServerNameV1(baseName, snapshot.catalog.servers) : baseName;
      const mapped = mapMcpRegistryServerV1({ server: item.payload.server, id: previous?.id ?? ctx.newId(), name: uniqueName,
        nowMs: ctx.nowMs, inputs, previous, oauth });
      if (!mapped.ok) return mapped;
      return { ok: true as const, entry: { ...mapped.entry, origin: { kind: 'registry' as const, provenance: {
        sourceId: pointer.sourceId, sourceUrl: source.url, format: source.format, itemId: pointer.itemId,
        ref: { kind: 'version' as const, version: pointer.version }, importedAt: ctx.nowMs,
      } } } };
    };
    let result: unknown;
    switch (actionId) {
      case 'mcp.servers.list': {
        const snapshot = await ports.readCatalog(context);
        const pluginItems = await ports.readPluginItems?.(context);
        // Configuration stays private to the domain owner and explicit read.
        // Lists disclose metadata without guessing which literals are secrets.
        result = snapshot.status === 'ready' || snapshot.status === 'partial'
          ? { ...snapshot, catalog: { v: snapshot.catalog.v,
            servers: [...snapshot.catalog.servers.map(entry => lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(serverListEntry)).parse(entry)),
              ...(pluginItems ?? []).map(item => McpPluginItemMetadataV1Schema.parse(item))],
            ...(ports.readPluginItems ? { pluginItemsStatus: pluginItems === null ? 'unavailable' : 'ready' } : {}),
            bindings: snapshot.catalog.bindings.map(entry => lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(bindingListEntry)).parse(entry)),
          } } : snapshot;
        break;
      }
      case 'mcp.servers.read': {
        const { serverId } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const snapshot = await ports.readCatalog(context);
        if (snapshot.status === 'loading' || snapshot.status === 'unavailable') { result = snapshot; break; }
        const server = snapshot.catalog.servers.find(entry => entry.id === serverId);
        const plugin = !server && (await ports.readPluginItems?.(context))?.find(item => item.id === serverId);
        if (plugin) { result = { status: 'plugin', server: plugin, bindings: snapshot.catalog.bindings.filter(rule => rule.serverId === serverId),
          settings: snapshot.catalog.pluginServers?.[serverId], revision: snapshot.revision }; break; }
        const webappUrl = server ? await ports.resolveWebappUrl?.(context) : undefined;
        result = server ? { status: 'present', server, bindings: snapshot.catalog.bindings.filter(binding => binding.serverId === serverId),
          ...(webappUrl ? { installLink: encodeMcpServerInstallLinkV1(server, webappUrl) } : {}),
          revision: snapshot.revision, authority: snapshot.authority, complete: snapshot.status === 'ready', diagnostics: snapshot.diagnostics }
          : snapshot.status === 'partial' || snapshot.authority !== 'active' ? snapshot
            : { status: 'not-found', serverId, revision: snapshot.revision };
        break;
      }
      case 'mcp.servers.tools.list': {
        const { serverId } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const catalog = await ports.readCatalog(context);
        if (catalog.status !== 'ready' || catalog.authority !== 'active') {
          return { ok: false, errorCode: 'mcp_catalog_unavailable', error: 'mcp_catalog_unavailable' };
        }
        const catalogServer = catalog.catalog.servers.find(entry => entry.id === serverId);
        const plugin = !catalogServer && (await ports.readPluginItems?.(context))?.find(item => item.id === serverId);
        const server: z.infer<typeof McpServerPluginSettingsV1Schema> | undefined = catalogServer
          ?? (plugin ? catalog.catalog.pluginServers?.[serverId] ?? {} : undefined);
        if (!server) return { ok: false, errorCode: 'mcp_server_not_found', error: 'mcp_server_not_found' };
        const overrides: z.infer<typeof McpToolSettingsV1Schema> = server.tools?.overrides ?? {};
        const tokenCost = server.toolsSnapshot ? server.toolsSnapshot.tools.reduce((sum, tool) => sum + tool.tokens, 0) : null;
        const visibleTokenCost = server.toolsSnapshot ? server.toolsSnapshot.tools.reduce((sum, tool) => {
          const decision = resolveMcpToolDecisionV1({ policy: server.tools, toolName: tool.name,
            annotations: tool.annotations, permissionMode: 'default' });
          return sum + (decision.exposed ? tool.tokens : 0);
        }, 0) : null;
        const facts = await ports.readToolAgentFacts?.(context);
        context.signal?.throwIfAborted();
        result = { serverId, revision: catalog.revision, snapshot: server.toolsSnapshot,
          settings: { default: server.tools?.default ?? 'ask', tools: overrides },
          tools: (server.toolsSnapshot?.tools ?? []).map(tool => {
            const own = Object.hasOwn(overrides, tool.name);
            return { ...tool, setting: own ? overrides[tool.name] : 'inherit', source: own ? 'tool' : 'server_default' };
          }),
          tokens: tokenCost,
          perAgent: facts ? { status: 'ready', ...(facts.machineId ? { machineId: facts.machineId } : {}),
            agents: facts.agents.map(agent => ({ agentId: agent.agentId,
              approval: agent.mcpToolControl?.approval ?? null, off: agent.mcpToolControl?.off ?? null,
              loading: agent.mcpToolLoading ?? 'every_turn',
              tokens: agent.mcpToolControl?.off === 'hidden' ? visibleTokenCost : tokenCost,
            })),
          } : { status: 'unavailable', agents: [] },
        };
        break;
      }
      case 'mcp.servers.tools.set': {
        const { serverId, ...settings } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const catalog = await ports.readCatalog(context);
        if (catalog.status !== 'ready' || catalog.authority !== 'active') {
          return { ok: false, errorCode: 'mcp_catalog_unavailable', error: 'mcp_catalog_unavailable' };
        }
        const catalogServer = catalog.catalog.servers.find(entry => entry.id === serverId && !entry.id.startsWith('plugin:'));
        const plugin = !catalogServer && (await ports.readPluginItems?.(context))?.find(item => item.id === serverId);
        const server: z.infer<typeof McpServerPluginSettingsV1Schema> | undefined = catalogServer
          ?? (plugin ? catalog.catalog.pluginServers?.[serverId] ?? {} : undefined);
        if (!server) return { ok: false, errorCode: 'mcp_server_not_found', error: 'mcp_server_not_found' };
        const overrides: z.infer<typeof McpToolSettingsV1Schema> = server.tools?.overrides ?? {};
        const previous = {
          ...(settings.default === undefined ? {} : { default: server.tools?.default ?? 'ask' }),
          tools: Object.fromEntries(Object.keys(settings.tools ?? {}).map(name => [name,
            Object.hasOwn(overrides, name) ? overrides[name] : 'inherit'])),
        };
        const receipt = await ports.mutate({ kind: 'tools-change', serverId, settings }, catalog.revision, context);
        if (receipt.status !== 'updated') {
          return projectMcpServerActionFailureV1({ code: receipt.status === 'conflict' || receipt.status === 'settings-conflict'
            ? 'mcp_catalog_conflict' : receipt.status });
        }
        result = { revision: receipt.revision, previous };
        break;
      }
      case 'mcp.servers.create': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        let mutation: McpServerCatalogMutationV1;
        if ('from' in change) {
          const mapped = await registryEntry(change.from.registry, change.inputs, undefined, change.name, change.remote?.auth.kind === 'oauth');
          if (!mapped.ok) return { ok: false, errorCode: 'missing_values', error: 'missing_values', details: { missingValues: mapped.missingValues } };
          mutation = { kind: 'server-create', entry: change.title ? { ...mapped.entry, title: change.title } : mapped.entry,
            rules: createRules(mapped.entry.id, change.where) };
        } else {
          mutation = 'entries' in change
            ? { kind: 'server-create-batch', entries: change.entries.map(item => ({ entry: item.entry, rules: createRules(item.entry.id, item.where) })) }
            : { kind: 'server-create', entry: change.entry, rules: createRules(change.entry.id, change.where) };
        }
        const receipt = await ports.mutate(mutation, expectedRevision, context);
        if (receipt.status !== 'updated') return projectMcpServerActionFailureV1({
          code: receipt.status === 'conflict' || receipt.status === 'settings-conflict' ? 'mcp_catalog_conflict' : receipt.status,
        });
        result = { status: receipt.status, revision: receipt.revision, cursor: receipt.cursor,
          ...(mutation.kind === 'server-create' ? { serverId: mutation.entry.id }
            : { serverIds: mutation.entries.map(item => item.entry.id) }) };
        break;
      }
      case 'mcp.servers.update': {
        const request = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        if ('from' in request) {
          const snapshot = await ports.readCatalog(context);
          if (snapshot.status !== 'ready' || snapshot.authority !== 'active') return projectMcpServerActionFailureV1({ code: 'mcp_catalog_unavailable' });
          const previous = snapshot.catalog.servers.find(server => server.id === request.serverId);
          if (!previous) return projectMcpServerActionFailureV1({ code: 'mcp_server_not_found' });
          const mapped = await registryEntry(request.from.registry, request.inputs, previous);
          if (!mapped.ok) return { ok: false, errorCode: 'missing_values', error: 'missing_values', details: { missingValues: mapped.missingValues } };
          result = await ports.mutate({ kind: 'server-update', entry: mapped.entry }, request.expectedRevision, context); break;
        }
        const { expectedRevision, entry, configOverrides } = request;
        result = await ports.mutate({ kind: 'server-update', entry: configOverrides === undefined ? entry : { ...entry, configOverrides } }, expectedRevision, context);
        break;
      }
      case 'mcp.servers.import': case 'mcp.found.adopt': {
        const snapshot = await ports.readCatalog(context);
        if (snapshot.status !== 'ready' || snapshot.authority !== 'active') return projectMcpServerActionFailureV1({ code: 'mcp_catalog_unavailable' });
        const request = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        let parsed: ReturnType<typeof parseMcpServerImportV1>;
        if (actionId === 'mcp.servers.import') {
          const imported = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
          let text = imported.source.kind === 'paste' ? imported.source.text : imported.source.url;
          // Install links decode locally; only an HTTPS config document needs host HTTP.
          if (imported.source.kind === 'link' && /^https:\/\//u.test(text) && !new URL(text).searchParams.has('install')) {
            if (!ports.readImportLink) return { ok: false, errorCode: 'import_link_unavailable', error: 'import_link_unavailable' };
            text = await ports.readImportLink(text, context);
          }
          parsed = parseMcpServerImportV1(text);
          if (imported.dryRun) { result = prepareMcpServerImportV1({ parsed, catalog: snapshot.catalog, values: imported.values }); break; }
        } else {
          const adopted = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
          parsed = prepareDetectedMcpServerImportV1(adopted.items, adopted.machineId);
        }
        const values = McpImportValuesV1Schema.safeParse(request.values);
        const flat = values.success ? values.data : request.values ? Object.fromEntries(Object.entries(request.values).flatMap(([server, entries]) =>
          Object.entries(entries).flatMap(([key, value]) => parsed.inputs.filter(input => input.inputId === `${server}:env:${key}` || input.inputId === `${server}:header:${key}`)
            .map(input => [input.inputId, McpImportValueChoiceV1Schema.parse(value)])))) : undefined;
        const ctx = ports.ruleWriteContext?.() ?? { nowMs: Date.now(), newId: () => globalThis.crypto.randomUUID() };
        const prepared = await materializeMcpServerImportV1({ parsed, catalog: snapshot.catalog, values: flat, nowMs: ctx.nowMs, newId: ctx.newId,
          createSecret: async secret => {
            if (!ports.personalSavedSecretActionExecute) throw Object.assign(new Error('Saved Secret Action unavailable'), { code: 'secret_unavailable' });
            const response = await ports.personalSavedSecretActionExecute({ actionId: 'secrets.create', input: secret, context });
            if (response && typeof response === 'object' && 'ok' in response && response.ok === false) throw response;
            return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(response);
          } });
        if (!prepared.ok) return { ok: false, errorCode: prepared.code, error: prepared.code,
          details: { missingValues: prepared.missingValues, movedSecrets: prepared.movedSecrets } };
        if (!prepared.entries.length) { result = { ok: true, revision: typeof snapshot.revision === 'number' ? snapshot.revision : 0,
          serverIds: [], duplicates: prepared.duplicates, movedSecrets: prepared.movedSecrets }; break; }
        let receipt: McpServerCatalogMutationResponseV1;
        try {
          receipt = await ports.mutate({ kind: 'server-create-batch', entries: prepared.entries.map(entry => ({ entry,
            rules: createRules(entry.id, request.where) })) }, request.expectedRevision ?? snapshot.revision, context);
        } catch (cause) {
          return { ...projectMcpServerActionFailureV1(cause), details: { movedSecrets: prepared.movedSecrets } };
        }
        if (receipt.status !== 'updated') return { ok: false, errorCode: receipt.status === 'conflict' || receipt.status === 'settings-conflict'
          ? 'mcp_catalog_conflict' : 'mcp_catalog_operation_failed', error: 'MCP catalog import did not settle',
          details: { movedSecrets: prepared.movedSecrets } };
        result = { ok: true, revision: receipt.revision, serverIds: prepared.entries.map(entry => entry.id),
          duplicates: prepared.duplicates, movedSecrets: prepared.movedSecrets }; break;
      }
      case 'mcp.servers.duplicate': {
        const { serverId } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const snapshot = await ports.readCatalog(context);
        if (snapshot.status !== 'ready' || snapshot.authority !== 'active') return projectMcpServerActionFailureV1({ code: 'mcp_catalog_unavailable' });
        const source = snapshot.catalog.servers.find(server => server.id === serverId);
        if (!source) return projectMcpServerActionFailureV1({ code: 'mcp_server_not_found' });
        const ctx = ports.ruleWriteContext?.() ?? { nowMs: Date.now(), newId: () => globalThis.crypto.randomUUID() };
        const name = uniqueMcpServerNameV1(`${source.name}_copy`, snapshot.catalog.servers);
        // Only configuration lives on the catalog entry. OAuth grants and
        // attempts belong to Connected Accounts under the source id.
        const entry = { ...source, id: ctx.newId(), name,
          ...(source.title ? { title: `${source.title} copy` } : {}), createdAt: ctx.nowMs, updatedAt: ctx.nowMs };
        context.signal?.throwIfAborted();
        const receipt = await ports.mutate({ kind: 'server-duplicate', serverId, entry, rules: createRules(entry.id) }, snapshot.revision, context);
        if (receipt.status !== 'updated') return projectMcpServerActionFailureV1({ code: receipt.status === 'conflict' || receipt.status === 'settings-conflict'
          ? 'mcp_catalog_conflict' : receipt.status });
        result = { serverId: entry.id }; break;
      }
      case 'mcp.servers.delete': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const snapshot = await ports.readCatalog(context);
        const oauth = (snapshot.status === 'ready' || snapshot.status === 'partial')
          && snapshot.catalog.servers.find(server => server.id === change.serverId)?.remote?.auth?.kind === 'oauth';
        const receipt = await ports.mutate({ kind: 'server-remove', ...change }, expectedRevision, context);
        result = receipt;
        if (receipt.status === 'updated' && oauth) {
          let signOut: { status: 'pending' } | { status: 'not_connected' }
            | { status: 'revoked'; remoteStatus: 'remoteRevoked' | 'remoteUnsupported' | 'remoteNotAttempted' } = { status: 'pending' };
          try {
            const machineId = await ports.resolveAdministrationMachine?.(context);
            if (machineId) {
              const account = { service: signInService, accountId: change.serverId };
              const description = await describe(machineId, 'credential_delete');
              const profile = description.accounts.find(profile => profile.ref.accountId === change.serverId
                && profile.ref.service.pluginId === signInService.pluginId && profile.ref.service.localId === signInService.localId);
              if (!profile) signOut = { status: 'not_connected' };
              else {
                const input = { machineId, account, cleanupGroupReferences: true,
                  ...(profile.revisionSemantics === 'revisioned' ? { expectedCredentialRevision: profile.credentialRevision } : {}) };
                const prepared = ports.connectedServiceAction?.prepareInput
                  ? await ports.connectedServiceAction.prepareInput({ actionId: 'connectedServices.accounts.revoke', input, context, signal: context.signal })
                  : input;
                const revoked = await connected('connectedServices.accounts.revoke', prepared);
                if (revoked.status === 'revoked') signOut = { status: 'revoked', remoteStatus: revoked.remoteStatus };
              }
            }
          } catch { /* The catalog ACK survives an unavailable or indeterminate revoke. */ }
          result = { ...receipt, signOut };
        }
        break;
      }
      case 'mcp.servers.signIn.start': {
        const { serverId, stepUp, client } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        // Only the existing secret configuration channel carries this one-shot
        // input. Discovery binds it to the actual issuer and stages registrations.
        const secretValues = client === undefined ? {} : { clientRegistration: JSON.stringify(client),
          ...(client === null ? { clientSecrets: '{}' } : {}) };
        const registrationValues = client === null ? { registrations: {} } : {};
        const snapshot = await ports.readCatalog(context);
        if (snapshot.status !== 'ready' || snapshot.authority !== 'active') {
          return { ok: false, errorCode: 'mcp_catalog_unavailable', error: 'mcp_catalog_unavailable' };
        }
        const server = snapshot.catalog.servers.find(entry => entry.id === serverId);
        if (!server) return { ok: false, errorCode: 'mcp_server_not_found', error: 'mcp_server_not_found' };
        if (!server.remote || server.remote.auth?.kind !== 'oauth') {
          return { ok: false, errorCode: 'mcp_sign_in_not_supported', error: 'mcp_sign_in_not_supported' };
        }
        const machineId = await ports.resolveAdministrationMachine?.(context);
        if (!machineId) return { ok: false, errorCode: 'no_machine_online', error: 'no_machine_online' };
        const service = await describe(machineId, 'credential_write');
        const account = service.accounts.find(profile => profile.ref.accountId === serverId
          && profile.ref.service.pluginId === signInService.pluginId && profile.ref.service.localId === signInService.localId);
        let attempt;
        if (account) {
          const target = { kind: 'account' as const, account: account.ref };
          const previous = await connected('connectedServices.configuration.get', { machineId, target });
          const replacement = await connected('connectedServices.configuration.replace', { machineId, target,
            expectedRevision: previous.configuration.revision, values: { ...previous.configuration.values, ...registrationValues,
              serverId, resource: canonicalMcpOAuthResourceUrlV1(server.remote.url), stepUp: stepUp === true, grantedScopes: account.scopes }, secretValues });
          attempt = await connected('connectedServices.authentication.beginReconnect', { machineId, account: account.ref,
            expectedConfigurationRevision: replacement.revision });
        } else {
          attempt = await connected('connectedServices.authentication.beginConnect', { machineId, service: signInService, modeId: 'oauth' });
          if (attempt.status === 'configurationRequired' && attempt.attemptId && attempt.target.kind === 'attempt') {
            const target = { kind: 'attempt' as const, attemptId: attempt.attemptId };
            const previous = await connected('connectedServices.configuration.get', { machineId, target });
            const replacement = await connected('connectedServices.configuration.replace', { machineId, target,
              expectedRevision: previous.configuration.revision, values: { ...previous.configuration.values, ...registrationValues,
                serverId, resource: canonicalMcpOAuthResourceUrlV1(server.remote.url), stepUp: stepUp === true }, secretValues });
            attempt = await connected('connectedServices.authentication.continueConnect', { machineId, attemptId: attempt.attemptId,
              expectedConfigurationRevision: replacement.revision });
          }
        }
        if (attempt.status === 'starting') {
          const attemptId = attempt.attemptId;
          try {
            attempt = await connected('connectedServices.authentication.read', { machineId, attemptId, waitForProviderStart: true });
          } catch (cause) {
            if (context.signal?.aborted) {
              try {
                // Closing this new flow removes caller cancellation only; the
                // captured Account/Home owner still fences the cleanup Action.
                await connected('connectedServices.authentication.cancel', { machineId, attemptId }, { ...context, signal: undefined });
              } catch { /* Preserve the interruption if cleanup is unavailable. */ }
            }
            throw cause;
          }
        }
        if (attempt.status !== 'awaitingOAuth' || !attempt.authorizationUrl || attempt.expiresAtMs === undefined) {
          const code = 'code' in attempt && (attempt.code === 'client_refused' || attempt.code === 'invalid_client' || attempt.code === 'mcp_oauth_resource_requires_https'
            || attempt.code === 'mcp_oauth_endpoints_require_https')
            ? attempt.code : 'mcp_sign_in_not_supported';
          return { ok: false, errorCode: code, error: code };
        }
        result = { attemptId: attempt.attemptId, authorizationUrl: attempt.authorizationUrl, expiresAtMs: attempt.expiresAtMs, machineId,
          ...(client && client.clientId !== MCP_OAUTH_CLIENT_METADATA_URL_V1
            && new URL(attempt.authorizationUrl).searchParams.get('client_id') === MCP_OAUTH_CLIENT_METADATA_URL_V1
            ? { clientRegistration: 'not_needed' as const } : {}) };
        break;
      }
      case 'mcp.servers.test': case 'mcp.found.list': {
        const payload = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const machineId = payload.machineId ?? await ports.resolveAdministrationMachine?.(context);
        if (!machineId) return projectMcpServerActionFailureV1({ code: 'no_machine_online' });
        result = await ports.machine({ actionId, input: { ...payload, machineId }, machineId, context }); break;
      }
    }
    return { ok: true, result: MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result) };
  };
}
