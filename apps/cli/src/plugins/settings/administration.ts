import { randomUUID } from 'node:crypto';

import {
  DaemonContributionRegistryProjectionDescribeRequestSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  DaemonPluginSettingsGetRequestSchema,
  DaemonPluginSettingsGetResponseSchema,
  DaemonPluginSettingsSetRequestSchema,
  DaemonPluginSettingsSetResponseSchema,
  DaemonPluginSecretDeleteRequestSchema,
  DaemonPluginSecretDeleteResponseSchema,
  DaemonPluginSecretStatusRequestSchema,
  DaemonPluginSecretStatusResponseSchema,
  PluginSettingsAdministrationActionInputSchemasV1,
  PluginSettingsAdministrationActionOutputV1Schema,
  StrictJsonValueSchema,
  type PluginProjectedSettingsFieldV2,
  type PluginProjectedSettingsV2,
  type PluginSettingsAdministrationActionIdV1,
  type PluginSettingsAdministrationActionOutputV1,
  type PluginSettingsAdministrationDaemonTargetV1,
  type PluginSettingsAdministrationTargetV1,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  readRpcErrorCode,
} from '@happier-dev/protocol/rpcErrors';
import { isPluginError, PluginError, type JsonValue, type PluginSettingDescriptor } from '@happier-dev/plugin-sdk';
import type { ScopedSettingsService, SettingsSnapshot } from '@happier-dev/plugin-sdk/settings';

import { resolvePluginInvocationLogTarget } from '@/cli/commands/pluginInvocationLogsMachine';
import { readStoredCredentials } from '@/persistence';
import { createAccountPluginSecretCustodyRouter } from '@/plugins/runtime/context/accountPluginSecretCustody';
import { collectDeclaredPluginSecrets } from '@/plugins/runtime/context/declaredPluginSecrets';
import { createAccountPluginSettingsRecordStorage } from '@/plugins/runtime/context/accountPluginSettingsRecordStorage';
import {
  createAccountSettingsBackedSettingsRecordStore,
  createRoutedPluginSettingsRecordStore,
  createStablePluginSettingsHost,
} from '@/plugins/runtime/invocation/services/settings';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveNotificationChannelSettingsContributions } from '@/plugins/settings/notificationChannelSettings';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import {
  callMachineRpc,
  readMachineRpcRequestDisposition,
} from '@/session/transport/rpc/machineRpc';

type ParsedActionInput = Readonly<{
  pluginId: string;
  localId?: string;
  scope?: Readonly<{ kind: 'account' | 'daemon' }>;
  target?: PluginSettingsAdministrationTargetV1;
  secretDaemonTarget?: PluginSettingsAdministrationDaemonTargetV1;
  value?: JsonValue;
  expectedRevision?: string;
  savedSecretId?: string;
}>;

export type ExecutePluginSettingsAdministrationAction = (params: Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  input: unknown;
  happyHomeDir?: string;
  /** Canonical host-stamped Action provenance; never derived from Action input. */
  actionCaller?: ActionExecutorContext['actionCaller'];
  signal?: AbortSignal;
}>) => Promise<PluginSettingsAdministrationActionOutputV1>;

class PluginSettingsAdministrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginSettingsAdministrationError';
  }
}

function administrationError(code: string, message: string): never {
  throw new PluginSettingsAdministrationError(code, message);
}

function result(
  kind: PluginSettingsAdministrationActionIdV1,
  data: Readonly<Record<string, JsonValue>>,
  application?: 'live',
): PluginSettingsAdministrationActionOutputV1 {
  const projected = application === undefined
    ? data
    : Object.freeze({
      ...data,
      application: Object.freeze({ kind: application }),
    });
  return PluginSettingsAdministrationActionOutputV1Schema.parse({ ok: true, kind, data: projected });
}

function failure(
  kind: PluginSettingsAdministrationActionIdV1,
  code: string,
  message: string,
): PluginSettingsAdministrationActionOutputV1 {
  return PluginSettingsAdministrationActionOutputV1Schema.parse({ ok: false, kind, errorCode: code, error: message });
}

