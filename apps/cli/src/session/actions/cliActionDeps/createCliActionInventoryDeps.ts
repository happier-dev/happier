import {
  AccountProfileResponseSchema,
  SessionMcpSelectionV1Schema,
  convertBackendTargetRefV2ToV1,
  readBackendTargetRefV2,
  type AccountProfile,
  type ActionExecutorDeps,
  type BackendTargetRefV2,
} from '@happier-dev/protocol';
import axios from 'axios';
import { homedir } from 'node:os';
import {
  AGENTS_CORE,
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId,
  isAgentId,
  legacyCustomAcpCompat,
  resolveAgentSupportedConnectedServiceIds,
  type AgentId,
} from '@happier-dev/agents';

import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import { readSettings, type Credentials } from '@/persistence';
import type { ProbedAgentModelsResult } from '@/capabilities/probes/agentModelsProbe';
import type { ProbedAgentModesResult } from '@/capabilities/probes/agentModesProbe';
import type { ProbedAgentConfigOptionsResult } from '@/capabilities/probes/agentConfigOptionsProbe';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { getPreferredHostName } from '@/daemon/machine/metadata';
import { listServerProfiles } from '@/server/serverProfiles';
import { mapProfileToListItem } from '@/settings/profiles/profileListProjection';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveSpawnConnectedServicesDefaults } from '@/session/services/spawnConnectedServicesDefaults';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

