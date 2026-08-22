import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { SpawnSessionErrorCode } from '@/session/shared/spawnSessionContract';
import {
  ConnectedServiceBindingsV1Schema,
  SessionEnvOverlayV1Schema,
  type ProviderErrorV1,
  type SessionEnvOverlayV1,
} from '@happier-dev/protocol';
import type { ProviderBindingLaunchHandoffV1 } from '@/plugins/runtime/providerBindings/handoff';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { sanitizeEnvVarRecord } from '@/terminal/runtime/envVarSanitization';
import {
  createDaemonSpawnToolResolutionContext,
  type DaemonSpawnHooks,
} from '../spawnHooks';
import { buildAuthEnvUnexpandedErrorMessage, findUnexpandedAuthEnvironmentReferences } from './authEnvValidation';
import {
  SESSION_MACHINE_WORKSPACE_PATH_ENV,
  SESSION_REQUESTED_DIRECTORY_ENV,
} from '@/agent/runtime/resolveRequestedSessionDirectory';
import {
  HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY,
  serializeSessionConnectedServicesBindingsForEnv,
} from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import {
  HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
  serializeSessionConnectedServiceMaterializationIdentityForEnv,
} from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { dispatchDaemonSpawnHookEvent } from '@/plugins/runtime/hooks/execution/dispatchDaemonSpawnHookEvent';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from './spawnExplicitEnvKeysMarker';
import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialization/materializer';
import { buildMissingAgentCliCommandErrorMessage } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import {
  isSessionControlEnvKey,
  stripSessionControlEnvOverrides,
} from '@/session/runtime/control/sessionControlEnvironment';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveSpawnHookInstallablesRegistry } from './spawnHookInstallablesRegistry';

type ResolveSpawnChildEnvironmentSuccess = {
  ok: true;
  expandedEnvironmentVariables: Record<string, string>;
  extraEnvForChild: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  providerEnvKeys?: readonly string[];
  providerBindingLaunchHandoff?: ProviderBindingLaunchHandoffV1;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  materializationDiagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
};

type ResolveSpawnChildEnvironmentFailure = {
  ok: false;
  errorCode: SpawnSessionErrorCode;
  errorMessage: string;
  providerError?: ProviderErrorV1;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  materializationDiagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
};

export type ResolveSpawnChildEnvironmentResult =
  | ResolveSpawnChildEnvironmentSuccess
  | ResolveSpawnChildEnvironmentFailure;

type LateProviderBindingMaterialization =
  | Readonly<{
      ok: true;
      providerEnvironmentOverlay: SessionEnvOverlayV1;
      providerBindingLaunchHandoff: ProviderBindingLaunchHandoffV1;
      cleanupOnFailure?: (() => void) | null;
      cleanupOnExit?: (() => void) | null;
    }>
  | Readonly<{
      ok: false;
      errorCode: SpawnSessionErrorCode;
      errorMessage: string;
      providerError?: ProviderErrorV1;
    }>;

type ProviderBindingPrerequisiteContext = Readonly<{
  v: 1;
  agentTargetKey: string;
  connectionId: string;
  modelId: string;
}>;

function projectDaemonSpawnConnectedServices(value: unknown): NonNullable<
  Parameters<NonNullable<DaemonSpawnHooks['resolveRuntimePrerequisites']>>[0]['connectedServices']
> | undefined {
  try {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
    if (!parsed.success) return undefined;
    const bindingsByServiceId = Object.fromEntries(
      Object.entries(parsed.data.bindingsByServiceId).map(([serviceId, binding]) => {
        if (binding.source === 'native') {
          return [serviceId, Object.freeze({ source: 'native' as const })];
        }
        if (binding.selection === 'profile') {
          return [serviceId, Object.freeze({
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: binding.profileId,
          })];
        }
        return [serviceId, Object.freeze({
          source: 'connected' as const,
          selection: 'group' as const,
          groupId: binding.groupId,
          ...(binding.profileId ? { profileId: binding.profileId } : {}),
        })];
      }),
    );
    return Object.freeze({
      v: 1,
      bindingsByServiceId: Object.freeze(bindingsByServiceId),
    });
  } catch {
    return undefined;
  }
}

