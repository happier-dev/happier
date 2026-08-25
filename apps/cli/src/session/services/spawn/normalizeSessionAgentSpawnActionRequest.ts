import {
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  BackendTargetRefSchema,
  mergeSpawnConfigOptionAliases,
  parseBackendTargetKey,
  readAcpConfiguredBackendV1FromMetadata,
  readAgentRuntimeDescriptorV1,
  type AcpConfigOptionOverridesV1,
  type ActionSurfaces,
  type BackendTargetRefV1,
  type ConnectedServiceBindingsV1,
  type SpawnConfigOptionValue,
  type SessionAgentSpawnPolicyV1,
  type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  assertNonEscalatingPermissionMode,
  resolveAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import {
  CHILD_SESSION_INHERITANCE_FIELD_SETS,
  resolveChildSessionInheritedContextFromMetadata,
} from '@/session/inheritance/resolveChildSessionInheritedContextFromMetadata';
import {
  agentSupportsSpawnConnectedServicesDefaults,
  resolveSpawnConnectedServicesDefaultDisposition,
} from '@/session/services/spawnConnectedServicesDefaults';
import type { CreateSpawnedSessionParams } from '@/session/services/createSpawnedSession';

export type SessionAgentSpawnActionSurface = keyof ActionSurfaces;

export type SessionAgentSpawnActionInput = Readonly<{
  tag?: unknown;
  agentId?: unknown;
  modelId?: unknown;
  backendTargetKey?: unknown;
  backendTarget?: unknown;
  backend?: unknown;
  target?: unknown;
  title?: unknown;
  path?: unknown;
  directory?: unknown;
  host?: unknown;
  machineId?: unknown;
  prompt?: unknown;
  initialPrompt?: unknown;
  initialMessage?: unknown;
  permissionMode?: unknown;
  agentModeId?: unknown;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  configOptions?: Record<string, SpawnConfigOptionValue>;
  profileId?: unknown;
  environmentVariables?: Record<string, string>;
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: unknown;
  mcpSelection?: SessionMcpSelectionV1;
  transcriptStorage?: 'persisted' | 'direct';
  terminal?: CreateSpawnedSessionParams['terminal'];
  windowsRemoteSessionLaunchMode?: CreateSpawnedSessionParams['windowsRemoteSessionLaunchMode'];
  windowsRemoteSessionConsole?: CreateSpawnedSessionParams['windowsRemoteSessionConsole'];
  windowsTerminalWindowName?: unknown;
  codexBackendMode?: CreateSpawnedSessionParams['codexBackendMode'];
  agentRuntimeDescriptorV1?: CreateSpawnedSessionParams['agentRuntimeDescriptorV1'];
}>;

export type SessionAgentSpawnActionCurrentSession = Readonly<{
  path?: string | null;
  host?: string | null;
  machineId?: string | null;
  backendTarget?: BackendTargetRefV1 | null;
  permissionMode?: string | null;
}>;

type SessionAgentSpawnActionErrorResult = Readonly<
  | {
      type: 'error';
      errorCode: 'spawn_policy_denied';
      errorMessage: 'spawn_policy_denied';
      details: Readonly<{
        field: string;
        surface: 'session_agent';
      }>;
    }
  | {
      type: 'error';
      errorCode: 'host_not_found';
      errorMessage: 'host_not_found';
      host: string;
    }
  | {
      type: 'error';
      errorCode: 'spawn_target_missing' | 'invalid_parameters' | 'agent_not_found';
      errorMessage: 'spawn_target_missing' | 'invalid_parameters' | 'agent_not_found';
    }
  | {
      type: 'error';
      errorCode: 'permission_escalation_denied';
      errorMessage: 'permission_escalation_denied';
      details: Readonly<{
        requestedMode: string;
        requestedOrdinal: number;
        callerMode: string;
        callerOrdinal: number;
        permissionCeiling?: string;
      }>;
    }
>;

export type SessionAgentSpawnActionSource =
  | Readonly<{ kind: 'explicit'; key: string }>
  | Readonly<{ kind: 'metadata'; key: string }>
  | Readonly<{ kind: 'runtimeDescriptorMetadata'; key: string }>
  | Readonly<{ kind: 'currentSession'; key: string }>
  | Readonly<{ kind: 'default'; key: string }>;

export type SessionAgentSpawnActionSources = Partial<Record<
  | 'directory'
  | 'machineId'
  | 'backendTarget'
  | 'permissionMode'
  | 'modelId'
  | 'agentModeId'
  | 'sessionConfigOptionOverrides'
  | 'profileId'
  | 'environmentVariables'
  | 'connectedServices'
  | 'mcpSelection'
  | 'transcriptStorage',
  SessionAgentSpawnActionSource
>>;

export type SessionAgentSpawnActionConnectedServicesDefaultResolver = (params: Readonly<{
  credentials: Credentials;
  backendTarget: BackendTargetRefV1;
}>) => Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt: number;
}> | null>;

