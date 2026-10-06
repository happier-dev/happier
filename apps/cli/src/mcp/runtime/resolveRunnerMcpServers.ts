import type { McpServerConfig } from '@/agent';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import type { ExecutionRunOccurrenceWitnessV1 } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { readSessionMcpSelectionV1FromMetadata } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { isSharedSavedSecretReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SESSION_RUN_PROMPT_READ_ACTION_IDS_V1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { AccountSettings, ActionExecutorDeps, SessionRunPromptReadActionIdV1 } from '@happier-dev/protocol';

import { readMcpServersSettingsFromAccountSettings } from '../servers/readMcpServersSettingsFromAccountSettings';
import { resolveManagedSessionMcpSelectionForDirectory } from '../servers/resolveManagedSessionMcpSelectionForDirectory';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '../servers/resolveMcpValueRefPlaintext';
import { materializeMcpServerConfigRecord } from '../servers/materializeMcpServerConfigRecord';
import { mergeWithBuiltInHappierMcpServer } from '../servers/mergeWithBuiltInHappierMcpServer';
import {
  createSavedSecretMaterializerV1,
  SavedSecretResolutionError,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';
import {
  refreshSavedSecretCatalogForOperation,
  savedSecretOperationAdmissionStatus,
  SavedSecretOperationAdmissionError,
} from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

import type { HappyMcpSessionClient } from '../startHappyServer';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

/**
 * The exact Session-owned Run whose authority this MCP profile serves.
 *
 * `readCurrentRunOccurrence` projects the bridge's canonical controller entry,
 * deliberately read per request: the built-in Happier server is rebuilt for each
 * MCP call, so a resumed or replaced controller occurrence must stop supplying
 * authority without rebuilding the server.
 */
export type ExecutionRunMcpBinding = Readonly<{
  runId: string;
  /** Trusted absolute depth from this Run's canonical host manager. */
  workDepth: number;
  /** The Run's working location; the parent Session remains the resource scope. */
  cwd: string;
  /** The Run runtime's own lifetime, not the parent Session's. */
  signal: AbortSignal;
  isCurrent: () => boolean;
  getPermissionMode?: NonNullable<HappyMcpSessionClient['getPermissionMode']>;
  /** This Run's own admitted turn; `null` between turns and once superseded. */
  readActiveTurnAdmissionWitness: () => AgentInvocationTurnAdmissionWitness | null;
  readCurrentRunOccurrence: (runId: string) => ExecutionRunOccurrenceWitnessV1 | null;
}>;

function createRunScopedMcpSessionView(
  session: HappyMcpSessionClient,
  run: ExecutionRunMcpBinding,
): HappyMcpSessionClient {
  const readWitness = (): AgentInvocationTurnAdmissionWitness | null => {
    // Currentness is the occurrence owner's answer, never the caller's guess.
    if (!run.readCurrentRunOccurrence(run.runId)) return null;
    return run.readActiveTurnAdmissionWitness();
  };
  return {
    ...session,
    // Class prototype methods are not preserved by object spread. Forward the
    // admitted Session transport's immutable Home binding explicitly so a
    // Run-scoped MCP view cannot fall back to ambient Home configuration.
    getServerBinding: () => session.getServerBinding(),
    ...(session.getBackendTarget ? { getBackendTarget: () => session.getBackendTarget!() } : {}),
    ...(session.getMetadataSnapshot ? { getMetadataSnapshot: () => session.getMetadataSnapshot!() } : {}),
    ...(session.getMachineAdmissionTransport
      ? { getMachineAdmissionTransport: () => session.getMachineAdmissionTransport!() }
      : {}),
    ...(session.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: () => session.getServerFeaturesSnapshot!() }
      : {}),
    ...(session.getStoredContentEncryptionContext
      ? { getStoredContentEncryptionContext: () => session.getStoredContentEncryptionContext!() }
      : {}),
    getPermissionMode: () => run.getPermissionMode ? run.getPermissionMode() : session.getPermissionMode?.(),
    getWorkDepth: () => run.workDepth,
    getAgentStartRunCaller: () => run.isCurrent() && !run.signal.aborted && run.readCurrentRunOccurrence(run.runId)
      ? { hostSessionId: session.sessionId, callingRunId: run.runId, callingRunDepth: run.workDepth }
      : null,
    getActiveTurnPermissionWitness: () => {
      const witness = readWitness();
      return witness
        ? {
          turnId: witness.turnId,
          workDepth: run.workDepth,
          ...(witness.causalPermissionAuthority
            ? { causalPermissionAuthority: witness.causalPermissionAuthority }
            : {}),
        }
        : null;
    },
    getActiveTurnAdmissionWitness: readWitness,
    getRuntimeLifetimeSignal: () => run.signal,
    getSessionActionConfirmationBinding: () => {
      const occurrence = run.readCurrentRunOccurrence(run.runId);
      const witness = occurrence ? run.readActiveTurnAdmissionWitness() : null;
      if (!occurrence || !witness) return null;
      const { occurrenceId, sidechainId } = occurrence;
      return {
        turnId: witness.turnId,
        lifetimeSignal: run.signal,
        // A superseded occurrence, a retired turn, or a cancelled controller all
        // retire an already issued confirmation without a second decision owner.
        isCurrent: () => {
          const current = run.readCurrentRunOccurrence(run.runId);
          return current?.occurrenceId === occurrenceId
            && run.isCurrent()
            && run.readActiveTurnAdmissionWitness()?.turnId === witness.turnId;
        },
        run: { runId: run.runId, occurrenceId, sidechainId },
      };
    },
    getCurrentSessionLocation: () => ({
      ...(session.getCurrentSessionLocation?.() ?? {}),
      path: run.cwd,
    }),
  };
}

export async function resolveRunnerMcpServers(params: Readonly<{
  session: HappyMcpSessionClient;
  credentials: StoredCredentials;
  /** Account-wide Action authority; explicit null keeps the runtime Session-scoped. */
  accountCredentials?: StoredCredentials | null;
  sessionList?: ActionExecutorDeps['sessionList'];
  accountSettings: AccountSettings | null;
  /** Exact runtime policy when ambient Account settings are intentionally unavailable. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  /** Exact caller-owned registry lease for daemonless scoped runtimes. */
  pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
  machineId: string;
  directory: string;
  sessionMetadata?: Readonly<Record<string, unknown>> | null;
  env?: NodeJS.ProcessEnv;
  tmpDir?: string | null;
  commandMode?: NonNullable<Parameters<typeof createHappierMcpBridge>[1]>['commandMode'];
  resolvedMcpServers?: Record<string, McpServerConfig>;
  /**
   * Binds this resolution to one Session-owned Execution Run occurrence.
   *
   * The parent Session stays the resource scope and keeps its own configured
   * server profile; only permission mode, working location, runtime lifetime and
   * turn authority come from the Run. The Run's concurrently active parent turn
   * is never substituted for it.
   */
  executionRun?: ExecutionRunMcpBinding;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: import('@/settings/secrets/savedSecretCatalog').SavedSecretCatalogState;
}>): Promise<Readonly<{
  happierMcpServer: {
    url: string;
    supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[];
    stop: () => void;
  };
  mcpServers: Record<string, McpServerConfig>;
  }>> {
  const env = params.env ?? process.env;
  const accountCredentials = Object.hasOwn(params, 'accountCredentials')
    ? params.accountCredentials ?? null
    : params.credentials;
  let accountSettings = accountCredentials ? params.accountSettings ?? null : null;
  let savedSecretResources = params.savedSecretResources;
  let savedSecretCatalogState = params.savedSecretCatalogState;

  const run = params.executionRun;
  const scopedSession: HappyMcpSessionClient = run
    ? createRunScopedMcpSessionView(params.session, run)
    : params.session;
  let mcpSettings = accountSettings ? readMcpServersSettingsFromAccountSettings(accountSettings) : null;
  let resolvedSelection: ReturnType<typeof resolveManagedSessionMcpSelectionForDirectory> | null = null;
  if (mcpSettings && accountCredentials) {
    const selection = readSessionMcpSelectionV1FromMetadata(params.sessionMetadata ?? null);
    const initialSelection = resolveManagedSessionMcpSelectionForDirectory({
      settings: mcpSettings,
      machineId: params.machineId,
      directory: params.directory,
      selection,
    });
    const sharedReferences = new Map<string, { ref: string }>();
    for (const item of Object.values(initialSelection.selectedServersByName)) {
      if (item.enabled !== true) continue;
      for (const valueRef of [
        ...Object.values(item.config.env),
        ...Object.values(item.config.remote?.headers ?? {}),
      ]) {
        if (valueRef.t === 'savedSecret' && isSharedSavedSecretReferenceV1(valueRef.secretId)) {
          sharedReferences.set(valueRef.secretId, { ref: valueRef.secretId });
        }
      }
    }
    if (sharedReferences.size > 0) {
      let admitted: Awaited<ReturnType<typeof refreshSavedSecretCatalogForOperation>>;
      try {
        admitted = await refreshSavedSecretCatalogForOperation({
          expectedScopeKey: resolveAccountSettingsScopeKeyForToken(accountCredentials.token),
          references: [...sharedReferences.values()],
          ...(run?.signal ? { signal: run.signal } : {}),
        });
      } catch (error) {
        if (error instanceof SavedSecretOperationAdmissionError) {
          throw new SavedSecretResolutionError({
            status: savedSecretOperationAdmissionStatus(error.reason),
            reference: error.reference,
            consumer: 'mcp',
            field: 'operation',
          });
        }
        throw error;
      }
      accountSettings = admitted.settings;
      savedSecretResources = admitted.savedSecretResources;
      savedSecretCatalogState = admitted.savedSecretCatalogState;
      mcpSettings = readMcpServersSettingsFromAccountSettings(accountSettings);
    }
    resolvedSelection = resolveManagedSessionMcpSelectionForDirectory({
      settings: mcpSettings,
      machineId: params.machineId,
      directory: params.directory,
      selection,
    });
  }
  const builtIn = await createHappierMcpBridge(scopedSession, {
    commandMode: params.commandMode,
    sessionCredentials: params.credentials,
    credentials: accountCredentials,
    authorityScope: accountCredentials ? 'account' : 'session',
    ...(params.sessionList ? { sessionList: params.sessionList } : {}),
    accountSettings,
    ...(params.actionsSettingsProvider
      ? { actionsSettingsProvider: params.actionsSettingsProvider }
      : {}),
    ...(params.pluginRuntimeRegistryLease
      ? { pluginRuntimeRegistryLease: params.pluginRuntimeRegistryLease }
      : {}),
    requiredDirectActionIds: run ? SESSION_RUN_PROMPT_READ_ACTION_IDS_V1 : undefined,
  });

  if (!accountSettings || !accountCredentials) {
    return { happierMcpServer: builtIn.happierMcpServer, mcpServers: params.resolvedMcpServers ? mergeWithBuiltInHappierMcpServer({ builtIn: builtIn.mcpServers, extra: params.resolvedMcpServers }) : builtIn.mcpServers };
  }

  if (!mcpSettings || !resolvedSelection) {
    return { happierMcpServer: builtIn.happierMcpServer, mcpServers: builtIn.mcpServers };
  }

  const settingsSecretsKey = accountCredentials.encryption
    ? deriveSettingsSecretsKeyForCredentials(accountCredentials)
    : null;
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(accountCredentials);
  const savedSecretMaterializer = createSavedSecretMaterializerV1({
    accountSettings,
    settingsSecretsReadKeys,
    resources: savedSecretResources,
    resourceCatalogState: savedSecretCatalogState,
  });

  const materialized = await materializeMcpServerConfigRecord({
    resolved: {
      directory: params.directory,
      strictMode: resolvedSelection.strictMode,
      serversByName: resolvedSelection.selectedServersByName,
    },
    savedSecretsById: new Map(),
    savedSecretMaterializer,
    settingsSecretsKey,
    settingsSecretsReadKeys,
    processEnv: env,
    tmpDir: params.tmpDir ?? null,
    strictMode: mcpSettings.strictMode,
  });

  if (materialized.warnings.length > 0) {
    logger.debug('[mcp] Materialization warnings', {
      warningCount: materialized.warnings.length,
      warnings: materialized.warnings.map((w) => ({ serverName: w.serverName, code: w.code, detail: w.detail })),
    });
  }

  const merged = mergeWithBuiltInHappierMcpServer({ builtIn: builtIn.mcpServers, extra: params.resolvedMcpServers ?? materialized.mcpServers });
  return {
    happierMcpServer: {
      ...builtIn.happierMcpServer,
      stop: () => {
        try { builtIn.happierMcpServer.stop(); } finally { materialized.cleanup(); }
      },
    },
    mcpServers: merged,
  };
}