function chainCleanupCallbacks(
  first: (() => void) | null,
  second: (() => void) | null,
): (() => void) | null {
  if (!first) return second;
  if (!second) return first;
  return () => {
    try { first(); } finally { second(); }
  };
}

export async function resolveSpawnChildEnvironment(params: {
  happyHomeDir?: string;
  pluginRuntimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  options: SpawnSessionOptions;
  profileEnvironmentVariables: Record<string, string>;
  daemonSpawnHooks: DaemonSpawnHooks | null;
  processEnv: NodeJS.ProcessEnv;
  logDebug: (message: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  connectedServiceAuth?: {
    env: Record<string, string>;
    cleanupOnFailure: (() => void) | null;
    cleanupOnExit: (() => void) | null;
    diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
  } | null;
  providerEnvironmentOverlay?: SessionEnvOverlayV1;
  materializeProviderBindingAfterHooks?: () => Promise<LateProviderBindingMaterialization>;
  providerBindingContext?: ProviderBindingPrerequisiteContext;
  providerBindingPrerequisitesOnly?: boolean;
  runtimePrerequisitesAlreadyResolved?: boolean;
}): Promise<ResolveSpawnChildEnvironmentResult> {
  try {
    return await resolveSpawnChildEnvironmentImpl(params);
  } catch (error) {
    try {
      params.connectedServiceAuth?.cleanupOnFailure?.();
    } catch (cleanupError) {
      params.logWarn(
        '[DAEMON RUN] Failed to clean connected-service materialization after environment resolution error',
      );
    }
    throw error;
  }
}

async function resolveSpawnChildEnvironmentImpl(params: {
  happyHomeDir?: string;
  pluginRuntimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  options: SpawnSessionOptions;
  profileEnvironmentVariables: Record<string, string>;
  daemonSpawnHooks: DaemonSpawnHooks | null;
  processEnv: NodeJS.ProcessEnv;
  logDebug: (message: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  connectedServiceAuth?: {
    env: Record<string, string>;
    cleanupOnFailure: (() => void) | null;
    cleanupOnExit: (() => void) | null;
    diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
  } | null;
  providerEnvironmentOverlay?: SessionEnvOverlayV1;
  materializeProviderBindingAfterHooks?: () => Promise<LateProviderBindingMaterialization>;
  providerBindingContext?: ProviderBindingPrerequisiteContext;
  providerBindingPrerequisitesOnly?: boolean;
  runtimePrerequisitesAlreadyResolved?: boolean;
}): Promise<ResolveSpawnChildEnvironmentResult> {
  const connectedCleanupOnFailure = params.connectedServiceAuth?.cleanupOnFailure ?? null;
  const connectedCleanupOnExit = params.connectedServiceAuth?.cleanupOnExit ?? null;
  const materializationDiagnostics = params.connectedServiceAuth?.diagnostics;

  const backendTarget = resolveConcreteBackendTargetRefV2(params.options.backendTarget);
  const explicitResumeId = typeof params.options.resume === 'string' && params.options.resume.trim().length > 0
    ? params.options.resume.trim()
    : null;
  const canonicalRuntimeSelection = readCanonicalSpawnRuntimeSelection(params.options);
  const runtimeDescriptorV1 = canonicalRuntimeSelection.runtimeDescriptorV1;
  const providerRuntimeSelection =
    canonicalRuntimeSelection.providerRuntimeSelection
    && Object.keys(canonicalRuntimeSelection.providerRuntimeSelection).length > 0
      ? canonicalRuntimeSelection.providerRuntimeSelection
      : undefined;
  const connectedServices = projectDaemonSpawnConnectedServices(
    params.options.connectedServices,
  );
  const spawnHookTimestampMs = () => Date.now();
  const spawnHookBackendId = backendTarget?.backendId;
  const toolResolutionContext = createDaemonSpawnToolResolutionContext({
    processEnv: params.processEnv,
    installablesRegistry: () => resolveSpawnHookInstallablesRegistry(
      params.happyHomeDir,
      params.pluginRuntimeRegistry
        ? { contributions: params.pluginRuntimeRegistry.contributes }
        : {},
    ),
    logInfo: params.logInfo,
    logWarn: params.logWarn,
  });

  let cleanupOnFailure: (() => void) | null = null;
  let cleanupOnExit: (() => void) | null = null;

  let runtimeSelectionEnv: Record<string, string> = {};

  function buildRuntimeSelectionPayload() {
    return {
      ...(providerRuntimeSelection ? { providerRuntimeSelection } : {}),
      ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
      ...(params.providerBindingContext ? { providerBinding: params.providerBindingContext } : {}),
      ...(params.options.directory ? { cwd: params.options.directory, directory: params.options.directory } : {}),
      ...(Object.keys(runtimeSelectionEnv).length > 0 ? { env: runtimeSelectionEnv } : {}),
      ...(connectedServices ? { connectedServices } : {}),
    };
  }

  function buildRuntimeSelection() {
    return {
      ...buildRuntimeSelectionPayload(),
      tools: toolResolutionContext,
    };
  }

  async function readPluginSpawnDecision(): Promise<Readonly<{
    allowed: boolean;
    errorMessage: string | null;
  }>> {
    if (!params.happyHomeDir) {
      return { allowed: true, errorMessage: null };
    }

    const result = await dispatchDaemonSpawnHookEvent({
      happyHomeDir: params.happyHomeDir,
      ...(params.pluginRuntimeRegistry
        ? { runtimeRegistry: params.pluginRuntimeRegistry }
        : {}),
      event: {
        eventId: 'agent.resolvePrerequisites',
        backendId: backendTarget?.backendId,
        backendTarget: backendTarget ?? undefined,
        machineId: params.options.machineId,
        cwd: params.options.directory,
        payload: {
          ...(spawnHookBackendId ? { backendId: spawnHookBackendId } : {}),
          ...(backendTarget ? { targetRef: backendTarget } : {}),
          timestampMs: spawnHookTimestampMs(),
          cwd: params.options.directory,
          directory: params.options.directory,
          runtimeSelection: buildRuntimeSelectionPayload(),
          ...(explicitResumeId ? { resumeId: explicitResumeId } : {}),
        },
        context: {
          tools: toolResolutionContext,
        },
      },
    });

    const aggregate = result.aggregate;
    const denied = aggregate?.executionKind === 'decide'
      && aggregate.result !== null
      && typeof aggregate.result === 'object'
      && !Array.isArray(aggregate.result)
      && (aggregate.result as { decision?: unknown }).decision === 'deny';

    if (!denied) {
      return {
        allowed: true,
        errorMessage: null,
      };
    }

    for (const outcome of result.outcomes) {
      if (outcome.status === 'rejected' && typeof outcome.error === 'string' && outcome.error.trim().length > 0) {
        return {
          allowed: false,
          errorMessage: outcome.error.trim(),
        };
      }
      if (outcome.status === 'fulfilled' && outcome.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result)) {
        const reason = (outcome.result as Record<string, unknown>).errorMessage
          ?? (outcome.result as Record<string, unknown>).message
          ?? (outcome.result as Record<string, unknown>).reason;
        if (typeof reason === 'string' && reason.trim().length > 0) {
          return {
            allowed: false,
            errorMessage: reason.trim(),
          };
        }
      }
    }

    return {
      allowed: false,
      errorMessage: 'Plugin spawn prerequisite hook denied daemon spawn.',
    };
  }

  async function readPluginSpawnEnvAugmentation(): Promise<Record<string, string>> {
    if (!params.happyHomeDir) {
      return {};
    }

    const result = await dispatchDaemonSpawnHookEvent({
      happyHomeDir: params.happyHomeDir,
      ...(params.pluginRuntimeRegistry
        ? { runtimeRegistry: params.pluginRuntimeRegistry }
        : {}),
      event: {
        eventId: 'agent.spawnEnv.augment',
        backendId: backendTarget?.backendId,
        backendTarget: backendTarget ?? undefined,
        machineId: params.options.machineId,
        cwd: params.options.directory,
        payload: {
          ...(spawnHookBackendId ? { backendId: spawnHookBackendId } : {}),
          timestampMs: spawnHookTimestampMs(),
          cwd: params.options.directory,
          directory: params.options.directory,
          runtimeSelection: buildRuntimeSelectionPayload(),
          ...(explicitResumeId ? { resumeId: explicitResumeId } : {}),
        },
        context: {
          tools: toolResolutionContext,
        },
      },
    });

    const aggregate = result.aggregate;
    if (
      aggregate?.executionKind !== 'augment'
      || !aggregate.result
      || typeof aggregate.result !== 'object'
      || Array.isArray(aggregate.result)
    ) {
      return {};
    }

    return sanitizeEnvVarRecord(aggregate.result as Record<string, string>);
  }

  const authEnv: Record<string, string> = {};
  if (params.connectedServiceAuth?.env) {
    Object.assign(authEnv, params.connectedServiceAuth.env);
    cleanupOnFailure = connectedCleanupOnFailure;
    cleanupOnExit = connectedCleanupOnExit;
  }
  const sanitizedAuthEnv = stripSessionControlEnvOverrides(sanitizeEnvVarRecord(authEnv), {
    allowConnectedServiceMaterializerKeys: true,
  });

  let profileEnv: Record<string, string> = {};
  if (Object.keys(params.profileEnvironmentVariables).length > 0) {
    profileEnv = stripSessionControlEnvOverrides(sanitizeEnvVarRecord(params.profileEnvironmentVariables));
    params.logInfo(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
  } else {
    params.logDebug('[DAEMON RUN] No profile environment variables provided by caller; skipping profile env injection');
  }

  const explicitEnvKeysForChild = Array.from(new Set<string>([
    ...Object.keys(profileEnv),
    ...Object.keys(sanitizedAuthEnv),
  ]));

  const sessionProfileEnv: Record<string, string> = {};
  if (params.options.profileId !== undefined) {
    sessionProfileEnv.HAPPIER_SESSION_PROFILE_ID = params.options.profileId;
  }

  const expandedProfileEnv = expandEnvironmentVariables(
    { ...profileEnv, ...sessionProfileEnv },
    { ...params.processEnv, ...profileEnv, ...sessionProfileEnv },
  );
  const expandedAuthEnv = expandEnvironmentVariables(
    sanitizedAuthEnv,
    { ...params.processEnv, ...sanitizedAuthEnv },
  );

  let extraEnv = { ...expandedProfileEnv, ...expandedAuthEnv };
  runtimeSelectionEnv = extraEnv;
  params.logDebug(
    `[DAEMON RUN] Final environment variable set prepared (${Object.keys(extraEnv).length} vars)`,
  );

  const missingVarDetails = findUnexpandedAuthEnvironmentReferences(extraEnv);
  if (missingVarDetails.length > 0) {
    const errorMessage = buildAuthEnvUnexpandedErrorMessage(missingVarDetails);
    params.logWarn(
      `[DAEMON RUN] Environment variable expansion validation failed (${missingVarDetails.length} unresolved reference(s))`,
    );
    return {
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
      errorMessage,
      cleanupOnFailure,
      cleanupOnExit,
      ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
    };
  }

  if (!params.runtimePrerequisitesAlreadyResolved && (
    !params.daemonSpawnHooks?.resolveRuntimePrerequisites
    && backendTarget?.sourceKind === 'built_in'
  )) {
    const providerCliResolutionEnv = {
      ...params.processEnv,
      ...extraEnv,
      ...(params.happyHomeDir ? { HAPPIER_HOME_DIR: params.happyHomeDir } : {}),
    };
    // Every installed Agent is validated here, bundled or externally
    // contributed. An id the catalog no longer carries has no CLI runtime
    // metadata at all, which is the same "CLI unavailable" refusal rather than
    // an exception escaping the spawn path.
    const agentCliValidation = ((): Readonly<{ ok: true } | { ok: false; errorMessage: string }> => {
      try {
        if (resolveAgentCliLaunchSpec(backendTarget.backendId, { processEnv: providerCliResolutionEnv }) !== null) {
          return { ok: true };
        }
        return {
          ok: false,
          errorMessage: buildMissingAgentCliCommandErrorMessage(backendTarget.backendId, {
            processEnv: providerCliResolutionEnv,
          }),
        };
      } catch {
        return {
          ok: false,
          errorMessage:
            `Agent '${backendTarget.backendId}' has no CLI runtime metadata in the current Agent catalog.`,
        };
      }
    })();
    if (!agentCliValidation.ok) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: agentCliValidation.errorMessage,
        cleanupOnFailure,
        cleanupOnExit,
        ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
      };
    }
  }

  if (!params.runtimePrerequisitesAlreadyResolved && params.daemonSpawnHooks?.resolveRuntimePrerequisites) {
    const validation = await params.daemonSpawnHooks.resolveRuntimePrerequisites(buildRuntimeSelection());
    if (!validation.ok) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: validation.errorMessage,
        cleanupOnFailure,
        cleanupOnExit,
        ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
      };
    }
  }

  // Provider launches enter this function once after connection/grant
  // authorization and again after their final environment is materialized.
  // Plugin decisions run for both environments: the first pass protects the
  // authorization boundary, while the final pass validates settings and other
  // prerequisites selected by the materialized child environment.
  const shouldResolvePluginPrerequisites =
    params.providerBindingPrerequisitesOnly
    || !params.runtimePrerequisitesAlreadyResolved
    || params.pluginRuntimeRegistry !== undefined
    || params.providerBindingContext !== undefined;
  if (shouldResolvePluginPrerequisites) {
    const pluginSpawnDecision = await readPluginSpawnDecision();
    if (!pluginSpawnDecision.allowed) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: pluginSpawnDecision.errorMessage ?? 'Plugin spawn prerequisite hook denied daemon spawn.',
        cleanupOnFailure,
        cleanupOnExit,
        ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
      };
    }
  }

  if (params.providerBindingPrerequisitesOnly) {
    return {
      ok: true,
      expandedEnvironmentVariables: extraEnv,
      extraEnvForChild: {},
      unsetEnvKeys: [],
      providerEnvKeys: [],
      cleanupOnFailure,
      cleanupOnExit,
      ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
    };
  }

  const extraEnvForChild = { ...extraEnv };
  delete extraEnvForChild.TMUX_SESSION_NAME;
  delete extraEnvForChild.TMUX_TMPDIR;
  if (params.daemonSpawnHooks?.augmentEnv) {
    Object.assign(
      extraEnvForChild,
      stripSessionControlEnvOverrides(sanitizeEnvVarRecord(
        params.daemonSpawnHooks.augmentEnv(buildRuntimeSelection()),
      )),
    );
  }
  Object.assign(
    extraEnvForChild,
    stripSessionControlEnvOverrides(await readPluginSpawnEnvAugmentation()),
  );
  const lateProviderMaterialization = params.materializeProviderBindingAfterHooks
    ? await params.materializeProviderBindingAfterHooks()
    : null;
  if (lateProviderMaterialization && !lateProviderMaterialization.ok) {
    return {
      ok: false,
      errorCode: lateProviderMaterialization.errorCode,
      errorMessage: lateProviderMaterialization.errorMessage,
      ...(lateProviderMaterialization.providerError
        ? { providerError: lateProviderMaterialization.providerError }
        : {}),
      cleanupOnFailure,
      cleanupOnExit,
      ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
    };
  }
  cleanupOnFailure = chainCleanupCallbacks(
    cleanupOnFailure,
    lateProviderMaterialization?.cleanupOnFailure ?? null,
  );
  cleanupOnExit = chainCleanupCallbacks(
    cleanupOnExit,
    lateProviderMaterialization?.cleanupOnExit ?? null,
  );
  const parsedProviderOverlay = SessionEnvOverlayV1Schema.parse([
    ...(params.providerEnvironmentOverlay ?? []),
    ...(lateProviderMaterialization?.providerEnvironmentOverlay ?? []),
  ]);
  const providerEnv: Record<string, string> = {};
  const providerUnsetEnvKeys: string[] = [];
  for (const entry of parsedProviderOverlay) {
    if (entry.source !== 'provider') {
      throw new Error(`Provider environment overlay cannot contain '${entry.source}' operations.`);
    }
    if (isSessionControlEnvKey(entry.name)) continue;
    explicitEnvKeysForChild.push(entry.name);
    if (entry.value === null) providerUnsetEnvKeys.push(entry.name);
    else providerEnv[entry.name] = entry.value;
  }
  const providerUnsetIdentities = new Set(providerUnsetEnvKeys.map((name) => name.toLowerCase()));
  for (const key of Object.keys(extraEnvForChild)) {
    if (providerUnsetIdentities.has(key.toLowerCase())) {
      delete extraEnvForChild[key];
    }
  }
  Object.assign(extraEnvForChild, providerEnv);
  if (params.options.profileId !== undefined) {
    extraEnvForChild.HAPPIER_SESSION_PROFILE_ID = params.options.profileId;
  }
  if (params.options.transcriptStorage === 'direct') {
    extraEnvForChild.HAPPIER_TRANSCRIPT_STORAGE = 'direct';
  }
  if (params.options.attachMetadataIdentityPolicy) {
    extraEnvForChild.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY = params.options.attachMetadataIdentityPolicy;
  }
  if (params.options.mcpSelection) {
    extraEnvForChild.HAPPIER_SESSION_MCP_SELECTION_JSON = JSON.stringify(params.options.mcpSelection);
  }
  if (params.options.sessionConfigOptionOverrides) {
    extraEnvForChild.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify(params.options.sessionConfigOptionOverrides);
  }
  const connectedServicesBindingsJson = serializeSessionConnectedServicesBindingsForEnv(params.options.connectedServices);
  if (connectedServicesBindingsJson) {
    extraEnvForChild[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = connectedServicesBindingsJson;
  }
  const connectedServiceMaterializationIdentityJson =
    serializeSessionConnectedServiceMaterializationIdentityForEnv(
      params.options.connectedServiceMaterializationIdentityV1,
    );
  if (connectedServiceMaterializationIdentityJson) {
    extraEnvForChild[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY] =
      connectedServiceMaterializationIdentityJson;
  }
  extraEnvForChild[SESSION_REQUESTED_DIRECTORY_ENV] = params.options.directory;
  extraEnvForChild[SESSION_MACHINE_WORKSPACE_PATH_ENV] = params.options.directory;
  const uniqueExplicitEnvKeysForChild = Array.from(new Set(explicitEnvKeysForChild));
  if (uniqueExplicitEnvKeysForChild.length > 0) {
    extraEnvForChild[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR] = JSON.stringify(
      uniqueExplicitEnvKeysForChild,
    );
  }

  return {
    ok: true,
    expandedEnvironmentVariables: extraEnv,
    extraEnvForChild,
    unsetEnvKeys: Object.freeze([...providerUnsetEnvKeys]),
    providerEnvKeys: Object.freeze(Object.keys(providerEnv).concat(providerUnsetEnvKeys)),
    ...(lateProviderMaterialization
      ? { providerBindingLaunchHandoff: lateProviderMaterialization.providerBindingLaunchHandoff }
      : {}),
    cleanupOnFailure,
    cleanupOnExit,
    ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
  };
}