export type NormalizedSessionAgentSpawnActionRequest = Readonly<
  | {
      ok: true;
      createParams: CreateSpawnedSessionParams;
      sources: SessionAgentSpawnActionSources;
    }
  | {
      ok: false;
      result: SessionAgentSpawnActionErrorResult;
    }
>;

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function hasString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildPolicyDeniedResult(field: string): SessionAgentSpawnActionErrorResult {
  return {
    type: 'error',
    errorCode: 'spawn_policy_denied',
    errorMessage: 'spawn_policy_denied',
    details: {
      field,
      surface: 'session_agent',
    },
  };
}

function buildPermissionEscalationDeniedResult(params: Readonly<{
  requestedMode: string;
  requestedOrdinal: number;
  callerMode: string;
  callerOrdinal: number;
  permissionCeiling?: string;
}>): SessionAgentSpawnActionErrorResult {
  return {
    type: 'error',
    errorCode: 'permission_escalation_denied',
    errorMessage: 'permission_escalation_denied',
    details: params,
  };
}

function resolveDeniedExplicitPolicyField(params: Readonly<{
  policy: SessionAgentSpawnPolicyV1;
  input: SessionAgentSpawnActionInput;
}>): string | null {
  const { policy, input } = params;

  if (!policy.allowCustomDirectory && hasString(input.path)) return 'path';
  if (!policy.allowCustomDirectory && hasString(input.directory)) return 'directory';
  if (!policy.allowCrossMachine && hasString(input.host)) return 'host';
  if (!policy.allowCrossMachine && hasString(input.machineId)) return 'machineId';
  if (
    !policy.allowBackendTargetOverride &&
    (hasString(input.backendTargetKey) || hasString(input.agentId) || hasValue(input.backendTarget) || hasString(input.backend) || hasString(input.target))
  ) {
    if (hasString(input.backendTargetKey)) return 'backendTargetKey';
    if (hasValue(input.backendTarget)) return 'backendTarget';
    if (hasString(input.backend)) return 'backend';
    if (hasString(input.target)) return 'target';
    return 'agentId';
  }
  if (!policy.allowConfigOptionOverrides && hasValue(input.configOptions)) {
    return 'configOptions';
  }
  if (!policy.allowModelOverride && hasString(input.modelId)) return 'modelId';
  if (!policy.allowPermissionModeOverride && hasString(input.permissionMode)) return 'permissionMode';
  if (!policy.allowAgentModeOverride && hasString(input.agentModeId)) return 'agentModeId';
  if (!policy.allowConfigOptionOverrides && hasValue(input.sessionConfigOptionOverrides)) {
    return 'sessionConfigOptionOverrides';
  }
  if (!policy.allowProfileOverride && hasString(input.profileId)) return 'profileId';
  if (!policy.allowEnvironmentVariables && hasValue(input.environmentVariables)) return 'environmentVariables';
  if (!policy.allowConnectedServicesOverride && (hasValue(input.connectedServices) || hasValue(input.connectedServicesUpdatedAt))) {
    return hasValue(input.connectedServices) ? 'connectedServices' : 'connectedServicesUpdatedAt';
  }
  if (!policy.allowMcpSelectionOverride && hasValue(input.mcpSelection)) return 'mcpSelection';
  if (!policy.allowTranscriptStorageOverride && hasValue(input.transcriptStorage)) return 'transcriptStorage';
  return null;
}

