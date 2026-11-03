import { isPluginError } from '@happier-dev/plugin-sdk';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { SpawnSessionErrorCode } from '@/session/shared/spawnSessionContract';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SessionEnvOverlayV1Schema } from '@happier-dev/protocol/spawn/envOverlay';
import { SessionIdentityAdditionsV1Schema } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { ProviderErrorV1, SessionEnvOverlayV1 } from '@happier-dev/protocol';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol';
import type { HostAgentIsolationLaunchContext } from '../agentIsolation/agentIsolationLaunchPolicy';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { ProviderBindingLaunchHandoffV1 } from '@/plugins/runtime/providerBindings/handoff';
import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol/providers/compatibility/v1';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { sanitizeEnvVarRecord } from '@/terminal/runtime/envVarSanitization';
import { normalizeUnsetEnvKeys, stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';
import {
  createDaemonSpawnToolResolutionContext,
  type DaemonSpawnHooks,
} from '../spawnHooks';
import { buildAuthEnvUnexpandedErrorMessage, findUnexpandedAuthEnvironmentReferences } from './authEnvValidation';
import {
  SESSION_DIRECTORY_KIND_ENV,
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
import {
  resolveQualifiedRequestAuthPurposeBindingsFromSnapshot,
  type AgentSpawnQualifiedPurposeBindingSnapshot,
} from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { buildMissingAgentCliCommandErrorMessage } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { detectNativeAgentCliAuthStatus } from '@/capabilities/cliAuth/detectNativeAgentCliAuthStatus';
import {
  resolveAgentCliLaunchSpecForSession,
  type AgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import {
  isSessionControlEnvKey,
  stripSessionControlEnvOverrides,
} from '@/session/runtime/control/sessionControlEnvironment';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveSpawnHookInstallablesRegistry } from './spawnHookInstallablesRegistry';
import { HAPPIER_SESSION_CREATE_ORIGIN_ENV_KEY, pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';
import { HAPPIER_SESSION_CREATE_MANAGER_ENV_KEY } from '@/session/shared/sessionCreateManager';
import { HAPPIER_SESSION_CREATE_ROLES_ENV_KEY } from '@/session/shared/sessionCreateRoles';
import { HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY } from '@/session/shared/sessionCreateAuthoringOrigin';
import { resolveExistingSessionHandoffState } from '@/session/handoff/agentBundle/import';
import { requiresAgentSessionCli } from '@/agent/catalog/runtimeEntry';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { resolveMemberRunnableAgentCliLaunch, type MemberAgentCliLaunchContext } from '@/plugins/runtime/exec/system/tools/agentCliBinding';

type ResolveSpawnChildEnvironmentSuccess = {
  ok: true;
  expandedEnvironmentVariables: Record<string, string>;
  extraEnvForChild: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  providerEnvKeys?: readonly string[];
  providerBindingLaunchHandoff?: ProviderBindingLaunchHandoffV1;
  /** Exact non-secret built-in Agent CLI launch admitted for this spawn. */
  agentCliLaunchSpec?: AgentCliLaunchSpec;
  cleanupOnFailure: (() => void | Promise<void>) | null;
  cleanupOnExit: (() => void | Promise<void>) | null;
  materializationDiagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
};

type ResolveSpawnChildEnvironmentFailure = {
  ok: false;
  errorCode: SpawnSessionErrorCode;
  errorMessage: string;
  agentId?: string;
  providerError?: ProviderErrorV1;
  cleanupOnFailure: (() => void | Promise<void>) | null;
  cleanupOnExit: (() => void | Promise<void>) | null;
  materializationDiagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
};

export type ResolveSpawnChildEnvironmentResult =
  | ResolveSpawnChildEnvironmentSuccess
  | ResolveSpawnChildEnvironmentFailure;

function expandSpawnProfileEnvironment(
  profileEnv: Readonly<Record<string, string>>,
  profileId: string | undefined,
  processEnv: NodeJS.ProcessEnv,
  allowNativeAccountCredentials = true,
): Record<string, string> {
  const sessionProfileEnv: Record<string, string> = profileId === undefined ? {} : { HAPPIER_SESSION_PROFILE_ID: profileId };
  return expandEnvironmentVariables(
    { ...profileEnv, ...sessionProfileEnv },
    { ...(allowNativeAccountCredentials ? processEnv : {}), ...profileEnv, ...sessionProfileEnv },
  );
}

/** Shared executable admission before Session commit and against the final launch environment. */
export async function validateSpawnAgentCliLaunch(input: Readonly<{
  memberAgentCliLaunch?: MemberAgentCliLaunchContext;
  agentId: string;
  options: SpawnSessionOptions;
  processEnv: NodeJS.ProcessEnv;
  happyHomeDir?: string;
  profileEnvironmentVariables?: Readonly<Record<string, string>>;
  allowNativeAccountCredentials?: boolean;
  pluginRuntimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  savedSecretOperationContext?: Parameters<typeof resolveAgentCliLaunchSpecForSession>[1]['savedSecretOperationContext'];
}>): Promise<Readonly<
  | { ok: true; launchSpec?: AgentCliLaunchSpec }
  | { ok: false; errorMessage: string; errorCode?: SpawnSessionErrorCode }
>> {
  const profileEnv = input.profileEnvironmentVariables
    ? expandSpawnProfileEnvironment(
      stripSessionControlEnvOverrides(sanitizeEnvVarRecord(input.profileEnvironmentVariables)),
      input.options.profileId, input.processEnv, input.allowNativeAccountCredentials,
    ) : {};
  const resolutionOptions = {
    processEnv: { ...input.processEnv, ...profileEnv,
      ...(input.happyHomeDir ? { HAPPIER_HOME_DIR: input.happyHomeDir } : {}) },
    ...(input.pluginRuntimeRegistry ? { catalogSnapshot: input.pluginRuntimeRegistry.contributes } : {}),
  };
  if (input.memberAgentCliLaunch && input.pluginRuntimeRegistry
    && !requiresAgentSessionCli(input.agentId, input.pluginRuntimeRegistry)) return { ok: true };
  let launchSpec: AgentCliLaunchSpec | null;
  try {
    launchSpec = input.memberAgentCliLaunch ? await resolveMemberRunnableAgentCliLaunch({
      agentId: input.agentId, runtimeSpec: resolveAgentCliRuntimeSpecForLookupId(input.agentId, resolutionOptions),
      processEnv: resolutionOptions.processEnv, memberLaunch: input.memberAgentCliLaunch,
    }) : await resolveAgentCliLaunchSpecForSession(input.agentId, {
      ...resolutionOptions, options: input.options, savedSecretOperationContext: input.savedSecretOperationContext,
    });
  } catch (error) {
    if (!isPluginError(error) || error.code !== 'agent_cli_not_runnable') throw error;
    return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: error.code };
  }
  if (launchSpec !== null) return { ok: true, launchSpec };
  // Only an admitted, current native Session factory proves that no CLI is required.
  if (input.pluginRuntimeRegistry && !requiresAgentSessionCli(input.agentId, input.pluginRuntimeRegistry)) {
    return { ok: true };
  }
  try {
    return { ok: false, errorMessage: buildMissingAgentCliCommandErrorMessage(input.agentId, resolutionOptions) };
  } catch {
    return { ok: false, errorMessage: `Agent '${input.agentId}' has no CLI runtime metadata in the current Agent catalog.` };
  }
}

type LateProviderBindingMaterialization =
  | Readonly<{
      ok: true;
      providerEnvironmentOverlay: SessionEnvOverlayV1;
      providerBindingLaunchHandoff: ProviderBindingLaunchHandoffV1;
      cleanupOnFailure?: (() => void | Promise<void>) | null;
      cleanupOnExit?: (() => void | Promise<void>) | null;
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

type DaemonSpawnConnectedServicesProjection = NonNullable<
  Parameters<NonNullable<DaemonSpawnHooks['resolveRuntimePrerequisites']>>[0]['connectedServices']
>;

function projectDaemonSpawnConnectedServices(
  value: unknown,
): DaemonSpawnConnectedServicesProjection | undefined {
  try {
    const parsed = ConnectedServiceBindingsV2IngressSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const bindingsByServiceId: Record<
      string,
      DaemonSpawnConnectedServicesProjection['bindingsByServiceId'][string]
    > = {};
    for (const [serviceId, binding] of Object.entries(parsed.data.bindingsByServiceId)) {
      // The legacy Agent daemon-spawn hook cannot represent revision-bound team
      // resource authority. Never down-project it into native/connected V1.
      if (binding.source === 'team_resource') return undefined;
      if (binding.source === 'native') {
        bindingsByServiceId[serviceId] = Object.freeze({ source: 'native' as const });
        continue;
      }
      if (binding.selection === 'profile') {
        bindingsByServiceId[serviceId] = Object.freeze({
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: binding.profileId,
        });
        continue;
      }
      bindingsByServiceId[serviceId] = Object.freeze({
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: binding.groupId,
        ...(binding.profileId ? { profileId: binding.profileId } : {}),
      });
    }
    return Object.freeze({
      v: 1,
      bindingsByServiceId: Object.freeze(bindingsByServiceId),
    });
  } catch {
    return undefined;
  }
}

function chainCleanupCallbacks(
  first: (() => void | Promise<void>) | null,
  second: (() => void | Promise<void>) | null,
): (() => void | Promise<void>) | null {
  if (!first) return second;
  if (!second) return first;
  return async () => {
    try { await first(); } finally { await second(); }
  };
}

export async function resolveSpawnChildEnvironment(params: {
  agentIsolation?: HostAgentIsolationLaunchContext;
  memberAgentCliLaunch?: MemberAgentCliLaunchContext;
  savedSecretOperationContext?: import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationContextV1;
  happyHomeDir?: string;
  pluginRuntimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  options: SpawnSessionOptions;
  existingSessionMetadata?: Readonly<Record<string, unknown>> | null;
  /** Home-written inference witness from this Session's protected attach, never Spawn options. */
  acceptedTeamCredentialBinding?: import('@happier-dev/protocol/teams/credentials/sessionBindingIntentV1').SessionTeamCredentialBindingIntentV1 | null;
  /** Registry-resolved routing id for a canonical `agentTarget`. */
  resolvedAgentId?: string | null;
  profileEnvironmentVariables: Record<string, string>;
  daemonSpawnHooks: DaemonSpawnHooks | null;
  processEnv: NodeJS.ProcessEnv;
  logDebug: (message: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  connectedServiceAuth?: {
    env: Record<string, string>;
    unsetEnvKeys?: readonly string[];
    cleanupOnFailure: (() => void | Promise<void>) | null;
    cleanupOnExit: (() => void | Promise<void>) | null;
    diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
    targetMaterializedRoot?: string | null;
    qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  } | null;
  providerEnvironmentOverlay?: SessionEnvOverlayV1;
  materializeProviderBindingAfterHooks?: () => Promise<LateProviderBindingMaterialization>;
  providerBindingContext?: ProviderBindingPrerequisiteContext;
  providerBindingPrerequisitesOnly?: boolean;
  runtimePrerequisitesAlreadyResolved?: boolean;
  allowNativeAccountCredentials?: boolean;
}): Promise<ResolveSpawnChildEnvironmentResult> {
  try {
    return await resolveSpawnChildEnvironmentImpl(params);
  } catch (error) {
    try {
      await params.connectedServiceAuth?.cleanupOnFailure?.();
    } catch (cleanupError) {
      params.logWarn(
        '[DAEMON RUN] Failed to clean connected-service materialization after environment resolution error',
      );
    }
    throw error;
  }
}

async function resolveSpawnChildEnvironmentImpl(params: {
  agentIsolation?: HostAgentIsolationLaunchContext;
  memberAgentCliLaunch?: MemberAgentCliLaunchContext;
  savedSecretOperationContext?: import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationContextV1;
  happyHomeDir?: string;
  pluginRuntimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  options: SpawnSessionOptions;
  existingSessionMetadata?: Readonly<Record<string, unknown>> | null;
  acceptedTeamCredentialBinding?: import('@happier-dev/protocol/teams/credentials/sessionBindingIntentV1').SessionTeamCredentialBindingIntentV1 | null;
  resolvedAgentId?: string | null;
  profileEnvironmentVariables: Record<string, string>;
  daemonSpawnHooks: DaemonSpawnHooks | null;
  processEnv: NodeJS.ProcessEnv;
  logDebug: (message: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  connectedServiceAuth?: {
    env: Record<string, string>;
    unsetEnvKeys?: readonly string[];
    cleanupOnFailure: (() => void | Promise<void>) | null;
    cleanupOnExit: (() => void | Promise<void>) | null;
    diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
    targetMaterializedRoot?: string | null;
    qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  } | null;
  providerEnvironmentOverlay?: SessionEnvOverlayV1;
  materializeProviderBindingAfterHooks?: () => Promise<LateProviderBindingMaterialization>;
  providerBindingContext?: ProviderBindingPrerequisiteContext;
  providerBindingPrerequisitesOnly?: boolean;
  runtimePrerequisitesAlreadyResolved?: boolean;
  allowNativeAccountCredentials?: boolean;
}): Promise<ResolveSpawnChildEnvironmentResult> {
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  const recordEnvironmentPhase = (phase: string): void => {
    const now = performance.now();
    params.logInfo(`[DAEMON RUN] Child environment phase ${phase}: durationMs=${Math.round(now - phaseStartedAt)} elapsedMs=${Math.round(now - startedAt)}`);
    phaseStartedAt = now;
  };
  const connectedCleanupOnFailure = params.connectedServiceAuth?.cleanupOnFailure ?? null;
  const connectedCleanupOnExit = params.connectedServiceAuth?.cleanupOnExit ?? null;
  const materializationDiagnostics = params.connectedServiceAuth?.diagnostics;

  const backendTarget = resolveConcreteBackendTargetRefV2(params.options.backendTarget);
  const normalizedResolvedAgentId = typeof params.resolvedAgentId === 'string'
    && params.resolvedAgentId.trim().length > 0
    ? params.resolvedAgentId.trim()
    : null;
  const resolvedAgentId = normalizedResolvedAgentId
    ?? (backendTarget?.sourceKind === 'built_in' ? backendTarget.backendId : null);
  const selectedAgentCredentialEnvironmentVariables = resolvedAgentId
    ? params.pluginRuntimeRegistry?.contributes.agentDefinitionsById
      .get(resolvedAgentId)?.cliMetadata?.auth.environmentVariables ?? []
    : [];
  const explicitResumeId = readNonBlankOpaqueIdentifier(params.options.resume);
  const runtimeDescriptorV1 = readCanonicalSpawnRuntimeSelection(params.options).runtimeDescriptorV1;
  const connectedServices = projectDaemonSpawnConnectedServices(
    params.options.connectedServices,
  );
  const spawnHookTimestampMs = () => Date.now();
  const spawnHookBackendId = resolvedAgentId ?? backendTarget?.backendId;
  const createToolResolutionContext = (signal?: AbortSignal) =>
    createDaemonSpawnToolResolutionContext({
      processEnv: params.processEnv,
      ...(signal ? { signal } : {}),
      installablesRegistry: () => resolveSpawnHookInstallablesRegistry(
        params.happyHomeDir,
        params.pluginRuntimeRegistry
          ? { contributions: params.pluginRuntimeRegistry.contributes }
          : {},
      ),
      logInfo: params.logInfo,
      logWarn: params.logWarn,
    });
  const toolResolutionContext = createToolResolutionContext();

  let cleanupOnFailure: (() => void | Promise<void>) | null = null;
  let cleanupOnExit: (() => void | Promise<void>) | null = null;

  let runtimeSelectionEnv: Record<string, string> = {};

  function buildRuntimeSelectionPayload() {
    return {
      ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
      ...(params.providerBindingContext ? { hasExternalModelBinding: true as const } : {}),
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
        agentId: resolvedAgentId ?? undefined,
        backendId: spawnHookBackendId,
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
        contextFactory: ({ signal }) => ({
          signal,
          tools: createToolResolutionContext(signal),
        }),
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
        agentId: resolvedAgentId ?? undefined,
        backendId: spawnHookBackendId,
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
        contextFactory: ({ signal }) => ({
          signal,
          tools: createToolResolutionContext(signal),
        }),
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

  const expandedProfileEnv = expandSpawnProfileEnvironment(
    profileEnv, params.options.profileId, params.processEnv, params.allowNativeAccountCredentials,
  );
  // Connected Account materialization is producer-authored credential output,
  // not a profile template. Preserve its bytes exactly even when a secret
  // happens to contain `${NAME}` that exists in the daemon environment.
  const literalAuthEnv = sanitizedAuthEnv;

  let extraEnv = { ...expandedProfileEnv, ...literalAuthEnv };
  runtimeSelectionEnv = extraEnv;
  params.logDebug(
    `[DAEMON RUN] Final environment variable set prepared (${Object.keys(extraEnv).length} vars)`,
  );

  async function validateAgentCliLaunch(agentId: string, processEnv: NodeJS.ProcessEnv): Promise<Readonly<
    | { ok: true; launchSpec?: AgentCliLaunchSpec }
    | { ok: false; errorMessage: string; errorCode?: SpawnSessionErrorCode }
  >> {
    return validateSpawnAgentCliLaunch({ agentId, processEnv, options: params.options,
      memberAgentCliLaunch: params.memberAgentCliLaunch,
      pluginRuntimeRegistry: params.pluginRuntimeRegistry,
      savedSecretOperationContext: params.savedSecretOperationContext });
  }

  let agentCliLaunchSpec: AgentCliLaunchSpec | undefined;
  const preliminaryIsolation = params.providerBindingPrerequisitesOnly ? params.agentIsolation?.read() : undefined;
  const memberLaunchPending = preliminaryIsolation
    && resolveMachineAgentExecutionPlacementV1({ policy: preliminaryIsolation, platform: process.platform }) === 'member';
  if (resolvedAgentId && !memberLaunchPending && !params.memberAgentCliLaunch) {
    // Admission precedes prerequisite hooks: dependency setup cannot substitute
    // for the Agent executable or start a download for a missing Agent.
    const agentCliValidation = await validateAgentCliLaunch(resolvedAgentId, {
      ...params.processEnv,
      ...extraEnv,
      ...(params.happyHomeDir ? { HAPPIER_HOME_DIR: params.happyHomeDir } : {}),
    });
    if (!agentCliValidation.ok) {
      return {
        ok: false,
        errorCode: agentCliValidation.errorCode ?? SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
        errorMessage: agentCliValidation.errorMessage,
        agentId: resolvedAgentId,
        cleanupOnFailure,
        cleanupOnExit,
        ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
      };
    }
    agentCliLaunchSpec = agentCliValidation.launchSpec;
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

  recordEnvironmentPhase('agent_prerequisites');
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

  recordEnvironmentPhase('plugin_prerequisites');
  if (params.providerBindingPrerequisitesOnly) {
    return {
      ok: true,
      expandedEnvironmentVariables: extraEnv,
      extraEnvForChild: {},
      unsetEnvKeys: [],
      providerEnvKeys: [],
      ...(agentCliLaunchSpec ? { agentCliLaunchSpec } : {}),
      cleanupOnFailure,
      cleanupOnExit,
      ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
    };
  }

  let extraEnvForChild = { ...extraEnv };
  const literalReplacementEnvironmentKeys = new Set<string>();
  delete extraEnvForChild.TMUX_SESSION_NAME;
  delete extraEnvForChild.TMUX_TMPDIR;
  if (params.daemonSpawnHooks?.augmentEnv) {
    let augmentedEnvironment: Record<string, string>;
    try {
      augmentedEnvironment = stripSessionControlEnvOverrides(sanitizeEnvVarRecord(
        params.daemonSpawnHooks.augmentEnv(buildRuntimeSelection()),
      ));
    } catch {
      params.logWarn('[DAEMON RUN] Agent daemon spawn environment hook failed');
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'Agent daemon spawn environment hook failed.',
        cleanupOnFailure,
        cleanupOnExit,
        ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
      };
    }
    Object.assign(
      extraEnvForChild,
      augmentedEnvironment,
    );
    for (const name of Object.keys(augmentedEnvironment)) {
      literalReplacementEnvironmentKeys.add(name);
    }
  }
  const pluginAugmentedEnvironment = stripSessionControlEnvOverrides(
    await readPluginSpawnEnvAugmentation(),
  );
  recordEnvironmentPhase('environment_hooks');
  Object.assign(extraEnvForChild, pluginAugmentedEnvironment);
  for (const name of Object.keys(pluginAugmentedEnvironment)) {
    literalReplacementEnvironmentKeys.add(name);
  }
  const lateProviderMaterialization = params.materializeProviderBindingAfterHooks
    ? await params.materializeProviderBindingAfterHooks()
    : null;
  recordEnvironmentPhase('provider_materialization');
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
    else {
      providerEnv[entry.name] = entry.value;
      literalReplacementEnvironmentKeys.add(entry.name);
    }
  }
  const providerUnsetIdentities = new Set(providerUnsetEnvKeys.map((name) => name.toLowerCase()));
  if (params.allowNativeAccountCredentials === false && resolvedAgentId) {
    const entry = params.pluginRuntimeRegistry?.acquireAgentCatalogEntry
      ? await params.pluginRuntimeRegistry.acquireAgentCatalogEntry(resolvedAgentId)
      : params.pluginRuntimeRegistry?.contributes.catalogEntriesById[resolvedAgentId];
    const descriptor = await entry?.getConnectedServiceStateSharingDescriptor?.();
    const homeKey = descriptor?.nativeHome?.environmentKey;
    const root = params.connectedServiceAuth?.targetMaterializedRoot;
    // Only the actual materializer's isolated requester home can replace the
    // custodian's native login/configuration. An API key alone proves neither.
    if (!homeKey || !root || sanitizedAuthEnv[homeKey] !== root) return {
      ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Requester Agent credential isolation unavailable', agentId: resolvedAgentId,
      cleanupOnFailure, cleanupOnExit, ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
    };
    const rawRequirements = params.pluginRuntimeRegistry?.contributes.agentDefinitionsById.get(resolvedAgentId)?.definition.providerRequirements;
    const requirements = AgentProviderRequirementsV1Schema.safeParse(rawRequirements);
    const inheritedCredentialKeys = new Set([
      ...selectedAgentCredentialEnvironmentVariables,
      ...(requirements.success ? requirements.data.authIsolation.ownedEnvKeys : []),
    ]);
    for (const name of inheritedCredentialKeys) {
      if (Object.hasOwn(sanitizedAuthEnv, name) || Object.hasOwn(providerEnv, name) || Object.hasOwn(expandedProfileEnv, name)) continue;
      delete extraEnvForChild[name];
      providerUnsetEnvKeys.push(name);
      providerUnsetIdentities.add(name.toLowerCase());
    }
  }
  for (const key of Object.keys(extraEnvForChild)) {
    if (providerUnsetIdentities.has(key.toLowerCase())) {
      delete extraEnvForChild[key];
    }
  }
  Object.assign(extraEnvForChild, providerEnv);
  const unsetEnvKeys = normalizeUnsetEnvKeys([
    ...(params.connectedServiceAuth?.unsetEnvKeys ?? []),
    ...providerUnsetEnvKeys,
  ]);
  extraEnvForChild = stripUnsetEnvironmentVariables(extraEnvForChild, unsetEnvKeys);
  const survivingProfileCredentialEnvironmentVariables =
    selectedAgentCredentialEnvironmentVariables.filter((name) => (
      Object.prototype.hasOwnProperty.call(expandedProfileEnv, name)
      && !Object.prototype.hasOwnProperty.call(literalAuthEnv, name)
      && extraEnvForChild[name] === expandedProfileEnv[name]
      && !literalReplacementEnvironmentKeys.has(name)
    ));
  const missingVarDetails = findUnexpandedAuthEnvironmentReferences(
    extraEnvForChild,
    survivingProfileCredentialEnvironmentVariables,
  );
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
  const effectiveAgentEnvironment: NodeJS.ProcessEnv = {
      ...params.processEnv,
      ...extraEnvForChild,
      ...(params.happyHomeDir ? { HAPPIER_HOME_DIR: params.happyHomeDir } : {}),
  };
  for (const key of Object.keys(effectiveAgentEnvironment)) {
    if (providerUnsetIdentities.has(key.toLowerCase())) delete effectiveAgentEnvironment[key];
  }
  if (params.options.handoffStateTransfer === 'existing') {
    try {
      if (!params.existingSessionMetadata || !explicitResumeId) throw new Error('Existing Session metadata is unavailable');
      const state = await resolveExistingSessionHandoffState({ metadata: { ...params.existingSessionMetadata },
        targetPath: params.options.directory, sessionStorageMode: params.options.transcriptStorage,
        environmentVariables: Object.fromEntries(Object.entries(effectiveAgentEnvironment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
      if (state.remoteSessionId !== explicitResumeId) throw new Error('Existing native Session identity changed before launch');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'existing_session_state_verification_failed';
      return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: `${code}: ${error instanceof Error ? error.message : 'Existing native state could not be verified'}`,
        cleanupOnFailure, cleanupOnExit, ...(materializationDiagnostics ? { materializationDiagnostics } : {}) };
    }
  }
  if (resolvedAgentId) {
    const validation = await validateAgentCliLaunch(resolvedAgentId, effectiveAgentEnvironment);
    if (!validation.ok) {
      return {
        ok: false,
        errorCode: validation.errorCode ?? SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
        errorMessage: validation.errorMessage,
        agentId: resolvedAgentId,
        cleanupOnFailure,
        cleanupOnExit,
        ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
      };
    }
    agentCliLaunchSpec = validation.launchSpec;
    const agentIdentity = params.pluginRuntimeRegistry?.contributes.agentDefinitionsById.get(resolvedAgentId)?.identity;
    const hasConnectedAccountRequestAuth = agentIdentity && resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
      params.connectedServiceAuth?.qualifiedPurposeBindingSnapshot ?? null,
    ).some(({ purpose }) => purpose.consumer.pluginId === agentIdentity.pluginId
      && purpose.consumer.localId === agentIdentity.localId);
    const acceptedTeamBinding = params.acceptedTeamCredentialBinding;
    const hasAcceptedTeamBrokerInference = Boolean(params.options.existingSessionId
      && acceptedTeamBinding?.slot.kind === 'provider_model'
      && acceptedTeamBinding.resourceId !== null
      && acceptedTeamBinding.deliveryMode === 'brokered');
    // The admitted Provider route owns credential transport. External bindings
    // materialize above; managed bindings materialize after Session admission.
    // Qualified Connected Account request-auth also owns its transport; none
    // of these routes require the Agent's unrelated native sign-in.
    const auth = !agentCliLaunchSpec || params.providerBindingContext || hasConnectedAccountRequestAuth || hasAcceptedTeamBrokerInference
      ? null
      : await detectNativeAgentCliAuthStatus({
        agentId: resolvedAgentId,
        resolvedPath: agentCliLaunchSpec.resolvedPath,
        processEnv: effectiveAgentEnvironment,
        ...(params.pluginRuntimeRegistry ? {
          authSpec: await (params.pluginRuntimeRegistry.acquireAgentCatalogEntry
            ? await params.pluginRuntimeRegistry.acquireAgentCatalogEntry(resolvedAgentId)
            : params.pluginRuntimeRegistry.contributes.catalogEntriesById[resolvedAgentId]
          )?.getCliAuthSpec?.() ?? null,
        } : {}),
      });
    if (auth?.state === 'logged_out') {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
        errorMessage: `Sign in to Agent '${resolvedAgentId}' before starting a session.`,
        agentId: resolvedAgentId,
        cleanupOnFailure,
        cleanupOnExit,
        ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
      };
    }
  }
  recordEnvironmentPhase('native_auth_and_state');
  if (params.options.profileId !== undefined) {
    extraEnvForChild.HAPPIER_SESSION_PROFILE_ID = params.options.profileId;
  }
  if (params.options.transcriptStorage === 'direct') {
    extraEnvForChild.HAPPIER_TRANSCRIPT_STORAGE = 'direct';
  }
  if (params.options.attachMetadataIdentityPolicy) {
    extraEnvForChild.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY = params.options.attachMetadataIdentityPolicy;
  }
  if (!params.options.existingSessionId
    && (params.options.allowedTools !== undefined || params.options.unlistedTools !== undefined)) {
    extraEnvForChild.HAPPIER_SESSION_TOOL_POLICY_JSON = JSON.stringify({
      allowedTools: params.options.allowedTools,
      unlistedTools: params.options.unlistedTools,
    });
  }
  if (params.options.sessionConfigOptionOverrides) {
    extraEnvForChild.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify(params.options.sessionConfigOptionOverrides);
  }
  if (!params.options.existingSessionId && params.options.identity !== undefined) {
    extraEnvForChild.HAPPIER_SESSION_INITIAL_IDENTITY_JSON = JSON.stringify(
      SessionIdentityAdditionsV1Schema.parse(params.options.identity),
    );
  }
  if (!params.options.existingSessionId && params.options.memoryEnabled !== undefined) {
    extraEnvForChild.HAPPIER_SESSION_INITIAL_MEMORY_ENABLED = JSON.stringify(params.options.memoryEnabled);
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
  if (params.options.directoryKind === 'managed') {
    extraEnvForChild[SESSION_DIRECTORY_KIND_ENV] = 'managed';
  }
  const createOrigin = params.options.existingSessionId ? {} : pickSessionCreateOriginFields(params.options);
  if (!params.options.existingSessionId && params.options.authoringOrigin !== undefined) {
    extraEnvForChild[HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY] = JSON.stringify(params.options.authoringOrigin);
  }
  if (!params.options.existingSessionId && params.options.initialSessionRolesV1 !== undefined) {
    extraEnvForChild[HAPPIER_SESSION_CREATE_ROLES_ENV_KEY] = JSON.stringify(params.options.initialSessionRolesV1);
  }
  if (!params.options.existingSessionId && params.options.manager !== undefined) {
    extraEnvForChild[HAPPIER_SESSION_CREATE_MANAGER_ENV_KEY] = JSON.stringify(params.options.manager);
  }
  if (Object.keys(createOrigin).length > 0) {
    extraEnvForChild[HAPPIER_SESSION_CREATE_ORIGIN_ENV_KEY] = JSON.stringify(createOrigin);
  }
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
    unsetEnvKeys,
    providerEnvKeys: Object.freeze(Object.keys(providerEnv).concat(providerUnsetEnvKeys)),
    ...(lateProviderMaterialization
      ? { providerBindingLaunchHandoff: lateProviderMaterialization.providerBindingLaunchHandoff }
      : {}),
    ...(agentCliLaunchSpec ? { agentCliLaunchSpec } : {}),
    cleanupOnFailure,
    cleanupOnExit,
    ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
  };
}
