import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isLegacyConfiguredAcpFlavorCarrier } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import type { AccountProfile, ActionExecutorContext, ActionExecutorDeps, BackendTargetRefV2 } from '@happier-dev/protocol';
import axios from 'axios';
import { configuration } from '@/configuration';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { AgentModelsProbeObservationSchema, AgentSessionModesProbeObservationSchema,
  AgentConfigOptionsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { connectedServiceProfileKey, legacyCustomAcpCompat } from '@happier-dev/agents';

import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import { readSettings, type StoredCredentials } from '@/persistence';
import type { ProbedAgentModelsResult } from '@/capabilities/probes/agentModelsProbe';
import type { ProbedAgentModesResult } from '@/capabilities/probes/agentModesProbe';
import type { ProbedAgentConfigOptionsResult } from '@/capabilities/probes/agentConfigOptionsProbe';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AcpCatalogUnavailableError, requireReadyAcpCatalog } from '@/agent/acp/catalog/configured/resolveBackend';
import { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { createCliBoundSessionMetadataReader } from '../resolveCliActionCallerSession';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { listServerProfiles } from '@/server/serverProfiles';
import { projectProfilesListForActions } from '@/settings/profiles/profileListProjection';
import { readAccountLaunchProfiles, readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { ConnectedServicesDefaultUnavailableError, resolveSpawnConnectedServicesDefaults } from '@/session/services/spawnConnectedServicesDefaults';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { createCliConnectedMetadataStore } from '@/settings/connected/connectedMetadataStore';
import { refreshActiveConnectedMetadataCatalog } from '@/settings/connected/hydrateConnectedMetadataCatalog';
import { connectedEntitySubjectKeyV1, projectConnectedPresentationLabelsV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { fetchAccountProfile } from '@/api/accountProfile';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import { prepareActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SpawnMcpPreviewInventoryDeps } from './resolveSpawnMcpServersPreviewInventory';
import {
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

import {
  normalizeLimit,
  readSessionModelsState,
  readSessionModesState,
} from './sessionStateReaders';

type ModelInventoryItem = Readonly<{
  id: string;
  label: string;
  description?: string;
}>;

type ModeInventoryItem = Readonly<{
  id: string;
  label: string;
  description?: string;
}>;

type ConfigOptionDefinitionItem = Readonly<{
  id: string;
  label: string;
  description?: string;
  type: string;
  options?: readonly Readonly<{
    value: string | number | boolean | null;
    label: string;
    description?: string;
  }>[];
}>;

function normalizeStringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringValueOrNull(value: unknown): string | null {
  const normalized = normalizeStringValue(value);
  return normalized.length > 0 ? normalized : null;
}

function modelInventoryItemFromModel(entry: Readonly<{
  id?: unknown;
  name?: unknown;
  description?: unknown;
}>): ModelInventoryItem | null {
  const modelId = normalizeStringValue(entry.id);
  if (!modelId) return null;
  const label = normalizeStringValue(entry.name) || modelId;
  const description = normalizeStringValue(entry.description);
  return {
    id: modelId,
    label,
    ...(description ? { description } : {}),
  };
}

function modelInventoryItemsFromProbeResult(result: ProbedAgentModelsResult): readonly ModelInventoryItem[] {
  return result.availableModels
    .map((entry) => modelInventoryItemFromModel(entry))
    .filter((entry): entry is ModelInventoryItem => entry !== null);
}

function modelInventoryItemsFromSessionModels(models: readonly Readonly<{
  id?: unknown;
  name?: unknown;
  description?: unknown;
}>[]): readonly ModelInventoryItem[] {
  return [
    { id: 'default', label: 'Default' },
    ...models
      .map((entry) => modelInventoryItemFromModel(entry))
      .filter((entry): entry is ModelInventoryItem => entry !== null),
  ];
}

function modeInventoryItemFromMode(entry: Readonly<{
  id?: unknown;
  name?: unknown;
  description?: unknown;
}>): ModeInventoryItem | null {
  const modeId = normalizeStringValue(entry.id);
  if (!modeId) return null;
  const label = normalizeStringValue(entry.name) || modeId;
  const description = normalizeStringValue(entry.description);
  return {
    id: modeId,
    label,
    ...(description ? { description } : {}),
  };
}

function modeInventoryItemsFromProbeResult(result: ProbedAgentModesResult): readonly ModeInventoryItem[] {
  return result.availableModes
    .map((entry) => modeInventoryItemFromMode(entry))
    .filter((entry): entry is ModeInventoryItem => entry !== null);
}

function configOptionDefinitionsFromProbeResult(
  result: ProbedAgentConfigOptionsResult,
): readonly ConfigOptionDefinitionItem[] {
  return result.configOptions
    .map((entry): ConfigOptionDefinitionItem | null => {
      const id = normalizeStringValue(entry.id);
      if (!id) return null;
      const label = normalizeStringValue(entry.name) || id;
      const type = normalizeStringValue(entry.type) || 'unknown';
      const description = normalizeStringValue(entry.description);
      const options = Array.isArray(entry.options)
        ? entry.options
          .map((choice) => {
            const choiceLabel = normalizeStringValue(choice.name);
            if (!choiceLabel) return null;
            return {
              value: choice.value,
              label: choiceLabel,
              ...(normalizeStringValue(choice.description) ? { description: normalizeStringValue(choice.description) } : {}),
            };
          })
          .filter((choice): choice is NonNullable<typeof choice> => choice !== null)
        : [];
      return {
        id,
        label,
        ...(description ? { description } : {}),
        type,
        ...(options.length > 0 ? { options } : {}),
      };
    })
    .filter((entry): entry is ConfigOptionDefinitionItem => entry !== null);
}

function dedupeById<T extends Readonly<{ id: string }>>(items: readonly T[]): readonly T[] {
  return items.filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
}

function limitItems<T>(items: readonly T[], limit: unknown): readonly T[] {
  const bounded = normalizeLimit(limit);
  return bounded ? items.slice(0, bounded) : items;
}

type AgentProbeInventoryDeps = Readonly<{
  probeAgentModelsBestEffort: (args: unknown) => Promise<unknown>;
  probeAgentModesBestEffort: (args: unknown) => Promise<unknown>;
  probeAgentConfigOptionsBestEffort: (args: unknown) => Promise<unknown>;
}>;

function readBackendTargetKey(args: Readonly<{ backendTargetKey?: unknown }>): string {
  return typeof args.backendTargetKey === 'string' ? args.backendTargetKey.trim() : '';
}

function readBackendTargetFromKey(backendTargetKey: string): BackendTargetRefV2 | null {
  if (!backendTargetKey) return null;
  try {
    return readBackendTargetRefV2(backendTargetKey);
  } catch {
    return null;
  }
}

function resolveProbeAgentId(params: Readonly<{
  agentId: string;
  backendTarget: BackendTargetRefV2 | null;
}>): string {
  if (params.backendTarget?.sourceKind === 'configured' || Boolean(params.backendTarget?.configuredBackendId)) {
    return 'customAcp';
  }
  return params.agentId || normalizeStringValue(params.backendTarget?.backendId);
}

function machineTargetCanUseLocalProbe(params: Readonly<{
  requestedMachineId: unknown;
  rawSession?: Readonly<{
    host?: unknown;
    machineId?: unknown;
  }> | null;
}>): boolean {
  const requestedMachineId = normalizeStringValue(params.requestedMachineId);
  if (!requestedMachineId) return true;

  const sessionMachineId = normalizeStringValue(params.rawSession?.machineId);
  const sessionHost = normalizeStringValue(params.rawSession?.host);
  if (!sessionMachineId && !sessionHost) return true;

  return requestedMachineId === sessionMachineId || requestedMachineId === sessionHost;
}

async function probeActionModelsBestEffort(params: Readonly<{
  args: Parameters<NonNullable<ActionExecutorDeps['agentsModelsList']>>[0];
  agentId: string;
  backendTarget: BackendTargetRefV2 | null;
  rawSession?: Readonly<{
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
  }> | null;
  accountSettings: import('@happier-dev/protocol').AccountSettings | null;
  credentials: StoredCredentials | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  probeDeps?: AgentProbeInventoryDeps;
}>): Promise<ProbedAgentModelsResult | null> {
  const probeAgentId = resolveProbeAgentId({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
  });
  if (!legacyCustomAcpCompat.isAgentLookupId(probeAgentId)) return null;
  if (!machineTargetCanUseLocalProbe({
    requestedMachineId: (params.args as { machineId?: unknown }).machineId,
    rawSession: params.rawSession,
  })) {
    return null;
  }

  const probe = params.args.probe;
  const cwd = normalizeStringValue(probe?.cwd) || normalizeStringValue(params.rawSession?.path) || process.cwd();
  try {
    const probeAgentModelsBestEffort = params.probeDeps?.probeAgentModelsBestEffort
      ?? (await import('./resolveAgentProbeInventoryDeps')).probeAgentModelsBestEffort;
    return await probeAgentModelsBestEffort({
      agentId: probeAgentId,
      ...(params.backendTarget ? { backendTarget: convertBackendTargetRefV2ToV1(params.backendTarget) } : {}),
      cwd,
      ...(probe?.timeoutMs !== undefined ? { timeoutMs: probe.timeoutMs } : {}),
      ...(probe?.runtimeDescriptorV1 ? { runtimeDescriptorV1: probe.runtimeDescriptorV1 } : {}),
      ...(probe?.bypassCache !== undefined ? { bypassCache: probe.bypassCache } : {}),
      accountSettings: params.accountSettings,
      credentials: params.credentials,
      acpCatalogSnapshot: params.acpCatalogSnapshot,
      savedSecretOperationContext: params.savedSecretOperationContext,
    }) as ProbedAgentModelsResult;
  } catch (error) {
    if (error instanceof AcpCatalogUnavailableError) throw error;
    return null;
  }
}

async function probeActionModesBestEffort(params: Readonly<{
  args: Parameters<NonNullable<ActionExecutorDeps['agentsSessionModesList']>>[0];
  agentId: string;
  backendTarget: BackendTargetRefV2 | null;
  rawSession?: Readonly<{
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
  }> | null;
  accountSettings: import('@happier-dev/protocol').AccountSettings | null;
  credentials: StoredCredentials | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  probeDeps?: AgentProbeInventoryDeps;
}>): Promise<ProbedAgentModesResult | null> {
  const probeAgentId = resolveProbeAgentId({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
  });
  if (!legacyCustomAcpCompat.isAgentLookupId(probeAgentId)) return null;
  if (!machineTargetCanUseLocalProbe({
    requestedMachineId: (params.args as { machineId?: unknown }).machineId,
    rawSession: params.rawSession,
  })) {
    return null;
  }

  const probe = params.args.probe;
  const cwd = normalizeStringValue(probe?.cwd) || normalizeStringValue(params.rawSession?.path) || process.cwd();
  try {
    const probeAgentModesBestEffort = params.probeDeps?.probeAgentModesBestEffort
      ?? (await import('./resolveAgentProbeInventoryDeps')).probeAgentModesBestEffort;
    return await probeAgentModesBestEffort({
      agentId: probeAgentId,
      ...(params.backendTarget ? { backendTarget: convertBackendTargetRefV2ToV1(params.backendTarget) } : {}),
      cwd,
      ...(probe?.timeoutMs !== undefined ? { timeoutMs: probe.timeoutMs } : {}),
      ...(probe?.runtimeDescriptorV1 ? { runtimeDescriptorV1: probe.runtimeDescriptorV1 } : {}),
      accountSettings: params.accountSettings,
      credentials: params.credentials,
      acpCatalogSnapshot: params.acpCatalogSnapshot,
      savedSecretOperationContext: params.savedSecretOperationContext,
    }) as ProbedAgentModesResult;
  } catch (error) {
    if (error instanceof AcpCatalogUnavailableError) throw error;
    return null;
  }
}

async function probeActionConfigOptionsBestEffort(params: Readonly<{
  args: Parameters<NonNullable<ActionExecutorDeps['agentsConfigOptionsList']>>[0];
  agentId: string;
  backendTarget: BackendTargetRefV2 | null;
  rawSession?: Readonly<{
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
  }> | null;
  accountSettings: import('@happier-dev/protocol').AccountSettings | null;
  credentials: StoredCredentials | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  probeDeps?: AgentProbeInventoryDeps;
}>): Promise<ProbedAgentConfigOptionsResult | null> {
  const probeAgentId = resolveProbeAgentId({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
  });
  if (!legacyCustomAcpCompat.isAgentLookupId(probeAgentId)) return null;
  if (!machineTargetCanUseLocalProbe({
    requestedMachineId: (params.args as { machineId?: unknown }).machineId,
    rawSession: params.rawSession,
  })) {
    return null;
  }

  const probe = params.args.probe;
  const cwd = normalizeStringValue(probe?.cwd) || normalizeStringValue(params.rawSession?.path) || process.cwd();
  try {
    const probeAgentConfigOptionsBestEffort = params.probeDeps?.probeAgentConfigOptionsBestEffort
      ?? (await import('./resolveAgentProbeInventoryDeps')).probeAgentConfigOptionsBestEffort;
    return await probeAgentConfigOptionsBestEffort({
      agentId: probeAgentId,
      ...(params.backendTarget ? { backendTarget: convertBackendTargetRefV2ToV1(params.backendTarget) } : {}),
      cwd,
      ...(probe?.timeoutMs !== undefined ? { timeoutMs: probe.timeoutMs } : {}),
      ...(probe?.runtimeDescriptorV1 ? { runtimeDescriptorV1: probe.runtimeDescriptorV1 } : {}),
      accountSettings: params.accountSettings,
      credentials: params.credentials,
      acpCatalogSnapshot: params.acpCatalogSnapshot,
      savedSecretOperationContext: params.savedSecretOperationContext,
    }) as ProbedAgentConfigOptionsResult;
  } catch (error) {
    if (error instanceof AcpCatalogUnavailableError) throw error;
    return null;
  }
}

export function createCliActionInventoryDeps(params: Readonly<{
  token: string;
  serverId?: string;
  serverHttpBaseUrl?: string;
  credentials?: StoredCredentials;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  authorizeConnectedAccountRequest?: (context: ActionExecutorContext | undefined,
    request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
  sessionId: string;
  rawSession?: Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
  }> | null;
  readCurrentSessionMetadata?: () => Promise<Record<string, unknown> | null>;
  resolveTransportForSession?: Parameters<typeof createCliBoundSessionMetadataReader>[0]['resolveTransportForSession'];
  accountProfile?: AccountProfile | null;
  probeDeps?: AgentProbeInventoryDeps;
  mcpPreviewDeps?: SpawnMcpPreviewInventoryDeps;
  /** Existing exact-Machine transport, backed by the daemon's retained Provider services. */
  callMachineAction?: (input: Readonly<{
    machineId: string;
    serverId?: string;
    method: string;
    request: unknown;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
}> & SessionStoredContentCryptoContext): Pick<
  ActionExecutorDeps,
  | 'pathsListRecent'
  | 'machinesList'
  | 'serversList'
  | 'reviewEnginesList'
  | 'agentsBackendsList'
  | 'readAccountAcpCatalog'
  | 'agentsModelsList'
  | 'sessionModesList'
  | 'agentsConfigOptionsList'
  | 'agentsSessionModesList'
  | 'spawnProfilesList'
  | 'spawnConnectedServicesList'
  | 'spawnMcpServersPreview'
> {
  const metadataReaders = new Map<string, () => Promise<Record<string, unknown> | null>>();
  let accountProfilePromise: Promise<AccountProfile | null> | null = null;
  if (params.readCurrentSessionMetadata) metadataReaders.set(params.sessionId, params.readCurrentSessionMetadata);

  const readSessionMetadataForId = async (sessionId: string): Promise<Record<string, unknown> | null> => {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) return null;

    let read = metadataReaders.get(normalizedSessionId);
    if (!read) {
      read = createCliBoundSessionMetadataReader({
        ...(normalizedSessionId === params.sessionId ? params : {
          token: params.token, credentials: params.credentials, mode: 'plain' as const, ctx: null,
        }),
        sessionId: normalizedSessionId,
        resolveTransportForSession: params.resolveTransportForSession ?? (async (id) => params.credentials
          ? resolveSessionTransportContext({ credentials: params.credentials, idOrPrefix: id }) : { ok: false }),
      });
      metadataReaders.set(normalizedSessionId, read);
    }
    return await read();
  };

  const readAccountSettings = async (): Promise<import('@happier-dev/protocol').AccountSettings | null> => {
    if (params.savedSecretOperationContext) {
      if (!await params.savedSecretOperationContext.isCurrent()) throw new AcpCatalogUnavailableError('scope-retired');
      const snapshot = params.savedSecretOperationContext.readSnapshot();
      return snapshot && snapshot.source !== 'none' ? snapshot.settings : null;
    }
    return await resolveAvailableAccountSettings({
      credentials: params.credentials ?? null,
    });
  };

  const acpServerHttpBaseUrl = params.savedSecretOperationContext?.serverHttpBaseUrl
    ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const readAcpCatalogSnapshot = async (signal?: AbortSignal) => runWithServerHttpBaseUrl(acpServerHttpBaseUrl, async () => {
    const operation = params.savedSecretOperationContext;
    const credentials = params.credentials ?? operation?.credentials;
    if (!credentials) throw new AcpCatalogUnavailableError('not-authenticated');
    await readAccountSettings();
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const snapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
    let observedCatalog: AcpCatalogSnapshotV1 | undefined;
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      if (operation && !await operation.isCurrent() || snapshot()?.scopeKey !== scopeKey
        || !operation && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
        throw new AcpCatalogUnavailableError('scope-retired');
      }
      if (observedCatalog && snapshot()?.acpCatalog !== observedCatalog) throw new AcpCatalogUnavailableError('source-stale');
    };
    await assertCurrent();
    const catalog = await refreshActiveAcpCatalog({ credentials, signal, operationContext: operation });
    observedCatalog = catalog;
    await assertCurrent();
    const account = snapshot();
    if (!account || account.source === 'none') throw new AcpCatalogUnavailableError('account-settings-unavailable');
    return { account, catalog, assertCurrent };
  });
  const readAcpInventorySnapshot = async (signal?: AbortSignal) => {
    const captured = await readAcpCatalogSnapshot(signal);
    return { ...captured, catalog: requireReadyAcpCatalog(captured.catalog) };
  };

  const readAccountProfile = async (): Promise<AccountProfile | null> => {
    if (params.accountProfile !== undefined) {
      return params.accountProfile ?? null;
    }
    if (!params.credentials?.token) return null;
    if (!accountProfilePromise) {
      accountProfilePromise = (async () => {
        try {
          const response = await axios.get(`${resolveAccountSettingsHttpBaseUrl()}/v1/account/profile`, {
            headers: {
              ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
              Authorization: `Bearer ${params.credentials!.token}`,
              'Content-Type': 'application/json',
            },
            timeout: 10_000,
            validateStatus: () => true,
          });
          if (response.status < 200 || response.status >= 300) return null;
          const parsed = AccountProfileResponseSchema.safeParse(response.data);
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      })();
    }
    return await accountProfilePromise;
  };

  const readCurrentSessionValue = async (key: 'path' | 'host' | 'machineId'): Promise<string | null> => {
    const rawValue = params.rawSession?.metadataLayoutVersion === undefined || params.rawSession?.metadataLayoutVersion === 0
      ? params.rawSession?.[key] : undefined;
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      return rawValue.trim();
    }
    const metadata = await readSessionMetadataForId(params.sessionId);
    const metadataValue = metadata?.[key];
    return typeof metadataValue === 'string' && metadataValue.trim().length > 0
      ? metadataValue.trim()
      : null;
  };

  const readCurrentSessionWorkspace = async () => ({
    path: await readCurrentSessionValue('path'),
    host: await readCurrentSessionValue('host'),
    machineId: await readCurrentSessionValue('machineId'),
  });

  return {
    pathsListRecent: async (args) => {
      const currentPath = await readCurrentSessionValue('path');
      const currentMachineId = await readCurrentSessionValue('machineId');
      const requestedMachineId = normalizeStringValue((args as { machineId?: unknown }).machineId);
      const canUseCurrentPath = Boolean(
        currentPath
        && (!requestedMachineId || !currentMachineId || requestedMachineId === currentMachineId),
      );
      const items = canUseCurrentPath && currentPath
        ? [{
            id: currentPath,
            value: currentPath,
            path: currentPath,
            label: currentPath,
            ...(currentMachineId ? { machineId: currentMachineId } : {}),
            current: true,
          }]
        : [];
      return {
        items: limitItems(items, (args as { limit?: unknown }).limit),
      };
    },
    machinesList: async (args) => {
      const serverId = args.serverId ?? params.serverId ?? configuration.activeServerId;
      const items = (await listCurrentAccountMachines({ token: params.token })).map((machine) => ({
        serverId, id: machine.id, value: machine.id, label: machine.label, machineId: machine.id,
        active: machine.active, revokedAt: machine.revokedAt, replacedByMachineId: machine.replacedByMachineId,
        ...(machine.access ? { access: machine.access } : {}),
      }));
      return {
        items: limitItems(items, (args as { limit?: unknown }).limit),
      };
    },
    serversList: async (args) => {
      const profiles = await listServerProfiles().catch(() => []);
      const items = profiles
        .map((profile) => ({
          id: profile.id,
          value: profile.id,
          label: profile.name,
          serverUrl: profile.serverUrl,
          ...(profile.localServerUrl ? { localServerUrl: profile.localServerUrl } : {}),
          webappUrl: profile.webappUrl,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return {
        items: limitItems(items, (args as { limit?: unknown }).limit),
      };
    },
    readAccountAcpCatalog: async ({ signal }) => {
      try {
        const captured = await readAcpCatalogSnapshot(signal);
        await captured.assertCurrent();
        return captured.catalog;
      } catch (error) {
        if (error instanceof AcpCatalogUnavailableError) return { status: 'unavailable', reason: error.reason };
        throw error;
      }
    },
    reviewEnginesList: async ({ sessionId, includeDisabled, scope }) => {
      const captured = await readAcpInventorySnapshot();
      const items = await (await import('./buildReviewEngineInventoryItemsLazy')).buildReviewEngineInventoryItemsLazy({
        includeDisabled,
        scope,
        accountSettings: captured.account.settings,
        acpCatalogSnapshot: captured.catalog,
      });
      await captured.assertCurrent();
      return { sessionId, items };
    },
    agentsBackendsList: async (args) => {
      const captured = await readAcpInventorySnapshot();
      const items = await (await import('./buildAgentBackendInventoryItemsLazy')).buildAgentBackendInventoryItemsLazy({
        limit: (args as { limit?: unknown }).limit,
        includeDisabled: (args as { includeDisabled?: boolean }).includeDisabled === true,
        accountSettings: captured.account.settings,
        acpCatalogSnapshot: captured.catalog,
      });
      await captured.assertCurrent();
      return { items };
    },
    agentsModelsList: async (args) => {
      const agentId = args.agentId;
      const backendTargetKey = typeof (args as { backendTargetKey?: unknown }).backendTargetKey === 'string'
        ? (args as { backendTargetKey?: string }).backendTargetKey?.trim() ?? ''
        : '';
      const limit = (args as { limit?: unknown }).limit;
      const normalizedAgentId = String(agentId ?? '').trim();
      const backendTarget = backendTargetKey
        ? (() => {
            try {
              return readBackendTargetRefV2(backendTargetKey);
            } catch {
              return null;
            }
          })()
        : null;
      const usesConfiguredCompatBackend = backendTarget?.sourceKind === 'configured' || Boolean(backendTarget?.configuredBackendId);
      const captured = usesConfiguredCompatBackend ? await readAcpInventorySnapshot(args.signal) : null;
      const modelState = readSessionModelsState(await readSessionMetadataForId(params.sessionId));
      const provider = typeof modelState?.provider === 'string' ? modelState.provider.trim() : '';
      const availableModels = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
      const shouldUseSessionMetadataModels = Boolean(
        provider && (
          (normalizedAgentId && provider === normalizedAgentId)
          || (usesConfiguredCompatBackend && (
            provider === 'customAcp'
            || isLegacyConfiguredAcpFlavorCarrier(provider)
          ))
        ),
      );
      const metadataItems = shouldUseSessionMetadataModels
        ? modelInventoryItemsFromSessionModels(availableModels)
        : [{ id: 'default', label: 'Default' }];

      const probeResult = await probeActionModelsBestEffort({
        args,
        agentId: normalizedAgentId,
        backendTarget,
        rawSession: await readCurrentSessionWorkspace(),
        accountSettings: captured?.account.settings ?? await readAccountSettings(),
        credentials: params.savedSecretOperationContext?.credentials ?? params.credentials ?? null,
        acpCatalogSnapshot: captured?.catalog,
        savedSecretOperationContext: params.savedSecretOperationContext,
        probeDeps: params.probeDeps,
      });
      await captured?.assertCurrent();
      const probedItems = probeResult
        ? modelInventoryItemsFromProbeResult(probeResult)
        : null;
      const shouldUseProbeResult = Boolean(
        probeResult && probedItems && (usesConfiguredCompatBackend || probeResult.source === 'dynamic' || !shouldUseSessionMetadataModels),
      );
      const resolvedItems = shouldUseProbeResult && probedItems
        ? probedItems
        : usesConfiguredCompatBackend ? [] : metadataItems;
      const dedupedItems = resolvedItems.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
      const bounded = normalizeLimit(limit);
      let providerProjection: Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> | null = null;
      if (args.includeProviderProjection && args.machineId && backendTargetKey && params.callMachineAction) {
        try {
          const projection = DaemonProviderModelProjectionResponseV1Schema.safeParse(await params.callMachineAction({
            machineId: args.machineId,
            ...(args.serverId ? { serverId: args.serverId } : {}),
            method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
            request: { machineId: args.machineId, agentTargetKey: backendTargetKey, mode: 'picker' },
            ...(args.signal ? { signal: args.signal } : {}),
          }));
          if (projection.success && projection.data.status === 'success'
            && projection.data.agentTargetKey === backendTargetKey) providerProjection = projection.data;
        } catch {
          // Native choices remain usable when the exact Provider producer is unavailable.
        }
      }
      await captured?.assertCurrent();
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: bounded ? dedupedItems.slice(0, bounded) : dedupedItems,
        supportsFreeform: shouldUseProbeResult && probeResult ? probeResult.supportsFreeform : false,
        source: shouldUseProbeResult && probeResult
          ? probeResult.source
          : usesConfiguredCompatBackend ? 'unavailable' : shouldUseSessionMetadataModels ? 'session_metadata' : 'static',
        ...(args.includeProviderProjection ? { providerProjection } : {}),
        ...(args.probe && probeResult ? { probeObservation: AgentModelsProbeObservationSchema.parse(probeResult) } : {}),
      };
    },
    agentsSessionModesList: async (args) => {
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const backendTargetKey = readBackendTargetKey(args as { backendTargetKey?: unknown });
      const backendTarget = readBackendTargetFromKey(backendTargetKey);
      const captured = backendTarget?.sourceKind === 'configured' || backendTarget?.configuredBackendId
        ? await readAcpInventorySnapshot(args.signal) : null;
      const probeResult = await probeActionModesBestEffort({
        args,
        agentId: normalizedAgentId,
        backendTarget,
        rawSession: await readCurrentSessionWorkspace(),
        accountSettings: captured?.account.settings ?? await readAccountSettings(),
        credentials: params.savedSecretOperationContext?.credentials ?? params.credentials ?? null,
        acpCatalogSnapshot: captured?.catalog,
        savedSecretOperationContext: params.savedSecretOperationContext,
        probeDeps: params.probeDeps,
      });
      await captured?.assertCurrent();
      const probedItems = probeResult ? modeInventoryItemsFromProbeResult(probeResult) : [];
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: limitItems(dedupeById(probedItems), (args as { limit?: unknown }).limit),
        source: probeResult?.source ?? 'unavailable',
        ...(args.probe && probeResult ? { probeObservation: AgentSessionModesProbeObservationSchema.parse(probeResult) } : {}),
      };
    },
    agentsConfigOptionsList: async (args) => {
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const backendTargetKey = readBackendTargetKey(args as { backendTargetKey?: unknown });
      const backendTarget = readBackendTargetFromKey(backendTargetKey);
      const captured = backendTarget?.sourceKind === 'configured' || backendTarget?.configuredBackendId
        ? await readAcpInventorySnapshot(args.signal) : null;
      const probeResult = await probeActionConfigOptionsBestEffort({
        args,
        agentId: normalizedAgentId,
        backendTarget,
        rawSession: await readCurrentSessionWorkspace(),
        accountSettings: captured?.account.settings ?? await readAccountSettings(),
        credentials: params.savedSecretOperationContext?.credentials ?? params.credentials ?? null,
        acpCatalogSnapshot: captured?.catalog,
        savedSecretOperationContext: params.savedSecretOperationContext,
        probeDeps: params.probeDeps,
      });
      await captured?.assertCurrent();
      const items = probeResult ? configOptionDefinitionsFromProbeResult(probeResult) : [];
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: limitItems(dedupeById(items), (args as { limit?: unknown }).limit),
        source: probeResult?.source ?? 'unavailable',
        ...(args.probe && probeResult ? { probeObservation: AgentConfigOptionsProbeObservationSchema.parse(probeResult) } : {}),
      };
    },
    spawnProfilesList: async (args) => {
      const accountSettings = await readAccountSettings();
      const profileSnapshot = accountSettings && params.credentials
        ? await readAccountLaunchProfiles(accountSettings, params.credentials)
        : accountSettings ? readProfilesFromAccountSettings(accountSettings)
        : readProfilesFromAccountSettings({});
      // Filter, order, bound and completeness all come from the Protocol-owned
      // projection, so which host answered cannot change what a caller reads —
      // and a bounded answer says so rather than looking like a complete one.
      return projectProfilesListForActions(profileSnapshot.visibleProfiles, {
        agentId: normalizeStringValue((args as { agentId?: unknown }).agentId),
        limit: (args as { limit?: unknown }).limit,
        unreadableCount: profileSnapshot.opaqueProfiles.length,
        available: accountSettings !== null,
      });
    },
    spawnConnectedServicesList: async (args, context) => {
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const supportedServiceIds = resolveCatalogAgentConnectedAccountServiceIds(normalizedAgentId);
      if (supportedServiceIds.length === 0) {
        return { ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}), supportedServiceIds: [], items: [] };
      }
      const agentId = normalizedAgentId;
      const operationContext = params.savedSecretOperationContext;
      const credentials = operationContext?.credentials ?? params.credentials;
      if (!credentials) throw new ConnectedServicesDefaultUnavailableError('connected_services_default_settings_invalid');
      const authorize = params.authorizeConnectedAccountRequest;
      const authorizeRequest = authorize ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
        authorize(context, request) : undefined;
      const storeInput = { credentials, operationContext, signal: context?.signal, authorizeRequest };
      const store = await runWithServerHttpBaseUrl(acpServerHttpBaseUrl, async () => createCliConnectedAccountCatalogStore(storeInput));
      const assertCurrent = async () => {
        store.assertCurrent();
        if (operationContext && !await operationContext.isCurrent()) {
          throw new ConnectedServicesDefaultUnavailableError('connected_services_default_settings_invalid');
        }
        store.assertCurrent();
      };
      await assertCurrent();
      const purposeCatalog = await runWithServerHttpBaseUrl(store.serverHttpBaseUrl, () => readActiveConnectedAccountCatalog({
        ...storeInput, key: 'purposes',
      }));
      await assertCurrent();
      if (purposeCatalog.status !== 'ready' || purposeCatalog.record.key !== 'purposes') {
        throw new ConnectedServicesDefaultUnavailableError('connected_services_default_settings_invalid');
      }
      const accountProfile = params.accountProfile !== undefined ? params.accountProfile
        : await runWithServerHttpBaseUrl(store.serverHttpBaseUrl, () => fetchAccountProfile({ token: credentials.token,
          signal: context?.signal, authorizeRequest }));
      await assertCurrent();
      const accountSettings = await readAccountSettings();
      await assertCurrent();
      // Labels are optional display hints. Partial catalogs retain readable
      // neighbors; unavailable metadata must not withdraw credential inventory.
      let labelsByKey: Readonly<Record<string, string>> = {};
      try {
        const metadataInput = { ...storeInput, serverHttpBaseUrl: store.serverHttpBaseUrl };
        const metadata = operationContext
          ? await createCliConnectedMetadataStore(metadataInput).readCatalog()
          : await refreshActiveConnectedMetadataCatalog(metadataInput);
        if (metadata.presentation.status === 'ready' || metadata.presentation.status === 'partial') {
          labelsByKey = projectConnectedPresentationLabelsV1(metadata.presentation);
        }
      } catch {
        // No legacy label fallback: native names remain usable without metadata.
      }
      await assertCurrent();
      const supported = new Set<string>(supportedServiceIds);
      const profileOptionsByServiceId = (accountProfile?.connectedAccountsV4 ?? []).reduce<
        Record<string, AccountProfile['connectedAccountsV4']>
      >((byServiceId, account) => {
        const serviceId = buildQualifiedPluginContributionKey(account.ref.service);
        if (!supported.has(serviceId)) return byServiceId;
        (byServiceId[serviceId] ??= []).push(account);
        return byServiceId;
      }, {});
      const normalizedProfileOptionsByServiceId = Object.fromEntries(
        Object.entries(profileOptionsByServiceId).map(([serviceId, accounts]) => [
          serviceId,
          (accounts ?? []).map((account) => ({
            profileId: account.ref.accountId,
            status: account.status,
            kind: account.kind ?? null,
            providerEmail: account.providerIdentity?.email ?? null,
            label: labelsByKey[connectedServiceProfileKey({
              serviceId,
              profileId: account.ref.accountId,
            })]
              ?? account.displayName
              ?? account.providerIdentity?.email
              ?? account.ref.accountId,
          })),
        ]),
      );
      const groupOptionsByServiceId = Object.fromEntries(
        supportedServiceIds.map((serviceId) => [
          serviceId,
          (accountProfile?.connectedAccountGroupsV4 ?? [])
            .filter((group) => buildQualifiedPluginContributionKey(group.ref.service) === serviceId)
            .map((group) => ({
              groupId: group.ref.groupId,
              label: labelsByKey[connectedEntitySubjectKeyV1({ kind: 'group', ...group.ref })]
                ?? group.displayName ?? group.ref.groupId,
              activeProfileId: group.activeConnectedAccountId,
              memberProfileIds: group.members
                .filter((member) => member.enabled)
                .map((member) => member.connectedAccountId),
              generation: group.generation,
              enabledMemberCount: group.members.filter((member) => member.enabled).length,
              autoSwitch: group.policy.autoSwitch,
              status: group.members.some((member) => member.enabled) ? 'ready' : 'needs_members',
            })),
        ]),
      );
      const defaultBindings = resolveSpawnConnectedServicesDefaults({
        accountSettings,
        agentId,
        purposeCatalog,
      });
      const includeUnavailable = (args as { includeUnavailable?: unknown }).includeUnavailable === true;
      const profileItems = Object.entries(normalizedProfileOptionsByServiceId).flatMap(([serviceId, options]) => (
        options
          .filter((option) => includeUnavailable || option.status === 'connected')
          .map((option) => ({
            value: `${serviceId}:profile:${option.profileId}`,
            label: option.label ?? option.providerEmail ?? `${serviceId}:${option.profileId}`,
          }))
      ));
      return {
        agentId,
        supportedServiceIds,
        profileOptionsByServiceId: normalizedProfileOptionsByServiceId,
        groupOptionsByServiceId,
        ...(defaultBindings ? { defaultBindings } : {}),
        items: profileItems,
      };
    },
    spawnMcpServersPreview: async (args) => {
      const agentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const machineId = normalizeStringValue((args as { machineId?: unknown }).machineId)
        || await readCurrentSessionValue('machineId')
        || '';
      const directory = normalizeStringValue((args as { directory?: unknown }).directory)
        || await readCurrentSessionValue('path')
        || process.cwd();
      const context = params.savedSecretOperationContext;
      let snapshot: ActiveAccountSettingsSnapshot | null;
      let isCurrent: () => Promise<boolean>;
      if (context) {
        isCurrent = () => context.isCurrent();
        const catalog = await createCliMcpServerStoreForOperation({ operationContext: context }).readCatalogForOperation();
        const captured = context.readSnapshot();
        snapshot = captured ? { ...captured, mcpServerCatalog: catalog } : null;
      } else {
        await readAccountSettings();
        if (!params.credentials) throw Object.assign(new Error('MCP Account is unavailable'), { code: 'mcp_catalog_unavailable' });
        const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
        const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
        isCurrent = async () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
          && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
        await prepareActiveMcpServerCatalog({ credentials: params.credentials, scopeKey, lifetimeToken, refresh: true });
        snapshot = getActiveAccountSettingsSnapshot();
        if (snapshot?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
          throw Object.assign(new Error('Captured MCP Account retired'), { code: 'scope-retired' });
        }
      }
      const settings = readMcpServersSettingsFromAccountSettings(snapshot);
      const selectionParsed = SessionMcpSelectionV1Schema.safeParse((args as { selection?: unknown }).selection);
      const { resolveSpawnMcpServersPreviewInventory } = await import('./resolveSpawnMcpServersPreviewInventory');
      const preview = await resolveSpawnMcpServersPreviewInventory({
        settings,
        machineId,
        directory,
        agentId,
        ...(selectionParsed.success ? { selection: selectionParsed.data } : {}),
        limit: (args as { limit?: number }).limit,
        ...(params.mcpPreviewDeps ? { deps: params.mcpPreviewDeps } : {}),
      });
      if (!await isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
      return preview;
    },
    sessionModesList: async ({ sessionId }) => {
      const sessionModes = readSessionModesState(await readSessionMetadataForId(sessionId));
      const items = Array.isArray(sessionModes?.availableModes)
        ? sessionModes.availableModes
          .map((entry) => {
            const modeId = typeof entry?.id === 'string' ? entry.id.trim() : '';
            if (!modeId) return null;
            const label = typeof entry?.name === 'string' && entry.name.trim().length > 0
              ? entry.name.trim()
              : modeId;
            const description = typeof entry?.description === 'string' && entry.description.trim().length > 0
              ? entry.description.trim()
              : undefined;
            return {
              id: modeId,
              label,
              ...(description ? { description } : {}),
            };
          })
          .filter(Boolean)
        : [];
      return { sessionId, items };
    },
  };
}