function resolveBackendTarget(
  input: SessionAgentSpawnActionInput,
  parentMetadata: Record<string, unknown> | null,
  currentSession: SessionAgentSpawnActionCurrentSession,
): Readonly<{
  backendTarget: BackendTargetRefV1 | null;
  source: SessionAgentSpawnActionSource;
  invalidAgentId: boolean;
}> {
  const backendTargetKey = normalizeString(input.backendTargetKey);
  if (backendTargetKey) {
    try {
      return {
        backendTarget: parseBackendTargetKey(backendTargetKey),
        source: { kind: 'explicit', key: 'backendTargetKey' },
        invalidAgentId: false,
      };
    } catch {
      return {
        backendTarget: null,
        source: { kind: 'explicit', key: 'backendTargetKey' },
        invalidAgentId: false,
      };
    }
  }

  const parsedBackendTarget = BackendTargetRefSchema.safeParse(input.backendTarget);
  if (parsedBackendTarget.success) {
    return {
      backendTarget: parsedBackendTarget.data,
      source: { kind: 'explicit', key: 'backendTarget' },
      invalidAgentId: false,
    };
  }
  if (hasValue(input.backendTarget)) {
    return {
      backendTarget: null,
      source: { kind: 'explicit', key: 'backendTarget' },
      invalidAgentId: false,
    };
  }

  const backendAlias = normalizeString(input.backend) ?? normalizeString(input.target);
  if (backendAlias) {
    try {
      const aliasKey = backendAlias.includes(':') ? backendAlias : `agent:${backendAlias}`;
      return {
        backendTarget: parseBackendTargetKey(aliasKey),
        source: { kind: 'explicit', key: normalizeString(input.backend) ? 'backend' : 'target' },
        invalidAgentId: false,
      };
    } catch {
      return {
        backendTarget: null,
        source: { kind: 'explicit', key: normalizeString(input.backend) ? 'backend' : 'target' },
        invalidAgentId: false,
      };
    }
  }

  const agentId = normalizeString(input.agentId);
  if (agentId) {
    if (!AGENT_IDS.includes(agentId as AgentId)) {
      return {
        backendTarget: null,
        source: { kind: 'explicit', key: 'agentId' },
        invalidAgentId: true,
      };
    }
    return {
      backendTarget: { kind: 'builtInAgent', agentId: agentId as AgentId },
      source: { kind: 'explicit', key: 'agentId' },
      invalidAgentId: false,
    };
  }

  if (currentSession.backendTarget) {
    return {
      backendTarget: currentSession.backendTarget,
      source: { kind: 'currentSession', key: 'backendTarget' },
      invalidAgentId: false,
    };
  }

  const configuredBackend = parentMetadata
    ? readAcpConfiguredBackendV1FromMetadata(parentMetadata)
    : null;
  if (configuredBackend) {
    return {
      backendTarget: {
        kind: 'configuredAcpBackend',
        backendId: configuredBackend.backendId,
      },
      source: { kind: 'metadata', key: 'acpConfiguredBackendV1' },
      invalidAgentId: false,
    };
  }

  const descriptor = parentMetadata
    ? readAgentRuntimeDescriptorV1(parentMetadata.agentRuntimeDescriptorV1)
    : null;
  if (descriptor && AGENT_IDS.includes(descriptor.providerId as AgentId)) {
    return {
      backendTarget: { kind: 'builtInAgent', agentId: descriptor.providerId as AgentId },
      source: { kind: 'runtimeDescriptorMetadata', key: 'agentRuntimeDescriptorV1' },
      invalidAgentId: false,
    };
  }

  const inheritedAgentId = resolveAgentIdFromSessionMetadata(parentMetadata);
  if (inheritedAgentId) {
    return {
      backendTarget: { kind: 'builtInAgent', agentId: inheritedAgentId },
      source: { kind: 'metadata', key: 'sessionMetadataAgentId' },
      invalidAgentId: false,
    };
  }

  return {
    backendTarget: { kind: 'builtInAgent', agentId: DEFAULT_AGENT_ID },
    source: { kind: 'default', key: 'defaultAgentId' },
    invalidAgentId: false,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sourceForExplicitOrInherited(
  explicitValue: unknown,
  inheritedSource: SessionAgentSpawnActionSource | undefined,
  explicitKey: string,
): SessionAgentSpawnActionSource | undefined {
  return hasValue(explicitValue) ? { kind: 'explicit', key: explicitKey } : inheritedSource;
}

export async function resolveSessionAgentSpawnPolicy(params: Readonly<{
  credentials: Credentials;
}>): Promise<SessionAgentSpawnPolicyV1> {
  try {
    const accountSettingsContext = await bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: 'blocking',
      deps: { applySideEffects: () => undefined },
    });
    return accountSettingsContext.settings.sessionAgentSpawnPolicyV1 ?? DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1;
  } catch {
    return DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1;
  }
}

