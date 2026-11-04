import type { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildBackendTargetKeyV2, convertBackendTargetRefV2ToV1, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isLegacyConfiguredAcpFlavorCarrier } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import type { AccountProfile, ActionExecutorContext, ActionExecutorDeps, BackendTargetRefV2 } from '@happier-dev/protocol';
import axios from 'axios';
import type { configuration } from '@/configuration';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { AgentModelsProbeObservationSchema, AgentSessionModesProbeObservationSchema,
  AgentConfigOptionsProbeObservationSchema, projectProbedConfigOptionDefinitions } from '@happier-dev/protocol/capabilities';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import type { connectedServiceProfileKey, legacyCustomAcpCompat } from '@happier-dev/agents';

import type { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import { readSettings, type StoredCredentials } from '@/persistence';
import type { ProbedAgentModelsResult } from '@/capabilities/probes/agentModelsProbe';
import type { ProbedAgentModesResult } from '@/capabilities/probes/agentModesProbe';
import type { ProbedAgentConfigOptionsResult } from '@/capabilities/probes/agentConfigOptionsProbe';
import type { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AcpCatalogUnavailableError, requireReadyAcpCatalog } from '@/agent/acp/catalog/configured/resolveBackend';
import type { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { createCliBoundSessionMetadataReader } from '../resolveCliActionCallerSession';
import type { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import type { listServerProfiles } from '@/server/serverProfiles';
import type { projectProfilesListForActions } from '@/settings/profiles/profileListProjection';
import type { readAccountLaunchProfiles, readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import type { ConnectedServicesDefaultUnavailableError, resolveSpawnConnectedServicesDefaults } from '@/session/services/spawnConnectedServicesDefaults';
import type { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import type { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import type { createCliConnectedMetadataStore } from '@/settings/connected/connectedMetadataStore';
import type { refreshActiveConnectedMetadataCatalog } from '@/settings/connected/hydrateConnectedMetadataCatalog';
import { connectedEntitySubjectKeyV1, projectConnectedPresentationLabelsV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { fetchAccountProfile } from '@/api/accountProfile';
import type { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { projectSpawnMcpServersPreviewInventory } from './resolveSpawnMcpServersPreviewInventory';
import type { createCliSettingsCatalogServices } from '../settingsCatalogServices';
import { encodeScmDiffSummaryModelOverride, ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import {
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

import { normalizeLimit } from './sessionStateReaders';
import { createMachineInventoryProbe } from './probeMachineInventory';

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

async function resolveProbeAgentId(params: Readonly<{
  agentId: string;
  backendTarget: BackendTargetRefV2 | null;
}>): Promise<string> {
  if (params.backendTarget && (params.backendTarget.sourceKind === 'configured' || Boolean(params.backendTarget.configuredBackendId))) {
    const target = parseBackendTargetKeyV2(buildBackendTargetKeyV2(params.backendTarget));
    if (target.kind !== 'agent') return '';
    const { resolveSessionCreationAgentTarget } = await import('@/session/creation/resolveSessionCreationAgentTarget');
    return resolveSessionCreationAgentTarget(target)?.agentId ?? '';
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
  const probeAgentId = await resolveProbeAgentId({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
  });
  if (!probeAgentId) return null;
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
    const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
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
  const probeAgentId = await resolveProbeAgentId({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
  });
  const { legacyCustomAcpCompat } = await import("@happier-dev/agents");
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
    const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
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
  const probeAgentId = await resolveProbeAgentId({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
  });
  if (!probeAgentId) return null;
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
    const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
    if (error instanceof AcpCatalogUnavailableError) throw error;
    return null;
  }
}

export function createCliActionInventoryDeps(params: Readonly<{
  machineRecipesRead?: ActionExecutorDeps['machineRecipesRead'];
  localMachineId?: string;
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
  /** Existing exact-Machine transport, backed by the daemon's retained Provider services. */
  callMachineAction?: (input: Readonly<{
    machineId: string;
    serverId?: string;
    method: string;
    request: unknown;
    signal?: AbortSignal;
    context?: ActionExecutorContext;
    effectActionId?: string;
    timeoutMs?: number | null;
  }>) => Promise<unknown>;
}> & SessionStoredContentCryptoContext): Pick<
  ActionExecutorDeps,
  | 'pathsListRecent'
  | 'machinesList'
  | 'machineRecipesRead'
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
> & Required<Pick<ActionExecutorDeps, 'readAccountAcpCatalog' | 'agentsModelsList' | 'machinesList'>> {
  const metadataReaders = new Map<string, () => Promise<Record<string, unknown> | null>>();
  let accountProfilePromise: Promise<AccountProfile | null> | null = null;
  if (params.readCurrentSessionMetadata) metadataReaders.set(params.sessionId, params.readCurrentSessionMetadata);

  const readSessionMetadataForId = async (sessionId: string): Promise<Record<string, unknown> | null> => {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) return null;

    let read = metadataReaders.get(normalizedSessionId);
    if (!read) {
      const { createCliBoundSessionMetadataReader } = await import("../resolveCliActionCallerSession");
      read = createCliBoundSessionMetadataReader({
        ...(normalizedSessionId === params.sessionId ? params : {
          token: params.token, credentials: params.credentials, mode: 'plain' as const, ctx: null,
        }),
        sessionId: normalizedSessionId,
        resolveTransportForSession: params.resolveTransportForSession ?? (async (id) => {
          const { resolveSessionTransportContext } = await import("@/session/services/resolveSessionTransportContext");
          return params.credentials
          ? resolveSessionTransportContext({ reason: 'session-action', credentials: params.credentials, idOrPrefix: id }) : { ok: false };
        }),
      });
      metadataReaders.set(normalizedSessionId, read);
    }
    return await read();
  };

  const readAccountSettings = async (): Promise<import('@happier-dev/protocol').AccountSettings | null> => {
    if (params.savedSecretOperationContext) {
      if (!await params.savedSecretOperationContext.isCurrent()) {
        const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
        throw new AcpCatalogUnavailableError('scope-retired');
      }
      const snapshot = params.savedSecretOperationContext.readSnapshot();
      return snapshot && snapshot.source !== 'none' ? snapshot.settings : null;
    }
    const { resolveAvailableAccountSettings } = await import("@/settings/accountSettings/resolveAvailableAccountSettings");
    return await resolveAvailableAccountSettings({
      credentials: params.credentials ?? null,
    });
  };

  const probeMachineInventory = createMachineInventoryProbe(params);

  const acpServerHttpBaseUrl = params.savedSecretOperationContext?.serverHttpBaseUrl
    ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const readAcpCatalogSnapshot = async (signal?: AbortSignal) => runWithServerHttpBaseUrl(acpServerHttpBaseUrl, async () => {
    const operation = params.savedSecretOperationContext;
    const credentials = params.credentials ?? operation?.credentials;
    if (!credentials) {
      const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
      throw new AcpCatalogUnavailableError('not-authenticated');
    }
    await readAccountSettings();
    const [{ refreshActiveAcpCatalog }, { getActiveAccountSettingsSnapshotLifetimeToken, getActiveAccountSettingsSnapshot }, { resolveAccountSettingsScopeKey }] = await Promise.all([import("@/agent/acp/catalog/hydrateAcpCatalog"), import("@/settings/accountSettings/activeAccountSettingsSnapshot"), import("@/settings/accountSettings/accountSettingsScopeKey")]);
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const snapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
    let observedCatalog: AcpCatalogSnapshotV1 | undefined;
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      const { getActiveAccountSettingsSnapshotLifetimeToken } = await import("@/settings/accountSettings/activeAccountSettingsSnapshot");
      if (operation && !await operation.isCurrent() || snapshot()?.scopeKey !== scopeKey
        || !operation && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
        const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
        throw new AcpCatalogUnavailableError('scope-retired');
      }
      if (observedCatalog && snapshot()?.acpCatalog !== observedCatalog) {
        const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
        throw new AcpCatalogUnavailableError('source-stale');
      }
    };
    await assertCurrent();
    const catalog = await refreshActiveAcpCatalog({ credentials, signal, operationContext: operation });
    observedCatalog = catalog;
    await assertCurrent();
    const account = snapshot();
    if (!account || account.source === 'none') {
      const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
      throw new AcpCatalogUnavailableError('account-settings-unavailable');
    }
    return { account, catalog, assertCurrent };
  });
  const readAcpInventorySnapshot = async (signal?: AbortSignal) => {
    const captured = await readAcpCatalogSnapshot(signal);
    const { requireReadyAcpCatalog } = await import("@/agent/acp/catalog/configured/resolveBackend");
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
          const [{ buildCurrentAccountStoredContentCompatibilityHttpHeaders }, { resolveAccountSettingsHttpBaseUrl }] = await Promise.all([import("@/api/clientCompatibility/cliClientCompatibility"), import("@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl")]);
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
    machineRecipesRead: params.machineRecipesRead ?? (async (args, context) => {
      const unavailable = { ok: false as const, errorCode: 'unavailable', error: 'unavailable' };
      if (!params.callMachineAction) return unavailable;
      try {
        const raw = await params.callMachineAction({ machineId: args.machineId, serverId: args.homeId,
          method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
          request: { machineId: args.machineId, selection: 'machineRecipes',
            ...(args.recipeRefs === undefined ? {} : { recipeRefs: args.recipeRefs }) }, context,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        context.signal?.throwIfAborted();
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(raw);
        const family = response.success ? response.data.projection.familiesById.machineRecipes : undefined;
        return family?.family === 'machineRecipes' && response.success
          ? { entries: Object.values(family.entriesById),
            ...(response.data.machineRecipeTarget === undefined ? {} : { target: response.data.machineRecipeTarget }) }
          : unavailable;
      } catch {
        context.signal?.throwIfAborted();
        return unavailable;
      }
    }),
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
      const [{ configuration }, { listCurrentAccountMachines }] = await Promise.all([import("@/configuration"), import("@/api/machine/resolveCurrentAccountMachineTarget")]);
      const serverId = args.serverId ?? params.serverId ?? configuration.activeServerId;
      const items = (await listCurrentAccountMachines({ token: params.token, credentials: params.credentials,
        serverHttpBaseUrl: params.serverHttpBaseUrl })).map((machine) => ({
        serverId, id: machine.id, value: machine.id, label: machine.label, machineId: machine.id,
        kind: machine.kind, active: machine.active,
        ...(machine.activeAt === undefined ? {} : { activeAt: machine.activeAt }),
        revokedAt: machine.revokedAt, replacedByMachineId: machine.replacedByMachineId,
        ...(machine.platform === undefined ? {} : { platform: machine.platform }),
        ...(machine.arch === undefined ? {} : { arch: machine.arch }),
        ...(machine.access ? { access: machine.access } : {}),
      }));
      return {
        items: limitItems(items, (args as { limit?: unknown }).limit),
      };
    },
    serversList: async (args) => {
      const { listServerProfiles } = await import("@/server/serverProfiles");
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
        const { AcpCatalogUnavailableError } = await import("@/agent/acp/catalog/configured/resolveBackend");
        if (error instanceof AcpCatalogUnavailableError) return { status: 'unavailable', reason: error.reason };
        throw error;
      }
    },
    reviewEnginesList: async ({ sessionId, includeDisabled, scope }) => {
      const captured = await readAcpCatalogSnapshot();
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
      const captured = await readAcpCatalogSnapshot();
      const items = await (await import('./buildAgentBackendInventoryItemsLazy')).buildAgentBackendInventoryItemsLazy({
        limit: (args as { limit?: unknown }).limit,
        includeDisabled: (args as { includeDisabled?: boolean }).includeDisabled === true,
        accountSettings: captured.account.settings,
        acpCatalogSnapshot: captured.catalog,
      });
      await captured.assertCurrent();
      return { items };
    },
    agentsModelsList: async (args, context) => {
      if (args.purpose === 'scm_diff_summary') {
        if (!args.machineId || args.machineId !== params.localMachineId) return { items: [], source: 'unavailable' };
        const settings = await readAccountSettings();
        if (!settings) return { items: [], source: 'unavailable' };
        const { createCliSettingsCatalogServices } = await import("../settingsCatalogServices");
        const services = createCliSettingsCatalogServices({ credentials: params.savedSecretOperationContext?.credentials ?? params.credentials,
          savedSecretOperationContext: params.savedSecretOperationContext,
          serverHttpBaseUrl: acpServerHttpBaseUrl,
          authorizeConnectedAccountRequest: params.authorizeConnectedAccountRequest
            ? request => params.authorizeConnectedAccountRequest!(context, request) : undefined,
          serverId: args.serverId ?? params.serverId, signal: args.signal });
        const catalog = await services.readScmDiffSummaryCatalog!(settings,
          args.modelSelector ? encodeScmDiffSummaryModelOverride(args.modelSelector) : settings['scm.diffSummary.modelProfileOverride'],
          { includeConfigured: true, discoveryTargetKey: args.discoveryTargetKey });
        const current = await readAccountSettings();
        if (!catalog || !current || !catalog.isCurrent(current) || !await services.isCurrent()) return { items: [], source: 'unavailable' };
        return { items: [], scmDiffSummaryCatalog: ScmDiffSummaryModelCatalogObservationV1Schema.parse({ profiles: catalog.profiles,
          automaticProfiles: catalog.automaticProfiles, discoveryTargetKeys: catalog.discoveryTargetKeys,
          ...(catalog.unavailableReason ? { unavailableReason: catalog.unavailableReason } : {}),
          ...(catalog.unavailableTargets?.length ? { unavailableTargets: catalog.unavailableTargets } : {}),
          ...(catalog.probeFailures?.length ? { probeFailures: catalog.probeFailures } : {}) }) };
      }
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
      const usesMachineProbe = Boolean(args.machineId);
      const captured = usesConfiguredCompatBackend && !usesMachineProbe ? await readAcpInventorySnapshot(args.signal) : null;
      const modelState = usesMachineProbe ? null : (await import('./sessionControlStateReaders'))
        .readSessionModelsState(await readSessionMetadataForId(params.sessionId));
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

      const probeResult = usesMachineProbe ? await (async (): Promise<ProbedAgentModelsResult | ActionExecuteFailure | null> => {
        // Configured targets have no public runtime id. Match the native
        // observation using the same probe identity as the local catalog path.
        const probeAgentId = await resolveProbeAgentId({ agentId: normalizedAgentId, backendTarget });
        if (!probeAgentId) return null;
        const unavailable: ProbedAgentModelsResult = {
          agentId: probeAgentId, availableModels: [], supportsFreeform: false, source: 'unavailable',
        };
        const observation = await probeMachineInventory({ args, context, agentId: probeAgentId, backendTarget,
          method: 'probeModels', schema: AgentModelsProbeObservationSchema });
        if (!observation) return unavailable;
        if ('ok' in observation) return observation;
        return { ...observation, agentId: probeAgentId, source: observation.source ?? 'dynamic' };
      })() : await probeActionModelsBestEffort({
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
      if (probeResult && 'ok' in probeResult) return probeResult;
      await captured?.assertCurrent();
      const probedItems = probeResult
        ? modelInventoryItemsFromProbeResult(probeResult)
        : null;
      const shouldUseProbeResult = Boolean(
        probeResult && probedItems && (usesMachineProbe || usesConfiguredCompatBackend || probeResult.source === 'dynamic' || !shouldUseSessionMetadataModels),
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
        ? await readAcpInventorySnapshot() : null;
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
    agentsConfigOptionsList: async (args, context) => {
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const backendTargetKey = readBackendTargetKey(args as { backendTargetKey?: unknown });
      const backendTarget = readBackendTargetFromKey(backendTargetKey);
      const usesMachineProbe = Boolean(args.machineId);
      const captured = !usesMachineProbe && (backendTarget?.sourceKind === 'configured' || backendTarget?.configuredBackendId)
        ? await readAcpInventorySnapshot(args.signal) : null;
      const probeAgentId = await resolveProbeAgentId({ agentId: normalizedAgentId, backendTarget });
      if (usesMachineProbe && !probeAgentId) return { items: [], source: 'unavailable' };
      const probeContext = {
        agentId: normalizedAgentId,
        backendTarget,
        rawSession: usesMachineProbe ? null : await readCurrentSessionWorkspace(),
        accountSettings: usesMachineProbe ? null : captured?.account.settings ?? await readAccountSettings(),
        credentials: params.savedSecretOperationContext?.credentials ?? params.credentials ?? null,
        acpCatalogSnapshot: captured?.catalog,
        savedSecretOperationContext: params.savedSecretOperationContext,
        probeDeps: params.probeDeps,
      };
      const probeResult = usesMachineProbe
        ? await probeMachineInventory({ args, context, agentId: probeAgentId, backendTarget,
          method: 'probeConfigOptions', schema: AgentConfigOptionsProbeObservationSchema })
        : await probeActionConfigOptionsBestEffort({ ...probeContext, args });
      if (probeResult && 'ok' in probeResult) return probeResult;
      // Model-scoped controls belong to the selected model's existing native
      // catalog, not the session-wide config probe. Do not combine choices
      // across models or expose their current selections in this public read.
      const modelResult = !args.modelId ? null : usesMachineProbe
        ? await probeMachineInventory({ args, context, agentId: probeAgentId, backendTarget,
          method: 'probeModels', schema: AgentModelsProbeObservationSchema })
        : await probeActionModelsBestEffort({ ...probeContext, args });
      if (modelResult && 'ok' in modelResult) return modelResult;
      await captured?.assertCurrent();
      const { items, source } = projectProbedConfigOptionDefinitions({
        configOptions: probeResult?.configOptions ?? [],
        source: probeResult?.source ?? 'unavailable',
        modelId: args.modelId,
        models: modelResult,
      });
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: limitItems(items, (args as { limit?: unknown }).limit),
        source,
        ...(args.probe && probeResult ? { probeObservation: AgentConfigOptionsProbeObservationSchema.parse(probeResult) } : {}),
      };
    },
    spawnProfilesList: async (args) => {
      const accountSettings = await readAccountSettings();
      const credentials = params.savedSecretOperationContext?.credentials ?? params.credentials;
      const [{ projectProfilesListForActions }, { readAccountLaunchProfiles, readProfilesFromAccountSettings }] = await Promise.all([import("@/settings/profiles/profileListProjection"), import("@/settings/profiles/readProfilesFromAccountSettings")]);
      const profileSnapshot = accountSettings && credentials
        ? await readAccountLaunchProfiles(accountSettings, credentials, undefined, undefined, params.savedSecretOperationContext)
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
      const [{ connectedServiceProfileKey }, { resolveSpawnConnectedServicesDefaults }, { readActiveConnectedAccountCatalog }, { fetchAccountProfile }, { resolveCatalogAgentConnectedAccountServiceIds }] = await Promise.all([import("@happier-dev/agents"), import("@/session/services/spawnConnectedServicesDefaults"), import("@/settings/connectedAccounts/hydrateConnectedAccountCatalog"), import("@/api/accountProfile"), import("@/agent/catalog/registry")]);
      const supportedServiceIds = resolveCatalogAgentConnectedAccountServiceIds(normalizedAgentId);
      if (supportedServiceIds.length === 0) {
        return { ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}), supportedServiceIds: [], items: [] };
      }
      const agentId = normalizedAgentId;
      const operationContext = params.savedSecretOperationContext;
      const credentials = operationContext?.credentials ?? params.credentials;
      if (!credentials) {
        const { ConnectedServicesDefaultUnavailableError } = await import("@/session/services/spawnConnectedServicesDefaults");
        throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable');
      }
      const authorize = params.authorizeConnectedAccountRequest;
      const authorizeRequest = authorize ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
        authorize(context, request) : undefined;
      const storeInput = { credentials, operationContext, signal: context?.signal, authorizeRequest };
      const store = await runWithServerHttpBaseUrl(acpServerHttpBaseUrl, async () => {
        const { createCliConnectedAccountCatalogStore } = await import("@/settings/connectedAccounts/connectedAccountCatalogStore");
        return createCliConnectedAccountCatalogStore(storeInput);
      });
      const assertCurrent = async () => {
        store.assertCurrent();
        if (operationContext && !await operationContext.isCurrent()) {
          const { ConnectedServicesDefaultUnavailableError } = await import("@/session/services/spawnConnectedServicesDefaults");
          throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable');
        }
        store.assertCurrent();
      };
      await assertCurrent();
      const purposeCatalog = await runWithServerHttpBaseUrl(store.serverHttpBaseUrl, () => readActiveConnectedAccountCatalog({
        ...storeInput, key: 'purposes',
      }));
      await assertCurrent();
      if (purposeCatalog.status !== 'ready' || purposeCatalog.record.key !== 'purposes') {
        const { ConnectedServicesDefaultUnavailableError } = await import("@/session/services/spawnConnectedServicesDefaults");
        throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable');
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
        const [{ createCliConnectedMetadataStore }, { refreshActiveConnectedMetadataCatalog }] = await Promise.all([import("@/settings/connected/connectedMetadataStore"), import("@/settings/connected/hydrateConnectedMetadataCatalog")]);
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
    spawnMcpServersPreview: async (args, context) => {
      context?.signal?.throwIfAborted();
      const agentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const machineId = normalizeStringValue((args as { machineId?: unknown }).machineId)
        || await readCurrentSessionValue('machineId')
        || '';
      const directory = normalizeStringValue((args as { directory?: unknown }).directory)
        || await readCurrentSessionValue('path')
        || process.cwd();
      if (!params.callMachineAction || !machineId || !agentId) return { ok: false, items: [], preview: null };
      const { projectSpawnMcpServersPreviewInventory } = await import("./resolveSpawnMcpServersPreviewInventory");
      return projectSpawnMcpServersPreviewInventory(await params.callMachineAction({ machineId, serverId: context?.serverId ?? params.serverId,
        method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, request: { machineId, directory, agentId,
          ...((args as { selection?: unknown }).selection !== undefined ? { selection: args.selection } : {}) },
        context, effectActionId: 'sessions.spawn.mcp_servers.preview', timeoutMs: null, signal: context?.signal }), args.limit);
    },
    sessionModesList: async ({ sessionId }) => {
      const { readSessionModesState } = await import('./sessionControlStateReaders');
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