function signalFor(signal?: AbortSignal): AbortSignal {
  return signal ?? new AbortController().signal;
}

function assertCurrent(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function readSafePluginErrorCode(error: unknown): string | null {
  if (error instanceof PluginSettingsAdministrationError) return error.code;
  if (isPluginError(error)) return error.code;
  return null;
}

function normalizeFailure(error: unknown): Readonly<{ code: string; message: string }> {
  const code = readSafePluginErrorCode(error);
  switch (code) {
    case 'not_authenticated':
      return { code, message: 'Sign in before administering Plugin Settings.' };
    case 'plugin_settings_revision_conflict':
      return { code, message: 'Plugin Settings changed before this mutation could be applied.' };
    case 'plugin_secret_revision_conflict':
      return { code, message: 'Plugin secret changed before this mutation could be applied.' };
    case 'plugin_settings_outcome_unknown':
    case 'plugin_secret_outcome_unknown':
      return { code, message: 'The mutation may have reached its owner; read current status before retrying.' };
    case 'plugin_settings_daemon_unsupported':
      return { code, message: 'The selected daemon does not support Plugin Settings administration.' };
    case 'plugin_settings_target_not_current':
      return { code, message: 'The selected daemon is no longer the current exact target.' };
    case 'plugin_settings_unknown_key':
      return { code, message: 'That Plugin Setting is not declared for the selected scope.' };
    case 'plugin_secret_undeclared':
      return { code, message: 'That Plugin secret is not declared.' };
    case 'plugin_settings_secret_binding_unavailable':
      return { code, message: 'That Plugin secret cannot be bound to a SavedSecret.' };
    case 'plugin_settings_daemon_secret_target_required':
      return { code, message: 'Daemon Plugin secrets require one exact selected machine.' };
    case 'plugin_settings_unavailable':
    case 'plugin_settings_daemon_unavailable':
    case 'plugin_secret_custody_unavailable':
    case 'plugin_secret_custody_locked':
      return { code, message: 'Plugin Settings administration is unavailable.' };
    default:
      return { code: 'plugin_settings_unavailable', message: 'Plugin Settings administration is unavailable.' };
  }
}

async function currentCredentials(signal?: AbortSignal) {
  assertCurrent(signal);
  const credentials = await readStoredCredentials();
  assertCurrent(signal);
  if (!credentials) {
    administrationError('not_authenticated', 'Authentication is required.');
  }
  return credentials;
}

async function revalidateDaemonTarget(
  target: PluginSettingsAdministrationDaemonTargetV1,
  signal?: AbortSignal,
): Promise<void> {
  assertCurrent(signal);
  const resolution = await resolvePluginInvocationLogTarget({
    requestedMachineId: target.machineId,
    ...(signal ? { signal } : {}),
  });
  assertCurrent(signal);
  if (
    resolution.kind !== 'selected'
    || resolution.target.machineId !== target.machineId
    || resolution.target.serverIdentityId !== target.serverIdentityId
  ) {
    administrationError('plugin_settings_target_not_current', 'The selected daemon target is no longer current.');
  }
}

async function callDaemonRpc(params: Readonly<{
  target: PluginSettingsAdministrationDaemonTargetV1;
  method: string;
  request: unknown;
  write?: boolean;
  outcomeUnknownCode?: string;
  signal?: AbortSignal;
}>): Promise<unknown> {
  const credentials = await currentCredentials(params.signal);
  try {
    const response = await callMachineRpc({
      credentials,
      machineId: params.target.machineId,
      method: params.method,
      request: params.request,
      timeoutMs: 30_000,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    assertCurrent(params.signal);
    return response;
  } catch (error) {
    assertCurrent(params.signal);
    if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
      administrationError('plugin_settings_daemon_unsupported', 'The selected daemon does not support this Settings operation.');
    }
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode) {
      administrationError(rpcErrorCode, 'The selected daemon rejected this Settings operation.');
    }
    if (params.write && readMachineRpcRequestDisposition(error) === 'outcomeUnknown') {
      administrationError(
        params.outcomeUnknownCode ?? 'plugin_settings_outcome_unknown',
        'The daemon write outcome is unknown.',
      );
    }
    administrationError('plugin_settings_daemon_unavailable', 'The selected daemon is unavailable.');
  }
}

type DaemonSettingsProjection = Readonly<{
  settings: ReadonlyArray<PluginProjectedSettingsV2>;
}>;

async function daemonSettingsProjection(params: Readonly<{
  target: PluginSettingsAdministrationDaemonTargetV1;
  pluginId: string;
  scope: Readonly<{ kind: 'account' | 'daemon' }>;
  signal?: AbortSignal;
}>): Promise<DaemonSettingsProjection> {
  await revalidateDaemonTarget(params.target, params.signal);
  const raw = await callDaemonRpc({
    target: params.target,
    method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    request: DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: params.target.machineId,
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const response = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(raw);
  if (!response.success || response.data.projection.v !== 2) {
    administrationError('plugin_settings_daemon_unsupported', 'The selected daemon has no current Settings projection.');
  }
  const settings = Object.values(response.data.projection.settingsById).filter((candidate) => (
    candidate.pluginId === params.pluginId
    && candidate.scope.kind === params.scope.kind
  ));
  if (settings.length === 0) {
    administrationError('plugin_settings_unavailable', 'The selected Settings scope is not declared on that daemon.');
  }
  return Object.freeze({ settings: Object.freeze(settings) });
}

function findDaemonField(
  projection: DaemonSettingsProjection,
  localId: string,
): PluginProjectedSettingsFieldV2 {
  const matches = projection.settings.flatMap((settings) => (
    settings.fields.filter((field) => field.id === localId)
  ));
  if (matches.length !== 1) {
    administrationError('plugin_settings_unknown_key', 'The requested Settings field is not uniquely declared.');
  }
  return matches[0]!;
}

/**
 * The one effective-value rule for a daemon Settings read. A daemon snapshot is
 * sparse: it carries only written values, so an absent key means "never
 * written" and resolves to the declared default, while a stored explicit JSON
 * null stays null. This mirrors the Account-scope `ScopedSettingsService.get`
 * contract so both administration scopes report the same effective value for
 * the same declaration.
 */
function effectiveDaemonFieldValue(
  field: PluginProjectedSettingsFieldV2,
  values: Readonly<Record<string, unknown>>,
): JsonValue {
  const raw = Object.prototype.hasOwnProperty.call(values, field.id)
    ? values[field.id]
    : field.defaultValue;
  if (raw === undefined) return null;
  const parsed = StrictJsonValueSchema.safeParse(raw);
  if (!parsed.success) {
    administrationError('plugin_settings_daemon_unsupported', 'The daemon returned an invalid Settings value.');
  }
  return parsed.data;
}

async function daemonSnapshot(params: Readonly<{
  target: PluginSettingsAdministrationDaemonTargetV1;
  pluginId: string;
  scope: Readonly<{ kind: 'daemon' }>;
  signal?: AbortSignal;
}>) {
  await revalidateDaemonTarget(params.target, params.signal);
  const raw = await callDaemonRpc({
    target: params.target,
    method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET,
    request: DaemonPluginSettingsGetRequestSchema.parse({
      serverIdentityId: params.target.serverIdentityId,
      machineId: params.target.machineId,
      pluginId: params.pluginId,
      scope: params.scope,
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const response = DaemonPluginSettingsGetResponseSchema.safeParse(raw);
  if (
    !response.success
    || response.data.pluginId !== params.pluginId
    || response.data.scope.kind !== params.scope.kind
  ) {
    administrationError('plugin_settings_daemon_unsupported', 'The selected daemon returned an invalid Settings response.');
  }
  return response.data;
}

async function daemonMutation(params: Readonly<{
  target: PluginSettingsAdministrationDaemonTargetV1;
  pluginId: string;
  scope: Readonly<{ kind: 'daemon' }>;
  localId: string;
  mutation: Readonly<{ kind: 'set'; value: JsonValue }> | Readonly<{ kind: 'delete' }>;
  expectedRevision?: string;
  signal?: AbortSignal;
}>) {
  await revalidateDaemonTarget(params.target, params.signal);
  const raw = await callDaemonRpc({
    target: params.target,
    method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
    request: DaemonPluginSettingsSetRequestSchema.parse({
      serverIdentityId: params.target.serverIdentityId,
      machineId: params.target.machineId,
      pluginId: params.pluginId,
      scope: params.scope,
      fieldId: params.localId,
      mutation: params.mutation,
      ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
    }),
    write: true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const response = DaemonPluginSettingsSetResponseSchema.safeParse(raw);
  if (!response.success) {
    administrationError('plugin_settings_daemon_unsupported', 'The selected daemon returned an invalid Settings mutation response.');
  }
  const { snapshot } = response.data;
  if (
    snapshot.pluginId !== params.pluginId
    || snapshot.scope.kind !== params.scope.kind
  ) {
    administrationError('plugin_settings_daemon_unsupported', 'The selected daemon returned an invalid Settings mutation response.');
  }
  return snapshot;
}

async function daemonSecretStatus(params: Readonly<{
  target: PluginSettingsAdministrationDaemonTargetV1;
  pluginId: string;
  localId: string;
  signal?: AbortSignal;
}>) {
  await revalidateDaemonTarget(params.target, params.signal);
  const raw = await callDaemonRpc({
    target: params.target,
    method: RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS,
    request: DaemonPluginSecretStatusRequestSchema.parse({
      serverIdentityId: params.target.serverIdentityId,
      machineId: params.target.machineId,
      pluginId: params.pluginId,
      secretId: params.localId,
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const response = DaemonPluginSecretStatusResponseSchema.safeParse(raw);
  if (
    !response.success
    || response.data.pluginId !== params.pluginId
    || response.data.secretId !== params.localId
  ) {
    administrationError('plugin_settings_daemon_unsupported', 'The selected daemon returned an invalid secret status response.');
  }
  return response.data;
}

async function daemonSecretDelete(params: Readonly<{
  target: PluginSettingsAdministrationDaemonTargetV1;
  pluginId: string;
  localId: string;
  expectedRevision?: string;
  signal?: AbortSignal;
}>) {
  await revalidateDaemonTarget(params.target, params.signal);
  const raw = await callDaemonRpc({
    target: params.target,
    method: RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE,
    request: DaemonPluginSecretDeleteRequestSchema.parse({
      serverIdentityId: params.target.serverIdentityId,
      machineId: params.target.machineId,
      pluginId: params.pluginId,
      secretId: params.localId,
      ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
    }),
    write: true,
    outcomeUnknownCode: 'plugin_secret_outcome_unknown',
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const response = DaemonPluginSecretDeleteResponseSchema.safeParse(raw);
  if (
    !response.success
    || response.data.pluginId !== params.pluginId
    || response.data.secretId !== params.localId
  ) {
    administrationError('plugin_settings_daemon_unsupported', 'The selected daemon returned an invalid secret deletion response.');
  }
  return response.data;
}

function projectDescriptor(descriptor: PluginSettingDescriptor): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    localId: descriptor.id,
    title: descriptor.title,
    ...(descriptor.description ? { description: descriptor.description } : {}),
    ...(descriptor.secret ? { secret: true } : { secret: false }),
  });
}

function effectiveAccountFieldValue(
  descriptor: PluginSettingDescriptor,
  values: Readonly<Record<string, JsonValue>>,
): JsonValue {
  if (Object.prototype.hasOwnProperty.call(values, descriptor.id)) return values[descriptor.id]!;
  return descriptor.secret || descriptor.default === undefined ? null : descriptor.default;
}

/** Projects one atomic Account snapshot into the generic administration view. */
export function projectAccountSettingsAdministrationSnapshot(params: Readonly<{
  descriptors: readonly PluginSettingDescriptor[];
  hiddenFieldIds: ReadonlySet<string>;
  snapshot: SettingsSnapshot;
}>): Readonly<{
  scope: SettingsSnapshot['scope'];
  revision: string;
  fields: readonly Readonly<Record<string, JsonValue>>[];
}> {
  const fields = params.descriptors.flatMap((descriptor) => {
    if (params.hiddenFieldIds.has(descriptor.id)) return [];
    return [descriptor.secret
      ? projectDescriptor(descriptor)
      : Object.freeze({
        ...projectDescriptor(descriptor),
        value: effectiveAccountFieldValue(descriptor, params.snapshot.values),
      })];
  });
  return Object.freeze({
    scope: params.snapshot.scope,
    revision: params.snapshot.revision,
    fields: Object.freeze(fields),
  });
}

async function accountSettingsService(params: Readonly<{
  pluginId: string;
  happyHomeDir?: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  service: ScopedSettingsService;
  hiddenFieldIds: ReadonlySet<string>;
}>> {
  const credentials = await currentCredentials(params.signal);
  await bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
    honorAccountSettingsModeEnv: false,
    shouldCommit: () => !params.signal?.aborted,
  });
  assertCurrent(params.signal);
  const registry = await resolveMergedContributionRegistry({
    ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
  });
  assertCurrent(params.signal);
  const target = registry.activationTargets.find((candidate) => candidate.pluginId === params.pluginId);
  if (!target) {
    administrationError('plugin_settings_unavailable', 'The requested plugin is not installed.');
  }
  const declarations = [
    ...(registry.settings ?? []),
    ...resolveNotificationChannelSettingsContributions(registry.notificationChannels ?? []),
  ].flatMap((candidate) => (
    candidate.pluginId === params.pluginId
      ? [Object.freeze({ pluginId: params.pluginId, contribution: candidate.definition })]
      : []
  ));
  const hiddenFieldIds = new Set(declarations.flatMap(({ contribution }) => (
    contribution.fields.flatMap((field) => (
      field.presentation?.binding?.kind === 'perActiveServer'
        ? [field.presentation.binding.byServerIdSettingId]
        : []
    ))
  )));
  const host = createStablePluginSettingsHost({
    declarations,
    // This declaration set covers exactly the requested plugin, so there is
    // nothing to isolate it from: rethrow so the author keeps the precise
    // authoring error instead of a generic "no Settings service".
    onPluginSettingsUnavailable({ error }) {
      throw error;
    },
    recordStore: createRoutedPluginSettingsRecordStore([
      createAccountSettingsBackedSettingsRecordStore(
        createAccountPluginSettingsRecordStorage(),
      ),
    ]),
    broker: createStablePluginEventsBroker(),
  });
  const signal = signalFor(params.signal);
  const service = host.bind({
    plugin: { id: params.pluginId, version: target.manifest.version },
    contribution: { id: 'settings-administration', qualifiedId: `${params.pluginId}/settings-administration` },
    generation: 'settings-administration-v1',
    correlationId: randomUUID(),
    surface: 'cli',
    signal,
    isGenerationCurrent: () => !signal.aborted,
  });
  if (!service) {
    administrationError('plugin_settings_unavailable', 'The requested plugin has no Settings service.');
  }
  return Object.freeze({
    service: service.forScope({ kind: 'account' }),
    hiddenFieldIds,
  });
}

async function currentSecretDeclaration(params: Readonly<{
  pluginId: string;
  localId: string;
  happyHomeDir?: string;
  signal?: AbortSignal;
}>) {
  assertCurrent(params.signal);
  const registry = await resolveMergedContributionRegistry({
    ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
  });
  assertCurrent(params.signal);
  // The collection spans every installed plugin, so another plugin's
  // contradictory manifest must not deny this command its answer.
  let requestedSecretRefused = false;
  const declaration = collectDeclaredPluginSecrets(registry.activationTargets, {
    onSecretDeclarationRefused({ pluginId, secretId }) {
      if (pluginId === params.pluginId && secretId === params.localId) requestedSecretRefused = true;
    },
  }).find((candidate) => (
    candidate.pluginId === params.pluginId && candidate.declaration.id === params.localId
  ));
  if (requestedSecretRefused) {
    administrationError(
      'plugin_secret_custody_unavailable',
      'The requested plugin secret declares conflicting custody and cannot be bound.',
    );
  }
  if (!declaration) {
    administrationError('plugin_secret_undeclared', 'The requested plugin secret is not declared.');
  }
  return declaration.declaration;
}

type CurrentPluginSecretDeclaration = Awaited<ReturnType<typeof currentSecretDeclaration>>;

async function accountSecretCustody(params: Readonly<{
  pluginId: string;
  declaration: CurrentPluginSecretDeclaration;
  signal?: AbortSignal;
}>) {
  if (params.declaration.custody !== 'account') {
    administrationError('plugin_secret_custody_unavailable', 'Account secret custody was not declared for this secret.');
  }
  const credentials = await currentCredentials(params.signal);
  await bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
    honorAccountSettingsModeEnv: false,
    shouldCommit: () => !params.signal?.aborted,
  });
  assertCurrent(params.signal);
  const router = createAccountPluginSecretCustodyRouter();
  const custody = router.resolve({
    pluginId: params.pluginId,
    declaration: params.declaration,
  });
  if (!custody) {
    administrationError('plugin_secret_custody_unavailable', 'Account secret custody is unavailable.');
  }
  return Object.freeze({
    router,
    secret: custody,
  });
}

type ScopedSettingsInput =
  | Readonly<{
      kind: 'account';
      scope: Readonly<{ kind: 'account' }>;
      target: Extract<PluginSettingsAdministrationTargetV1, Readonly<{ kind: 'account' }>>;
    }>
  | Readonly<{
      kind: 'daemon';
      scope: Readonly<{ kind: 'daemon' }>;
      target: PluginSettingsAdministrationDaemonTargetV1;
    }>;

function requireScopedInput(input: ParsedActionInput): ScopedSettingsInput {
  if (input.scope?.kind === 'account' && input.target?.kind === 'account') {
    return Object.freeze({
      kind: 'account',
      scope: Object.freeze({ kind: 'account' }),
      target: input.target,
    });
  }
  if (input.scope?.kind === 'daemon' && input.target?.kind === 'daemon') {
    return Object.freeze({
      kind: 'daemon',
      scope: Object.freeze({ kind: 'daemon' }),
      target: input.target,
    });
  }
  administrationError('plugin_settings_unavailable', 'A matching Settings scope and target are required.');
}

function requireLocalId(input: ParsedActionInput): string {
  if (!input.localId) administrationError('plugin_settings_unknown_key', 'A Settings field id is required.');
  return input.localId;
}

function requireDaemonSecretTarget(input: ParsedActionInput): PluginSettingsAdministrationDaemonTargetV1 {
  if (input.scope?.kind === 'daemon' && input.target?.kind === 'daemon') {
    return input.target;
  }
  if (input.secretDaemonTarget) return input.secretDaemonTarget;
  administrationError(
    'plugin_settings_daemon_secret_target_required',
    'Daemon secret administration requires one exact daemon target.',
  );
}

async function executeSettingsAction(params: Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  input: ParsedActionInput;
  happyHomeDir?: string;
  signal?: AbortSignal;
}>): Promise<PluginSettingsAdministrationActionOutputV1> {
  const scoped = requireScopedInput(params.input);
  if (scoped.kind === 'daemon') {
    const projection = await daemonSettingsProjection({
      target: scoped.target,
      pluginId: params.input.pluginId,
      scope: scoped.scope,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (params.actionId === 'plugins.settings.list') {
      const snapshot = await daemonSnapshot({
        target: scoped.target,
        pluginId: params.input.pluginId,
        scope: scoped.scope,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const fields = projection.settings.flatMap((settings) => settings.fields.map((field) => Object.freeze({
        localId: field.id,
        secret: field.secretCustody !== null,
        ...(field.secretCustody === null
          ? { value: effectiveDaemonFieldValue(field, snapshot.values) }
          : {}),
      })));
      return result(params.actionId, Object.freeze({
        scope: scoped.scope,
        target: scoped.target,
        revision: snapshot.revision,
        fields,
      }));
    }
    const localId = requireLocalId(params.input);
    const field = findDaemonField(projection, localId);
    if (field.secretCustody !== null) {
      administrationError('plugin_settings_unknown_key', 'Secret fields are administered through the secret commands.');
    }
    if (params.actionId === 'plugins.settings.get') {
      const snapshot = await daemonSnapshot({
        target: scoped.target,
        pluginId: params.input.pluginId,
        scope: scoped.scope,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return result(params.actionId, Object.freeze({
        scope: scoped.scope,
        target: scoped.target,
        localId,
        revision: snapshot.revision,
        value: effectiveDaemonFieldValue(field, snapshot.values),
      }));
    }
    const mutation = params.actionId === 'plugins.settings.set'
      ? { kind: 'set' as const, value: params.input.value! }
      : { kind: 'delete' as const };
    const next = await daemonMutation({
      target: scoped.target,
      pluginId: params.input.pluginId,
      scope: scoped.scope,
      localId,
      mutation,
      ...(params.input.expectedRevision === undefined ? {} : { expectedRevision: params.input.expectedRevision }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return result(params.actionId, Object.freeze({
      scope: scoped.scope,
      target: scoped.target,
      localId,
      revision: next.revision,
    }), 'live');
  }

  const account = await accountSettingsService({
    pluginId: params.input.pluginId,
    ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const { service } = account;
  if (params.actionId === 'plugins.settings.list') {
    const snapshot = await service.snapshot({ ...(params.signal ? { signal: params.signal } : {}) });
    const projection = projectAccountSettingsAdministrationSnapshot({
      descriptors: service.describe(),
      hiddenFieldIds: account.hiddenFieldIds,
      snapshot,
    });
    return result(params.actionId, Object.freeze({
      ...projection,
      target: scoped.target,
    }));
  }
  const localId = requireLocalId(params.input);
  const descriptor = service.describe().find((candidate) => candidate.id === localId);
  if (!descriptor || descriptor.secret || account.hiddenFieldIds.has(localId)) {
    administrationError('plugin_settings_unknown_key', 'The requested non-secret Settings field is not declared.');
  }
  if (params.actionId === 'plugins.settings.get') {
    const snapshot = await service.snapshot({ ...(params.signal ? { signal: params.signal } : {}) });
    return result(params.actionId, Object.freeze({
      scope: snapshot.scope,
      target: scoped.target,
      localId,
      revision: snapshot.revision,
      value: effectiveAccountFieldValue(descriptor, snapshot.values),
    }));
  }
  const next = params.actionId === 'plugins.settings.set'
    ? await service.set(localId, params.input.value!, {
      ...(params.input.expectedRevision === undefined ? {} : { expectedRevision: params.input.expectedRevision }),
      ...(params.signal ? { signal: params.signal } : {}),
    })
    : await service.reset(localId, {
      ...(params.input.expectedRevision === undefined ? {} : { expectedRevision: params.input.expectedRevision }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  return result(params.actionId, Object.freeze({
    scope: next.scope,
    target: scoped.target,
    localId,
    revision: next.revision,
  }), 'live');
}

async function executeSecretAction(params: Readonly<{
  actionId: PluginSettingsAdministrationActionIdV1;
  input: ParsedActionInput;
  happyHomeDir?: string;
  signal?: AbortSignal;
}>): Promise<PluginSettingsAdministrationActionOutputV1> {
  const localId = requireLocalId(params.input);
  const declaration = await currentSecretDeclaration({
    pluginId: params.input.pluginId,
    localId,
    ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (declaration.custody === 'account') {
    const resolved = await accountSecretCustody({
      pluginId: params.input.pluginId,
      declaration,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (params.actionId === 'plugins.settings.secret.status') {
      const status = await resolved.secret.status(localId);
      assertCurrent(params.signal);
      return result(params.actionId, Object.freeze({
        localId,
        custody: 'account',
        target: { kind: 'account' },
        state: status.state,
        revision: status.revision,
      }));
    }
    if (params.actionId === 'plugins.settings.secret.bind') {
      if (!params.input.savedSecretId) {
        administrationError('plugin_settings_unavailable', 'An existing SavedSecret id is required.');
      }
      const bound = await resolved.router.bindExisting({
        pluginId: params.input.pluginId,
        secretId: localId,
        savedSecretId: params.input.savedSecretId,
        ...(params.input.expectedRevision === undefined ? {} : { expectedRevision: params.input.expectedRevision }),
        assertCurrent: () => assertCurrent(params.signal),
      });
      return result(params.actionId, Object.freeze({
        localId,
        custody: 'account',
        target: { kind: 'account' },
        revision: bound.revision,
      }), 'live');
    }
    if (params.actionId === 'plugins.settings.secret.unbind') {
      const unbound = await resolved.router.unbind({
        pluginId: params.input.pluginId,
        secretId: localId,
        ...(params.input.expectedRevision === undefined ? {} : { expectedRevision: params.input.expectedRevision }),
        assertCurrent: () => assertCurrent(params.signal),
      });
      return result(params.actionId, Object.freeze({
        localId,
        custody: 'account',
        target: { kind: 'account' },
        revision: unbound.revision,
      }), 'live');
    }
    const next = await resolved.secret.delete({
      secretId: localId,
      ...(params.input.expectedRevision === undefined ? {} : { expectedRevision: params.input.expectedRevision }),
      assertCurrent: () => assertCurrent(params.signal),
    });
    return result(params.actionId, Object.freeze({
      localId,
      custody: 'account',
      target: { kind: 'account' },
      revision: next.revision,
    }), 'live');
  }

  if (
    params.actionId === 'plugins.settings.secret.bind'
    || params.actionId === 'plugins.settings.secret.unbind'
  ) {
    administrationError('plugin_settings_secret_binding_unavailable', 'Daemon secrets cannot bind Account SavedSecrets.');
  }
  const target = requireDaemonSecretTarget(params.input);
  if (params.actionId === 'plugins.settings.secret.status') {
    const status = await daemonSecretStatus({
      target,
      pluginId: params.input.pluginId,
      localId,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return result(params.actionId, Object.freeze({
      localId,
      custody: 'daemon',
      target,
      state: status.state,
      revision: status.revision,
    }));
  }
  const next = await daemonSecretDelete({
    target,
    pluginId: params.input.pluginId,
    localId,
    ...(params.input.expectedRevision === undefined ? {} : { expectedRevision: params.input.expectedRevision }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return result(params.actionId, Object.freeze({
    localId,
    custody: 'daemon',
    target,
    state: next.state,
    revision: next.revision,
  }), 'live');
}

export const executePluginSettingsAdministrationAction: ExecutePluginSettingsAdministrationAction = async (params) => {
  assertCurrent(params.signal);
  const parsed = PluginSettingsAdministrationActionInputSchemasV1[params.actionId].safeParse(params.input);
  if (!parsed.success) {
    return failure(params.actionId, 'invalid_arguments', 'Plugin Settings action input is invalid.');
  }
  const input = parsed.data as ParsedActionInput;
  try {
    const isSecretAction = params.actionId.startsWith('plugins.settings.secret.');
    return await (isSecretAction ? executeSecretAction : executeSettingsAction)({
      actionId: params.actionId,
      input,
      ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    if (params.signal?.aborted) throw error;
    const normalized = normalizeFailure(error);
    return failure(params.actionId, normalized.code, normalized.message);
  }
};