export const resolveSessionAgentSpawnConnectedServicesDefaults: SessionAgentSpawnActionConnectedServicesDefaultResolver =
  async ({ backendTarget, credentials }) => {
    if (backendTarget.kind !== 'builtInAgent') return null;
    const agentId = backendTarget.agentId;
    if (!AGENT_IDS.includes(agentId as AgentId)) return null;
    if (!agentSupportsSpawnConnectedServicesDefaults(agentId as AgentId)) return null;

    try {
      const accountSettingsContext = await bootstrapAccountSettingsContext({
        credentials,
        mode: 'blocking',
        deps: { applySideEffects: () => undefined },
      });
      // R4-2 (user-ruled): LITERAL resolution. The configured default is honored exactly as stored —
      // a profile default binds to that profile, a pool default binds to the pool. No silent
      // profile→pool upgrade here; rotation intent must be migrated by updating the STORED default.
      const disposition = resolveSpawnConnectedServicesDefaultDisposition({
        accountSettings: accountSettingsContext.settings,
        agentId: agentId as AgentId,
      });
      if (disposition.kind === 'unavailable') {
        throw new Error(disposition.reason);
      }
      if (disposition.kind === 'native') return null;
      return {
        connectedServices: disposition.bindings,
        connectedServicesUpdatedAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'connected_services_default_settings_invalid') {
        throw error;
      }
      return null;
    }
  };