import {
  normalizeLimit,
  readSessionMetadata,
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

type SpawnMcpPreviewInventoryDeps = Readonly<{
  detectProviderMcpServers: (args: Readonly<{
    directory: string | null;
    providers: unknown;
  }>) => Promise<Readonly<{
    servers: readonly unknown[];
    warnings: readonly unknown[];
  }>>;
  resolveSessionMcpPreview: (args: Readonly<{
    settings: unknown;
    machineId: string;
    directory: string;
    agentId: string;
    selection?: unknown;
    detectedServers: readonly unknown[];
    detectedWarnings?: readonly unknown[];
  }>) => any;
}>;

type AgentProbeInventoryDeps = Readonly<{
  probeAgentModelsBestEffort: (args: unknown) => Promise<unknown>;
  probeAgentModesBestEffort: (args: unknown) => Promise<unknown>;
  probeAgentConfigOptionsBestEffort: (args: unknown) => Promise<unknown>;
}>;

async function resolveSpawnMcpServersPreviewInventoryWithDeps(params: Readonly<{
  deps: SpawnMcpPreviewInventoryDeps;
  settings: unknown;
  machineId: string;
  directory: string;
  agentId: string;
  selection?: unknown;
  limit?: number;
}>): Promise<unknown> {
  const detected = await params.deps.detectProviderMcpServers({
    directory: params.directory,
    providers: params.agentId ? [params.agentId] : null,
  });
  const preview = params.deps.resolveSessionMcpPreview({
    settings: params.settings,
    machineId: params.machineId,
    directory: params.directory,
    agentId: params.agentId,
    ...(params.selection ? { selection: params.selection } : {}),
    detectedServers: detected.servers,
    detectedWarnings: detected.warnings,
  });
  const items = preview?.ok
    ? [
        ...(Array.isArray(preview.builtIn) ? preview.builtIn : []),
        ...(Array.isArray(preview.managed) ? preview.managed : []),
        ...(Array.isArray(preview.detected) ? preview.detected : []),
      ].map((entry): Record<string, unknown> => ({
        value: entry.key,
        label: entry.title ?? entry.name ?? entry.key,
        selected: entry.selected,
        selectable: entry.selectable,
        sourceKind: entry.sourceKind,
        authMode: entry.authMode,
        availability: entry.availability,
      }))
    : [];
  return {
    ok: preview?.ok === true,
    items: limitItems(items, params.limit),
    preview,
  };
}

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
  credentials: Credentials | null;
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

  const cwd = normalizeStringValue(params.rawSession?.path) || process.cwd();
  try {
    const probeAgentModelsBestEffort = params.probeDeps?.probeAgentModelsBestEffort
      ?? (await import('./resolveAgentProbeInventoryDeps')).probeAgentModelsBestEffort;
    return await probeAgentModelsBestEffort({
      agentId: probeAgentId,
      ...(params.backendTarget ? { backendTarget: convertBackendTargetRefV2ToV1(params.backendTarget) } : {}),
      cwd,
      accountSettings: params.accountSettings,
      credentials: params.credentials,
    }) as ProbedAgentModelsResult;
  } catch {
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
  credentials: Credentials | null;
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

  const cwd = normalizeStringValue(params.rawSession?.path) || process.cwd();
  try {
    const probeAgentModesBestEffort = params.probeDeps?.probeAgentModesBestEffort
      ?? (await import('./resolveAgentProbeInventoryDeps')).probeAgentModesBestEffort;
    return await probeAgentModesBestEffort({
      agentId: probeAgentId,
      ...(params.backendTarget ? { backendTarget: convertBackendTargetRefV2ToV1(params.backendTarget) } : {}),
      cwd,
      accountSettings: params.accountSettings,
      credentials: params.credentials,
    }) as ProbedAgentModesResult;
  } catch {
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
  credentials: Credentials | null;
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

  const cwd = normalizeStringValue(params.rawSession?.path) || process.cwd();
  try {
    const probeAgentConfigOptionsBestEffort = params.probeDeps?.probeAgentConfigOptionsBestEffort
      ?? (await import('./resolveAgentProbeInventoryDeps')).probeAgentConfigOptionsBestEffort;
    return await probeAgentConfigOptionsBestEffort({
      agentId: probeAgentId,
      ...(params.backendTarget ? { backendTarget: convertBackendTargetRefV2ToV1(params.backendTarget) } : {}),
      cwd,
      accountSettings: params.accountSettings,
      credentials: params.credentials,
    }) as ProbedAgentConfigOptionsResult;
  } catch {
    return null;
  }
}

export function createCliActionInventoryDeps(params: Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode?: SessionStoredContentEncryptionMode;
  rawSession?: Readonly<{
    metadata?: unknown;
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
  }> | null;
  happyHomeDir?: string;
  accountProfile?: AccountProfile | null;
  probeDeps?: AgentProbeInventoryDeps;
  mcpPreviewDeps?: SpawnMcpPreviewInventoryDeps;
}>): Pick<
  ActionExecutorDeps,
  | 'pathsListRecent'
  | 'machinesList'
  | 'serversList'
  | 'reviewEnginesList'
  | 'agentsBackendsList'
  | 'agentsModelsList'
  | 'sessionModesList'
  | 'agentsConfigOptionsList'
  | 'agentsSessionModesList'
  | 'spawnProfilesList'
  | 'spawnConnectedServicesList'
  | 'spawnMcpServersPreview'
> {
  const metadataCache = new Map<string, Record<string, unknown> | null>();
  let accountProfilePromise: Promise<AccountProfile | null> | null = null;
  const seededMetadata = readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });
  metadataCache.set(params.sessionId, seededMetadata);

  const readSessionMetadataForId = async (sessionId: string): Promise<Record<string, unknown> | null> => {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) return null;

    if (metadataCache.has(normalizedSessionId)) {
      return metadataCache.get(normalizedSessionId) ?? null;
    }

    try {
      const rawSession = await fetchSessionById({ token: params.token, sessionId: normalizedSessionId });
      const mode =
        normalizedSessionId === params.sessionId && params.mode
          ? params.mode
          : resolveSessionStoredContentEncryptionMode(rawSession ?? undefined);
      const rawMetadata = (rawSession as any)?.metadata;
      const metadataRequiresDecryption = typeof rawMetadata === 'string' && rawMetadata.trim().length > 0;
      const ctx =
        metadataRequiresDecryption && normalizedSessionId !== params.sessionId && params.credentials
          ? resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession ?? undefined)
          : params.ctx;
      const metadata = readSessionMetadata({ rawSession, mode, ctx });
      metadataCache.set(normalizedSessionId, metadata);
      return metadata;
    } catch {
      metadataCache.set(normalizedSessionId, null);
      return null;
    }
  };

  const readAccountSettings = async (): Promise<import('@happier-dev/protocol').AccountSettings | null> => {
    return await resolveAvailableAccountSettings({
      credentials: params.credentials ?? null,
    });
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
    const rawValue = params.rawSession?.[key];
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      return rawValue.trim();
    }
    const metadata = await readSessionMetadataForId(params.sessionId);
    const metadataValue = metadata?.[key];
    return typeof metadataValue === 'string' && metadataValue.trim().length > 0
      ? metadataValue.trim()
      : null;
  };

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
      let settingsMachineId: string | null = null;
      try {
        settingsMachineId = normalizeStringValueOrNull((await readSettings()).machineId);
      } catch {
        settingsMachineId = null;
      }
      let preferredHost: string | null = null;
      try {
        preferredHost = normalizeStringValueOrNull(await getPreferredHostName());
      } catch {
        preferredHost = null;
      }
      const sessionMachineId = await readCurrentSessionValue('machineId');
      const sessionHost = await readCurrentSessionValue('host');
      const machineId = settingsMachineId ?? sessionMachineId ?? preferredHost ?? sessionHost ?? null;
      const host = preferredHost ?? sessionHost ?? null;
      const items = machineId || host
        ? [{
            id: machineId ?? host!,
            value: machineId ?? host!,
            label: host ?? machineId!,
            ...(machineId ? { machineId } : {}),
            ...(host ? { host } : {}),
            homeDir: normalizeStringValueOrNull(homedir()),
            current: true,
          }]
        : [];
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
    reviewEnginesList: async ({ sessionId, includeDisabled }) => ({
      sessionId,
      items: await (await import('./buildReviewEngineInventoryItemsLazy')).buildReviewEngineInventoryItemsLazy({
        includeDisabled,
        accountSettings: await readAccountSettings(),
      }),
    }),
    agentsBackendsList: async (args) => ({
      items: await (await import('./buildAgentBackendInventoryItemsLazy')).buildAgentBackendInventoryItemsLazy({
        limit: (args as { limit?: unknown }).limit,
        includeDisabled: (args as { includeDisabled?: boolean }).includeDisabled === true,
        accountSettings: await readAccountSettings(),
        happyHomeDir: params.happyHomeDir,
      }),
    }),
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
      const modelState = readSessionModelsState(await readSessionMetadataForId(params.sessionId));
      const provider = typeof modelState?.provider === 'string' ? modelState.provider.trim() : '';
      const availableModels = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
      const shouldUseSessionMetadataModels = Boolean(
        provider && (
          (normalizedAgentId && provider === normalizedAgentId)
          || (usesConfiguredCompatBackend && (provider === 'customAcp' || provider.startsWith('acp:')))
        ),
      );
      const metadataItems = shouldUseSessionMetadataModels
        ? modelInventoryItemsFromSessionModels(availableModels)
        : [{ id: 'default', label: 'Default' }];

      const probeResult = await probeActionModelsBestEffort({
        args,
        agentId: normalizedAgentId,
        backendTarget,
        rawSession: params.rawSession,
        accountSettings: await readAccountSettings(),
        credentials: params.credentials ?? null,
        probeDeps: params.probeDeps,
      });
      const probedItems = probeResult
        ? modelInventoryItemsFromProbeResult(probeResult)
        : null;
      const shouldUseProbeResult = Boolean(
        probeResult && probedItems && (probeResult.source === 'dynamic' || !shouldUseSessionMetadataModels),
      );
      const resolvedItems = shouldUseProbeResult && probedItems
        ? probedItems
        : metadataItems;
      const dedupedItems = resolvedItems.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
      const bounded = normalizeLimit(limit);
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: bounded ? dedupedItems.slice(0, bounded) : dedupedItems,
        supportsFreeform: shouldUseProbeResult && probeResult ? probeResult.supportsFreeform : false,
        source: shouldUseProbeResult && probeResult
          ? probeResult.source
          : shouldUseSessionMetadataModels ? 'session_metadata' : 'static',
      };
    },
    agentsSessionModesList: async (args) => {
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const backendTargetKey = readBackendTargetKey(args as { backendTargetKey?: unknown });
      const backendTarget = readBackendTargetFromKey(backendTargetKey);
      const probeResult = await probeActionModesBestEffort({
        args,
        agentId: normalizedAgentId,
        backendTarget,
        rawSession: params.rawSession,
        accountSettings: await readAccountSettings(),
        credentials: params.credentials ?? null,
        probeDeps: params.probeDeps,
      });
      const probedItems = probeResult ? modeInventoryItemsFromProbeResult(probeResult) : [];
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: limitItems(dedupeById(probedItems), (args as { limit?: unknown }).limit),
        source: probeResult?.source ?? 'unavailable',
      };
    },
    agentsConfigOptionsList: async (args) => {
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const backendTargetKey = readBackendTargetKey(args as { backendTargetKey?: unknown });
      const backendTarget = readBackendTargetFromKey(backendTargetKey);
      const probeResult = await probeActionConfigOptionsBestEffort({
        args,
        agentId: normalizedAgentId,
        backendTarget,
        rawSession: params.rawSession,
        accountSettings: await readAccountSettings(),
        credentials: params.credentials ?? null,
        probeDeps: params.probeDeps,
      });
      const items = probeResult ? configOptionDefinitionsFromProbeResult(probeResult) : [];
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: limitItems(dedupeById(items), (args as { limit?: unknown }).limit),
        source: probeResult?.source ?? 'unavailable',
      };
    },
    spawnProfilesList: async (args) => {
      const accountSettings = await readAccountSettings();
      const { visibleProfiles } = accountSettings
        ? readProfilesFromAccountSettings(accountSettings as any)
        : readProfilesFromAccountSettings({});
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      const items = visibleProfiles
        .map(mapProfileToListItem)
        .filter((profile) => !normalizedAgentId || profile.supportedAgentIds.includes(normalizedAgentId))
        .map((profile) => ({
          ...profile,
          value: profile.id,
          label: profile.name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: limitItems(items, (args as { limit?: unknown }).limit),
      };
    },
    spawnConnectedServicesList: async (args) => {
      const normalizedAgentId = normalizeStringValue((args as { agentId?: unknown }).agentId);
      if (!isAgentId(normalizedAgentId)) {
        return { ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}), supportedServiceIds: [], items: [] };
      }
      const agentId = normalizedAgentId as AgentId;
      const accountProfile = await readAccountProfile();
      const accountSettings = await readAccountSettings();
      const supportedServiceIds = resolveAgentSupportedConnectedServiceIds({
        agentCore: AGENTS_CORE[agentId],
      });
      const connectedServicesV2 = accountProfile?.connectedServicesV2 ?? [];
      const labelsByKey = accountSettings && typeof accountSettings === 'object'
        ? ((accountSettings as any).connectedServicesProfileLabelByKey ?? {})
        : {};
      const defaultProfileByServiceId = accountSettings && typeof accountSettings === 'object'
        ? ((accountSettings as any).connectedServicesDefaultProfileByServiceId ?? {})
        : {};
      const profileOptionsByServiceId = buildConnectedServiceProfileOptionsByServiceId({
        accountProfileConnectedServicesV2: connectedServicesV2,
        agentCore: AGENTS_CORE[agentId],
        supportedConnectedServiceIds: supportedServiceIds,
        labelsByKey,
      });
      const groupOptionsByServiceId = buildConnectedServiceAccountGroupOptionsByServiceId({
        accountGroupsFeatureEnabled: true,
        accountProfileConnectedServicesV2: connectedServicesV2,
        supportedConnectedServiceIds: supportedServiceIds,
      });
      const defaultBindings = resolveSpawnConnectedServicesDefaults({
        accountSettings,
        agentId,
      });
      const includeUnavailable = (args as { includeUnavailable?: unknown }).includeUnavailable === true;
      const profileItems = Object.entries(profileOptionsByServiceId).flatMap(([serviceId, options]) => (
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
        profileOptionsByServiceId,
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
      const accountSettings = await readAccountSettings();
      const settings = readMcpServersSettingsFromAccountSettings(accountSettings);
      const selectionParsed = SessionMcpSelectionV1Schema.safeParse((args as { selection?: unknown }).selection);
      if (params.mcpPreviewDeps) {
        return await resolveSpawnMcpServersPreviewInventoryWithDeps({
          deps: params.mcpPreviewDeps,
          settings,
          machineId,
          directory,
          agentId,
          ...(selectionParsed.success ? { selection: selectionParsed.data } : {}),
          limit: (args as { limit?: number }).limit,
        });
      }
      const { resolveSpawnMcpServersPreviewInventory } = await import('./resolveSpawnMcpServersPreviewInventory');
      return await resolveSpawnMcpServersPreviewInventory({
        settings,
        machineId,
        directory,
        agentId,
        ...(selectionParsed.success ? { selection: selectionParsed.data } : {}),
        limit: (args as { limit?: number }).limit,
      });
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