export async function normalizeSessionAgentSpawnActionRequest(params: Readonly<{
  credentials: Credentials;
  surface: SessionAgentSpawnActionSurface;
  input: SessionAgentSpawnActionInput;
  parentMetadata: Record<string, unknown> | null;
  currentSession: SessionAgentSpawnActionCurrentSession;
  spawnPolicy?: SessionAgentSpawnPolicyV1 | null;
  resolveConnectedServicesDefaults?: SessionAgentSpawnActionConnectedServicesDefaultResolver;
}>): Promise<NormalizedSessionAgentSpawnActionRequest> {
  const input = params.input;
  const effectivePolicy = params.surface === 'session_agent'
    ? params.spawnPolicy ?? DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1
    : null;
  if (effectivePolicy) {
    const deniedField = resolveDeniedExplicitPolicyField({ policy: effectivePolicy, input });
    if (deniedField) {
      return { ok: false, result: buildPolicyDeniedResult(deniedField) };
    }
  }

  const requestedHost = normalizeString(input.host);
  const currentHost = normalizeString(params.currentSession.host);
  const explicitMachineId = normalizeString(input.machineId);
  const currentMachineId = explicitMachineId ?? normalizeString(params.currentSession.machineId);
  if (requestedHost && (!currentHost || requestedHost !== currentHost || !currentMachineId)) {
    return {
      ok: false,
      result: {
        type: 'error',
        errorCode: 'host_not_found',
        errorMessage: 'host_not_found',
        host: requestedHost,
      },
    };
  }

  const explicitDirectory = normalizeString(input.directory) ?? normalizeString(input.path);
  const currentDirectory = normalizeString(params.currentSession.path);
  const directory = explicitDirectory ?? currentDirectory;
  if (!directory) {
    return {
      ok: false,
      result: {
        type: 'error',
        errorCode: 'spawn_target_missing',
        errorMessage: 'spawn_target_missing',
      },
    };
  }

  const backend = resolveBackendTarget(input, params.parentMetadata, params.currentSession);
  if (!backend.backendTarget) {
    return {
      ok: false,
      result: {
        type: 'error',
        errorCode: backend.invalidAgentId ? 'agent_not_found' : 'invalid_parameters',
        errorMessage: backend.invalidAgentId ? 'agent_not_found' : 'invalid_parameters',
      },
    };
  }

  const inherited = resolveChildSessionInheritedContextFromMetadata({
    metadata: params.parentMetadata,
    providerId: backend.backendTarget.kind === 'builtInAgent' ? backend.backendTarget.agentId : null,
    fields: CHILD_SESSION_INHERITANCE_FIELD_SETS.sessionAgentSpawn,
  });

  const sources: SessionAgentSpawnActionSources = {
    directory: explicitDirectory
      ? { kind: 'explicit', key: normalizeString(input.directory) ? 'directory' : 'path' }
      : { kind: 'currentSession', key: 'path' },
    ...(currentMachineId
      ? { machineId: explicitMachineId ? { kind: 'explicit', key: 'machineId' } : { kind: 'currentSession', key: 'machineId' } }
      : {}),
    backendTarget: backend.source,
    ...inherited.sources,
  };

  const explicitPermissionMode = normalizeString(input.permissionMode);
  const currentPermissionMode = normalizeString(params.currentSession.permissionMode);
  const inheritedPermissionMode = inherited.spawn.permissionMode;
  const resolvedDefaultPermissionMode = currentPermissionMode ?? inheritedPermissionMode;
  const trustedCallerPermissionMode = params.surface === 'session_agent'
    ? resolvedDefaultPermissionMode
    : null;
  if (trustedCallerPermissionMode) {
    const permissionDecision = assertNonEscalatingPermissionMode({
      requestedMode: explicitPermissionMode ?? resolvedDefaultPermissionMode,
      callerMode: trustedCallerPermissionMode,
    });
    if (!permissionDecision.ok) {
      return {
        ok: false,
        result: buildPermissionEscalationDeniedResult(permissionDecision),
      };
    }
  }

  const resolvedPermissionMode = explicitPermissionMode ?? resolvedDefaultPermissionMode;
  const currentPermissionMatchesInherited = Boolean(
    currentPermissionMode
    && inherited.spawn.permissionMode
    && currentPermissionMode === inherited.spawn.permissionMode,
  );
  const resolvedPermissionModeUpdatedAt = explicitPermissionMode
    ? Date.now()
    : currentPermissionMode
      ? (currentPermissionMatchesInherited
          ? inherited.spawn.permissionModeUpdatedAt
          : Date.now())
      : inherited.spawn.permissionModeUpdatedAt;
  sources.permissionMode = explicitPermissionMode
    ? { kind: 'explicit', key: 'permissionMode' }
    : currentPermissionMode
      ? { kind: 'currentSession', key: 'permissionMode' }
    : inherited.sources.permissionMode ?? { kind: 'default', key: 'callerPermissionDefault' };

  if (effectivePolicy?.permissionCeiling) {
    const ceilingDecision = assertNonEscalatingPermissionMode({
      requestedMode: resolvedPermissionMode,
      callerMode: effectivePolicy.permissionCeiling,
    });
    if (!ceilingDecision.ok) {
      return {
        ok: false,
        result: buildPermissionEscalationDeniedResult({
          requestedMode: ceilingDecision.requestedMode,
          requestedOrdinal: ceilingDecision.requestedOrdinal,
          callerMode: ceilingDecision.callerMode,
          callerOrdinal: ceilingDecision.callerOrdinal,
          permissionCeiling: effectivePolicy.permissionCeiling,
        }),
      };
    }
  }

  const explicitModelId = normalizeString(input.modelId);
  const resolvedModelId = explicitModelId
    ? (explicitModelId === 'default' ? '' : explicitModelId)
    : inherited.spawn.modelId ?? '';
  const resolvedModelUpdatedAt = explicitModelId ? Date.now() : inherited.spawn.modelUpdatedAt;
  if (resolvedModelId) {
    sources.modelId = sourceForExplicitOrInherited(
      explicitModelId,
      inherited.sources.modelId,
      'modelId',
    );
  }

  const explicitAgentModeId = normalizeString(input.agentModeId);
  const resolvedAgentModeId = explicitAgentModeId ?? inherited.spawn.agentModeId;
  const resolvedAgentModeUpdatedAt = explicitAgentModeId ? Date.now() : inherited.spawn.agentModeUpdatedAt;
  if (resolvedAgentModeId) {
    sources.agentModeId = sourceForExplicitOrInherited(
      explicitAgentModeId,
      inherited.sources.agentModeId,
      'agentModeId',
    );
  }

  const explicitConfigOptions = mergeSpawnConfigOptionAliases({
    sessionConfigOptionOverrides: input.sessionConfigOptionOverrides,
    configOptions: input.configOptions,
  });
  if (!explicitConfigOptions.ok) {
    return {
      ok: false,
      result: {
        type: 'error',
        errorCode: 'invalid_parameters',
        errorMessage: 'invalid_parameters',
      },
    };
  }
  const resolvedSessionConfigOptionOverrides =
    explicitConfigOptions.value
    ?? inherited.metadata.sessionConfigOptionOverridesV1
    ?? inherited.metadata.acpConfigOptionOverridesV1;
  if (resolvedSessionConfigOptionOverrides) {
    sources.sessionConfigOptionOverrides = sourceForExplicitOrInherited(
      explicitConfigOptions.value,
      inherited.sources.sessionConfigOptionOverrides,
      explicitConfigOptions.source ?? 'sessionConfigOptionOverrides',
    );
  }

  const explicitProfileId = normalizeString(input.profileId);
  const resolvedProfileId = explicitProfileId ?? inherited.spawn.profileId;
  if (resolvedProfileId) {
    sources.profileId = sourceForExplicitOrInherited(
      explicitProfileId,
      inherited.sources.profileId,
      'profileId',
    );
  }

  if (input.environmentVariables) {
    sources.environmentVariables = { kind: 'explicit', key: 'environmentVariables' };
  }

  const defaultsResolver =
    params.resolveConnectedServicesDefaults ?? resolveSessionAgentSpawnConnectedServicesDefaults;
  const connectedServicesDefaults = input.connectedServices || inherited.spawn.connectedServices
    ? null
    : await defaultsResolver({
      credentials: params.credentials,
      backendTarget: backend.backendTarget,
    });
  const resolvedConnectedServices =
    input.connectedServices
    ?? inherited.spawn.connectedServices
    ?? connectedServicesDefaults?.connectedServices;
  const resolvedConnectedServicesUpdatedAt =
    finiteNumber(input.connectedServicesUpdatedAt)
    ?? inherited.spawn.connectedServicesUpdatedAt
    ?? connectedServicesDefaults?.connectedServicesUpdatedAt;
  if (resolvedConnectedServices) {
    sources.connectedServices = input.connectedServices
      ? { kind: 'explicit', key: 'connectedServices' }
      : inherited.sources.connectedServices ?? { kind: 'default', key: 'connectedServicesDefaults' };
  }

  const resolvedMcpSelection = input.mcpSelection ?? inherited.spawn.mcpSelection;
  if (resolvedMcpSelection) {
    sources.mcpSelection = sourceForExplicitOrInherited(
      input.mcpSelection,
      inherited.sources.mcpSelection,
      'mcpSelection',
    );
  }

  if (input.transcriptStorage) {
    sources.transcriptStorage = { kind: 'explicit', key: 'transcriptStorage' };
  }

  return {
    ok: true,
    createParams: {
      credentials: params.credentials,
      directory,
      ...(currentMachineId ? { machineId: currentMachineId } : {}),
      backendTarget: backend.backendTarget,
      ...(resolvedPermissionMode ? { permissionMode: resolvedPermissionMode } : {}),
      ...(typeof resolvedPermissionModeUpdatedAt === 'number' && Number.isFinite(resolvedPermissionModeUpdatedAt)
        ? { permissionModeUpdatedAt: resolvedPermissionModeUpdatedAt }
        : {}),
      ...(hasString(input.tag) ? { tag: String(input.tag).trim() } : {}),
      ...(hasString(input.title) ? { title: String(input.title).trim() } : {}),
      ...(hasString(input.initialMessage) || hasString(input.initialPrompt) || hasString(input.prompt)
        ? { initialMessage: String(input.initialMessage ?? input.initialPrompt ?? input.prompt).trim() }
        : {}),
      ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
      ...(resolvedModelId && typeof resolvedModelUpdatedAt === 'number' && Number.isFinite(resolvedModelUpdatedAt)
        ? { modelUpdatedAt: resolvedModelUpdatedAt }
        : {}),
      ...(resolvedAgentModeId ? { agentModeId: resolvedAgentModeId } : {}),
      ...(typeof resolvedAgentModeUpdatedAt === 'number' && Number.isFinite(resolvedAgentModeUpdatedAt)
        ? { agentModeUpdatedAt: resolvedAgentModeUpdatedAt }
        : {}),
      ...(resolvedSessionConfigOptionOverrides ? { sessionConfigOptionOverrides: resolvedSessionConfigOptionOverrides } : {}),
      ...(resolvedProfileId ? { profileId: resolvedProfileId } : {}),
      ...(input.environmentVariables ? { environmentVariables: input.environmentVariables } : {}),
      ...(resolvedConnectedServices ? { connectedServices: resolvedConnectedServices } : {}),
      ...(typeof resolvedConnectedServicesUpdatedAt === 'number' && Number.isFinite(resolvedConnectedServicesUpdatedAt)
        ? { connectedServicesUpdatedAt: resolvedConnectedServicesUpdatedAt }
        : {}),
      ...(resolvedMcpSelection ? { mcpSelection: resolvedMcpSelection } : {}),
      ...(input.transcriptStorage ? { transcriptStorage: input.transcriptStorage } : {}),
      ...(input.terminal ? { terminal: input.terminal } : {}),
      ...(input.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: input.windowsRemoteSessionLaunchMode } : {}),
      ...(input.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: input.windowsRemoteSessionConsole } : {}),
      ...(hasString(input.windowsTerminalWindowName) ? { windowsTerminalWindowName: String(input.windowsTerminalWindowName).trim() } : {}),
      ...(input.codexBackendMode ? { codexBackendMode: input.codexBackendMode } : {}),
      ...(input.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: input.agentRuntimeDescriptorV1 } : {}),
    },
    sources,
  };
}
