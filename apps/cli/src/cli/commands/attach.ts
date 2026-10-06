import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import {
  getAgentLocalControlCapability,
  resolveAgentNativeResumeIdentityFromSessionMetadata,
  resolveAgentIdFromSessionMetadata,
  type AttachSessionMetadataV1,
} from '@happier-dev/agents';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { probeSessionRunnerPresence } from '@/daemon/sessions/isSessionRunnerActive';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { configuration } from '@/configuration';
import { readSettings, readStoredCredentials, type Settings, type StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionById, fetchSessionsPage, type RawSessionListRow, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView, resolveSessionEncryptionContextFromCredentials, resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { createSessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionTerminalMetadataSchema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import type { SessionProviderCliAttachPrepareRequestV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isHostProviderCliAttachSurface, attachObservedNativeClient } from '@/session/attach/providerCliAttach';
import { resolveInheritedHerdrRuntime } from '@/terminal/runtime/inheritedHerdrRuntime';
import { buildAttachSessionMetadata } from '@/session/attach/evaluateCliSessionAttachEligibility';
import { resolveCliSessionAttachBackendId } from '@/session/attach/resolveCliSessionAttachBackendId';
import {
  fetchAccountEncryptionCurrentness,
} from '@/api/client/connectedServiceCredentialApi';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import {
  readTerminalAttachmentInfo,
  readTerminalHostAttachmentState,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { createTerminalAttachPlan } from '@/terminal/attachment/terminalAttachPlan';
import { createTmuxSingleWindowAttachPlan } from '@/terminal/attachment/tmuxSingleWindowAttachPlan';
import { isTmuxAvailable, normalizeExitCode } from '@/integrations/tmux';
import { focusWindowsTerminalWindow } from '@/terminal/attachment/windowsTerminalAttach';
import { focusWindowsConsoleWindow } from '@/terminal/attachment/windowsConsoleAttach';
import { runHerdrAttach } from '@/terminal/attachment/herdrAttach';
import { runZellijAttach } from '@/terminal/attachment/zellijAttach';
import { runTerminalHostAttach } from '@/terminal/attachment/runTerminalHostAttach';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import { windowsHostedAttachmentMatchesRunner } from '@/daemon/platform/windows/windowsHostedSessionRuntime';
import { canUseInkSelector, runSessionActionSelector } from '@/ui/ink/runSessionActionSelector';
import type { SessionActionSelectorRow } from '@/ui/ink/SessionActionSelector';
import { buildAttachSelectionModel, formatAttachIneligibilityFooter } from './attachInteractiveSelection';
import { explainAttachIneligibility, type AgentAttachStrategyForExplainer } from '@/session/attach/explainAttachIneligibility';

import type { CommandContext } from '@/cli/commandRegistry';
import { cmd, fail, neutral } from '@happier-dev/cli-common/output';

function spawnTmux(params: {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdio: 'inherit' | 'ignore';
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('tmux', params.args, {
      stdio: params.stdio,
      env: params.env,
      shell: false,
    });

    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(normalizeExitCode(code)));
  });
}

type SpawnTmuxFn = typeof spawnTmux;

type AttachCommandDeps = Readonly<{
  terminalRuntime?: CommandContext['terminalRuntime'];
  readCredentialsFn?: () => Promise<StoredCredentials | null>;
  readSettingsFn?: () => Promise<Settings>;
  fetchSessionByIdFn?: (params: { token: string; sessionId: string }) => Promise<RawSessionRecord | null>;
  fetchSessionsPageFn?: (params: { token: string; cursor?: string; limit?: number; activeOnly?: boolean; archivedOnly?: boolean }) => Promise<{
    sessions: RawSessionListRow[];
    nextCursor: string | null;
    hasNext: boolean;
  }>;
  resolveSessionIdOrPrefixFn?: (params: { credentials: StoredCredentials; idOrPrefix: string }) => Promise<
    | { ok: true; sessionId: string }
    | { ok: false; code: string; candidates?: string[] }
  >;
  tryDecryptSessionOwnerMetadataViewFn?: typeof tryDecryptSessionOwnerMetadataView;
  readTerminalAttachmentInfoFn?: typeof readTerminalAttachmentInfo;
  isTmuxAvailableFn?: typeof isTmuxAvailable;
  runTmuxAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
    refreshRemoteControl?: boolean;
  }) => Promise<number>;
  runWindowsTerminalAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runWindowsConsoleAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runHerdrAttachFn?: typeof runHerdrAttach;
  runZellijAttachFn?: typeof runZellijAttach;
  runProviderAttachFn?: (params: {
    agentId: CatalogAgentId;
    backendId: string;
    sessionId: string;
    metadata: AttachSessionMetadataV1;
    managedObservation?: Readonly<{
      providerSessionId: string;
      herdr: NonNullable<SessionProviderCliAttachPrepareRequestV1['terminalClient']>['herdr'];
      observe: (request: SessionProviderCliAttachPrepareRequestV1) => Promise<unknown>;
    }>;
  }) => Promise<number | false>;
  getAccountEncryptionCurrentnessFn?: (
    credentials: StoredCredentials,
  ) => Promise<AccountEncryptionCurrentnessResponse>;
  canUseInkSelectorFn?: () => boolean;
  selectAttachableSessionIdFn?: (params: {
    rows: SessionActionSelectorRow[];
    footerHint?: string | null;
    probeSessionIdFn?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
  }) => Promise<
    | { type: 'selected'; sessionId: string }
    | { type: 'cancelled' }
    | { type: 'none' }
  >;
}>;

type ResolvedAttachContext = Readonly<{
  sessionId: string;
  metadata: Record<string, unknown> | null;
  agentId: CatalogAgentId | null;
  credentials: StoredCredentials;
  rawSession: RawSessionRecord;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
}>;

export async function runTmuxAttach(params: {
  sessionId: string;
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  refreshRemoteControl?: boolean;
}, deps?: Readonly<{
  isTmuxAvailableFn?: typeof isTmuxAvailable;
  spawnTmuxFn?: SpawnTmuxFn;
  insideTmux?: boolean;
  currentTmuxSocketPath?: string | null;
  processId?: number;
  nowMs?: number;
}>): Promise<number> {
  const isTmuxAvailableFn = deps?.isTmuxAvailableFn ?? isTmuxAvailable;
  if (!(await isTmuxAvailableFn())) {
    console.error(fail('tmux is not available on this machine.'));
    return 1;
  }

  const insideTmux = deps?.insideTmux ?? Boolean(process.env.TMUX);
  const currentTmuxSocketPath = deps && Object.prototype.hasOwnProperty.call(deps, 'currentTmuxSocketPath')
    ? deps.currentTmuxSocketPath
    : typeof process.env.TMUX === 'string'
      ? process.env.TMUX.split(',')[0]?.trim() || null
      : null;
  const plan = createTerminalAttachPlan({
    terminal: params.terminal,
    insideTmux,
    currentTmuxSocketPath,
  });

  if (plan.type === 'not-attachable') {
    console.error(fail(plan.reason));
    return 1;
  }
  if (plan.type !== 'tmux') {
    console.error(fail('Session does not use tmux attach.'));
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.tmuxCommandEnv };
  if (plan.shouldUnsetTmuxEnv) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }
  const spawnTmuxFn = deps?.spawnTmuxFn ?? spawnTmux;

  const selectExit = await spawnTmuxFn({
    args: plan.selectWindowArgs,
    env,
    stdio: 'ignore',
  });

  if (selectExit !== 0) {
    console.error(fail(`Failed to select tmux window (${plan.target}).`));
    return selectExit;
  }

  if (params.refreshRemoteControl === true) {
    await spawnTmuxFn({
      args: ['send-keys', '-t', plan.target, 'C-l'],
      env,
      stdio: 'ignore',
    });
  }

  if (!plan.shouldAttach) return 0;

  const singleWindowAttachPlan = createTmuxSingleWindowAttachPlan({
    sessionId: params.sessionId,
    target: plan.target,
    processId: deps?.processId,
    nowMs: deps?.nowMs,
  });

  const createExit = await spawnTmuxFn({ args: singleWindowAttachPlan.createSessionArgs, env, stdio: 'ignore' });
  if (createExit !== 0) return createExit;

  const linkExit = await spawnTmuxFn({ args: singleWindowAttachPlan.linkWindowArgs, env, stdio: 'ignore' });
  if (linkExit !== 0) {
    await spawnTmuxFn({ args: singleWindowAttachPlan.cleanupSessionArgs, env, stdio: 'ignore' });
    return linkExit;
  }

  const killPlaceholderExit = await spawnTmuxFn({ args: singleWindowAttachPlan.killPlaceholderWindowArgs, env, stdio: 'ignore' });
  if (killPlaceholderExit !== 0) {
    await spawnTmuxFn({ args: singleWindowAttachPlan.cleanupSessionArgs, env, stdio: 'ignore' });
    return killPlaceholderExit;
  }

  const attachExit = await spawnTmuxFn({ args: singleWindowAttachPlan.attachSessionArgs, env, stdio: 'inherit' });
  await spawnTmuxFn({ args: singleWindowAttachPlan.cleanupSessionArgs, env, stdio: 'ignore' });
  return attachExit;
}

async function defaultRunWindowsTerminalAttach(params: {
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}): Promise<number> {
  if (process.platform !== 'win32') {
    console.error(fail('Windows Terminal attach is only available on Windows.'));
    return 1;
  }
  const windowId = params.terminal.windows?.windowId;
  if (typeof windowId !== 'string' || windowId.trim().length === 0) {
    console.error(fail('Session does not include a Windows Terminal window id.'));
    return 1;
  }
  return await focusWindowsTerminalWindow({ windowId });
}

async function defaultRunWindowsConsoleAttach(params: {
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}): Promise<number> {
  if (process.platform !== 'win32') {
    console.error(fail('Windows console attach is only available on Windows.'));
    return 1;
  }
  const pid = params.terminal.windows?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    console.error(fail('Session does not include a Windows console process id.'));
    return 1;
  }
  return await focusWindowsConsoleWindow({ pid });
}

function printMissingAttachInfo(sessionId: string): void {
  console.error(fail(`No local attachment info found for session ${sessionId}.`));
  console.error(chalk.gray('This usually means the session was not started with an attachable terminal host, or it was started on another machine.'));
}

function shouldRefreshRemoteControlOnAttach(metadata: Record<string, unknown> | null): boolean {
  return metadata?.startedBy === 'daemon';
}

async function resolveAttachContext(
  sessionIdOrPrefix: string,
  deps: AttachCommandDeps,
): Promise<ResolvedAttachContext | null> {
  const readCredentialsFn = deps.readCredentialsFn ?? readStoredCredentials;
  const fetchSessionByIdFn = deps.fetchSessionByIdFn ?? fetchSessionById;
  const resolveSessionIdOrPrefixFn = deps.resolveSessionIdOrPrefixFn ?? resolveSessionIdOrPrefix;
  const tryDecryptSessionOwnerMetadataViewFn =
    deps.tryDecryptSessionOwnerMetadataViewFn ?? tryDecryptSessionOwnerMetadataView;
  const getAccountEncryptionCurrentnessFn = deps.getAccountEncryptionCurrentnessFn
    ?? (async (credentials: StoredCredentials) =>
      await fetchAccountEncryptionCurrentness({ token: credentials.token }));

  const credentials = await readCredentialsFn();
  if (!credentials) return null;

  let rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: sessionIdOrPrefix });
  if (!rawSession) {
    const resolved = await resolveSessionIdOrPrefixFn({ credentials, idOrPrefix: sessionIdOrPrefix });
    if (!resolved.ok) {
      if (resolved.code === 'session_lookup_timeout') {
        throw new Error('Session lookup timed out; try again');
      }
      return null;
    }
    rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: resolved.sessionId });
  }
  if (!rawSession) return null;

  const accountEncryptionCurrentness = await getAccountEncryptionCurrentnessFn(credentials);

  const metadata = tryDecryptSessionOwnerMetadataViewFn({
    credentials,
    rawSession,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
  });
  const agentId = metadata ? resolveAgentIdFromSessionMetadata(metadata) : null;
  return {
    sessionId: rawSession.id,
    metadata,
    agentId,
    credentials,
    rawSession,
    accountEncryptionCurrentness,
  };
}

function isAttachSuccess(exitCode: number | false): boolean {
  return exitCode === 0;
}

async function selectAttachableSessionId(params: Readonly<{
  rows: SessionActionSelectorRow[];
  footerHint?: string | null;
  probeSessionIdFn?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
}>): Promise<
  | { type: 'selected'; sessionId: string }
  | { type: 'cancelled' }
  | { type: 'none' }
> {
  if (params.rows.length === 0) return { type: 'none' };
  return await runSessionActionSelector({
    title: 'Attach to a running session',
    actionVerb: 'attach',
    footerHint: params.footerHint ?? 'Use `happier resume` for stopped sessions.',
    rows: params.rows,
    onProbe: params.probeSessionIdFn,
  });
}

function resolveAgentAttachStrategy(agentId: CatalogAgentId | null | undefined): AgentAttachStrategyForExplainer {
  if (!agentId) return null;
  const capability = getAgentLocalControlCapability(agentId);
  if (!capability) return 'unsupported';
  return capability.attachStrategy;
}

export async function handleAttachCommand(
  argv: string[],
  deps: AttachCommandDeps = {},
): Promise<void> {
  const hasHelpFlag = argv.some((arg) => {
    const trimmed = typeof arg === 'string' ? arg.trim() : '';
    return trimmed === '--help' || trimmed === '-h';
  });
  if (hasHelpFlag) {
    console.log('happier attach');
    console.log('happier attach <session-id-or-prefix>');
    console.log('');
    console.log('Attaches a terminal to a running session on this computer.');
    return;
  }

  let sessionIdOrPrefix = argv[0]?.trim() ?? '';
  const readTerminalAttachmentInfoFn = deps.readTerminalAttachmentInfoFn ?? readTerminalAttachmentInfo;
  const readSettingsFn = deps.readSettingsFn ?? readSettings;
  const fetchSessionsPageFn = deps.fetchSessionsPageFn ?? fetchSessionsPage;
  const runTmuxAttachFn = deps.runTmuxAttachFn ?? (async (params) => await runTmuxAttach(params, {
    isTmuxAvailableFn: deps.isTmuxAvailableFn,
  }));
  const runWindowsTerminalAttachFn = deps.runWindowsTerminalAttachFn ?? defaultRunWindowsTerminalAttach;
  const runWindowsConsoleAttachFn = deps.runWindowsConsoleAttachFn ?? defaultRunWindowsConsoleAttach;
  const runHerdrAttachFn = deps.runHerdrAttachFn ?? runHerdrAttach;
  const runZellijAttachFn = deps.runZellijAttachFn ?? runZellijAttach;
  const runProviderAttachFn = deps.runProviderAttachFn ?? (async ({ backendId, sessionId, metadata, managedObservation }) => {
    const providerAttachSurface = (await getSessionHostBridge().resolveExecutionSurfaces(backendId)).attach;
    if (!providerAttachSurface) return 1;
    const result = managedObservation
      ? isHostProviderCliAttachSurface(providerAttachSurface)
        ? await attachObservedNativeClient({ surface: providerAttachSurface, request: { sessionId, metadata }, ...managedObservation })
        : { ok: false as const }
      : await providerAttachSurface.attach({ sessionId, metadata });
    return result.ok && typeof result.value.exitCode === 'number'
      ? result.value.exitCode
      : 1;
  });
  const canUseInkSelectorFn = deps.canUseInkSelectorFn ?? canUseInkSelector;
  const selectAttachableSessionIdFn = deps.selectAttachableSessionIdFn ?? selectAttachableSessionId;
  const getAccountEncryptionCurrentnessFn = deps.getAccountEncryptionCurrentnessFn
    ?? (async (credentials: StoredCredentials) =>
      await fetchAccountEncryptionCurrentness({ token: credentials.token }));
  let commandAccountEncryptionCurrentnessPromise:
    Promise<AccountEncryptionCurrentnessResponse> | null = null;
  const getCommandAccountEncryptionCurrentness = (
    credentials: StoredCredentials,
  ): Promise<AccountEncryptionCurrentnessResponse> => {
    commandAccountEncryptionCurrentnessPromise ??=
      getAccountEncryptionCurrentnessFn(credentials);
    return commandAccountEncryptionCurrentnessPromise;
  };

  const isInteractive = sessionIdOrPrefix.length === 0;
  let credentialsForInteractive: StoredCredentials | null = null;
  let currentMachineId: string | null = null;

  if (isInteractive) {
    if (!canUseInkSelectorFn()) {
      console.error(fail('Interactive attach is not available (raw TTY mode not supported).'));
      console.log('');
      console.log('Hint: run `happier session list --active` and then `happier attach <session-id>`.');
      process.exit(1);
    }

    credentialsForInteractive = await (deps.readCredentialsFn ?? readStoredCredentials)();
    if (!credentialsForInteractive) {
      console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
      process.exit(1);
    }

    const settings = await readSettingsFn();
    currentMachineId = typeof settings.machineId === 'string' && settings.machineId.trim().length > 0
      ? settings.machineId.trim()
      : null;
    const accountSettingsSnapshot = await bootstrapAccountSettingsContext({
      credentials: credentialsForInteractive,
      mode: 'fast',
    });
    const accountSettingsContext = await resolveSessionStartAccountSettingsContext({
      startedBy: 'terminal',
      snapshot: accountSettingsSnapshot,
    });
    const accountEncryptionCurrentness = await getCommandAccountEncryptionCurrentness(
      credentialsForInteractive,
    );
    const selectionModel = await buildAttachSelectionModel({
      credentials: credentialsForInteractive,
      currentMachineId,
      currentMachineHost: hostname(),
      fetchSessionsPageFn,
      readTerminalAttachmentInfoFn,
      isTmuxAvailableFn: deps.isTmuxAvailableFn ?? isTmuxAvailable,
      accountSettings: accountSettingsContext.settings,
      accountEncryptionMode: accountEncryptionCurrentness.mode,
    });
    const selected = await selectAttachableSessionIdFn({
      rows: selectionModel.rows,
      footerHint: formatAttachIneligibilityFooter(selectionModel.hint) ?? 'Use `happier resume` for stopped sessions.',
      probeSessionIdFn: selectionModel.probeSessionIdFn,
    });
    if (selected.type === 'cancelled') {
      console.log(neutral('Attach cancelled'));
      return;
    }
    if (selected.type === 'none') {
      console.log('No active sessions on this machine.');
      console.log('Hint: use `happier resume` for stopped sessions, or `happier session list --active` to see remote sessions.');
      return;
    }
    sessionIdOrPrefix = selected.sessionId;
  }

  if (!sessionIdOrPrefix) {
    console.error(fail('Missing session ID.'));
    console.log('');
    console.log('Usage: happier attach <sessionId>');
    process.exit(1);
  }

  const context = await resolveAttachContext(sessionIdOrPrefix, {
    ...deps,
    getAccountEncryptionCurrentnessFn:
      getCommandAccountEncryptionCurrentness,
  });
  const resolvedSessionId = context?.sessionId ?? sessionIdOrPrefix;
  const localInfo = await readTerminalAttachmentInfoFn({
    happyHomeDir: configuration.happyHomeDir,
    sessionId: resolvedSessionId,
  });

  if (context) {
    const settings = await readSettingsFn();
    const effectiveMachineId = typeof settings.machineId === 'string' && settings.machineId.trim().length > 0
      ? settings.machineId.trim()
      : null;
    const eligibility = await getSessionHostBridge().evaluateAttachEligibility({
      credentials: context.credentials,
      rawSession: context.rawSession,
      accountEncryptionMode: context.accountEncryptionCurrentness.mode,
      currentMachineId: effectiveMachineId,
      currentMachineHost: hostname(),
      localAttachmentInfo: localInfo,
      insideTmux: Boolean(process.env.TMUX),
      currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
    });

    if (!eligibility.eligible) {
      const explanation = explainAttachIneligibility({
        eligibility,
        metadata: eligibility.metadata,
        currentMachineHost: hostname(),
        tmuxAvailable: await (deps.isTmuxAvailableFn ?? isTmuxAvailable)(),
        agentAttachStrategy: resolveAgentAttachStrategy(eligibility.agentId ?? context.agentId),
      });
      console.error(fail(explanation.fullReason));
      if (explanation.nextStepHint) console.error(chalk.gray(explanation.nextStepHint));
      process.exit(1);
    }

    const currentOwnerMetadata = createSessionOwnerMetadataV1({ metadata: context.metadata });
    const currentLocalControl = currentOwnerMetadata.ok
      ? currentOwnerMetadata.ownerMetadata.runtime?.agentRuntimeCapabilitiesV1?.localControl : null;
    const recordedTerminal = SessionTerminalMetadataSchema.safeParse(context.metadata?.terminal);
    const recorded = recordedTerminal.success && recordedTerminal.data.mode === 'herdr' ? recordedTerminal.data.herdr : null;
    const sharedProviderLocal = currentLocalControl?.supported === true && currentLocalControl.topology === 'shared'
      && currentLocalControl.attachStrategy === 'provider_attach' && eligibility.attachScope === 'local';
    const runnerPresence = sharedProviderLocal
      ? await probeSessionRunnerPresence({ sessionId: resolvedSessionId, trackedSessions: [] }) : null;
    // Opening the recorded pane is restoration intent, not controller custody.
    // A positively absent controller cannot service the managed Switch below.
    if (recordedTerminal.success && recordedTerminal.data.mode === 'herdr'
      && recorded?.paneId?.trim() && runnerPresence?.state === 'runner_absent') {
      const exitCode = await runTerminalHostAttach({ sessionId: resolvedSessionId, terminal: recordedTerminal.data,
        refreshRemoteControl: shouldRefreshRemoteControlOnAttach(context.metadata) },
      { runTmuxAttachFn, runZellijAttachFn, runHerdrAttachFn });
      if (exitCode === null) throw new Error('The recorded restoration terminal is not attachable.');
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }
    if (sharedProviderLocal && recorded?.paneId && runnerPresence?.state === 'runner_present') {
      const local = await readTerminalHostAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: resolvedSessionId });
      const retired = recordedTerminal.success ? recordedTerminal.data.controlServiceabilityV1 : null;
      const inherited = deps.terminalRuntime?.mode === 'herdr' && deps.terminalRuntime.herdrTerminalId
        ? deps.terminalRuntime
        : process.env.HERDR_ENV === '1'
          ? await resolveInheritedHerdrRuntime({ terminalRuntime: { mode: 'herdr', herdrSessionName: recorded.sessionName }, env: { ...process.env } }) : null;
      const retiredCandidate = local.status === 'absent' && retired?.retired === true
        && retired.reason === 'attachment_retired' && Boolean(retired.attachmentId?.trim());
      if ((local.status === 'present' && local.info.version !== 1 || retiredCandidate)
        && inherited?.herdrTerminalId && inherited.herdrSocketPath === recorded.socketPath
        && inherited.herdrPaneId === recorded.paneId
        && (inherited.herdrTerminalId !== recorded.terminalId || retiredCandidate)) {
        const agentId = eligibility.agentId ?? context.agentId;
        const identity = agentId ? resolveAgentNativeResumeIdentityFromSessionMetadata(agentId, context.metadata) : null;
        const backendId = eligibility.attachStrategy === 'provider_attach' ? eligibility.backendId : resolveCliSessionAttachBackendId(context.metadata);
        if (!identity || !agentId || !backendId) throw new Error('The current native conversation is unavailable for managed attachment.');
        const mode = resolveSessionStoredContentEncryptionMode(context.rawSession);
        const ctx = resolveSessionEncryptionContextFromCredentials(context.credentials, context.rawSession);
        if (mode === 'e2ee' && !ctx) throw new Error('Session encryption context is unavailable for terminal restoration.');
        if (!context.metadata) throw new Error('The current Session metadata is unavailable for managed attachment.');
        const code = await runProviderAttachFn({ agentId, backendId, sessionId: resolvedSessionId,
          metadata: buildAttachSessionMetadata(context.metadata), managedObservation: { providerSessionId: identity.vendorResumeId,
            herdr: { ...recorded, paneId: recorded.paneId, terminalId: inherited.herdrTerminalId },
            observe: request => callSessionRpc({ token: context.credentials.token, sessionId: resolvedSessionId,
              method: SESSION_RPC_METHODS.SESSION_PROVIDER_CLI_ATTACH_PREPARE, request,
              ...(mode === 'plain' ? { mode: 'plain' as const, ctx: null } : { mode: 'e2ee' as const, ctx: ctx! }),
            }),
          } });
        if (!isAttachSuccess(code)) process.exit(typeof code === 'number' ? code : 1);
        return;
      }
    }

    if (eligibility.attachStrategy === 'provider_attach') {
      // Independent native clients do not own the runner's managed terminal custody.
      const exitCode = await runProviderAttachFn({
        agentId: eligibility.agentId,
        backendId: eligibility.backendId,
        sessionId: resolvedSessionId,
        metadata: eligibility.metadata,
      });
      if (!isAttachSuccess(exitCode)) process.exit(typeof exitCode === 'number' ? exitCode : 1);
      return;
    }

    const restoreManagedTerminal = async (expectedTerminal?: NonNullable<TerminalAttachmentInfo['terminal']>) => {
      const mode = resolveSessionStoredContentEncryptionMode(context.rawSession);
      const ctx = resolveSessionEncryptionContextFromCredentials(context.credentials, context.rawSession);
      if (mode === 'e2ee' && !ctx) throw new Error('Session encryption context is unavailable for terminal restoration.');
      const restored = await callSessionRpc({ token: context.credentials.token, sessionId: resolvedSessionId,
        method: 'switch', request: { to: 'local' },
        ...(mode === 'plain' ? { mode: 'plain' as const, ctx: null } : { mode: 'e2ee' as const, ctx: ctx! }),
      });
      if (restored !== true) throw new Error('The managed terminal could not be restored.');
      const current = await readTerminalHostAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: resolvedSessionId });
      if (current.status === 'present' && current.info.version !== 1
        && current.info.handle.attachmentId === current.info.attachmentId) {
        return buildTerminalMetadataFromHostHandle(current.info.handle);
      }
      // The Windows display owner commits its canonical regular v1 record, not
      // a PTY host descriptor. Preserve that existing identity contract.
      if (current.status === 'absent' && expectedTerminal) {
        const display = await readTerminalAttachmentInfoFn({ happyHomeDir: configuration.happyHomeDir, sessionId: resolvedSessionId });
        if (display && windowsHostedAttachmentMatchesRunner({ expected: expectedTerminal, actual: display.terminal,
          runnerPid: expectedTerminal.windows?.pid ?? 0 })) return display.terminal;
      }
      throw new Error('The restored managed terminal has no exact attachment.');
    };
    if (eligibility.attachStrategy === 'managed_provider_attach') {
      const terminal = await restoreManagedTerminal();
      const exitCode = await runTerminalHostAttach({ sessionId: resolvedSessionId, terminal, refreshRemoteControl: true },
        { runTmuxAttachFn, runZellijAttachFn, runHerdrAttachFn });
      if (exitCode === null) throw new Error('The restored managed terminal is not attachable.');
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }

    const ownerMetadata = createSessionOwnerMetadataV1({ metadata: eligibility.metadata });
    const localControl = ownerMetadata.ok
      ? ownerMetadata.ownerMetadata.runtime?.agentRuntimeCapabilitiesV1?.localControl
      : null;
    let terminal = eligibility.terminal;
    if (localControl?.supported === true && localControl.topology === 'shared' && localControl.attachStrategy === 'provider_attach') {
      terminal = await restoreManagedTerminal(terminal);
    }

    const hostExitCode = await runTerminalHostAttach({
      sessionId: resolvedSessionId,
      terminal,
      refreshRemoteControl: shouldRefreshRemoteControlOnAttach(eligibility.metadata),
    }, { runTmuxAttachFn, runZellijAttachFn, runHerdrAttachFn });
    let exitCode = hostExitCode ?? 0;
    if (hostExitCode === null) {
      switch (terminal.mode) {
        case 'windows_terminal':
          exitCode = await runWindowsTerminalAttachFn({
            sessionId: resolvedSessionId,
            terminal,
          });
          break;
        case 'windows_console':
          exitCode = await runWindowsConsoleAttachFn({
            sessionId: resolvedSessionId,
            terminal,
          });
          break;
        default:
          throw new Error('No terminal attach implementation is available for this session.');
      }
    }
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  const terminal = localInfo?.terminal ?? null;
  if (!terminal) {
    printMissingAttachInfo(resolvedSessionId);
    process.exit(1);
  }

  const hostExitCode = await runTerminalHostAttach({ sessionId: resolvedSessionId, terminal }, {
    runTmuxAttachFn,
    runZellijAttachFn,
    runHerdrAttachFn,
  });
  let exitCode = hostExitCode ?? 0;
  if (hostExitCode === null) {
    if (terminal.mode === 'windows_terminal') {
      exitCode = await runWindowsTerminalAttachFn({ sessionId: resolvedSessionId, terminal });
    } else if (terminal.mode === 'windows_console') {
      exitCode = await runWindowsConsoleAttachFn({ sessionId: resolvedSessionId, terminal });
    } else {
      console.error(chalk.red('Error:'), 'Session was not started in an attachable terminal host.');
      process.exit(1);
    }
  }
  if (exitCode !== 0) process.exit(exitCode);
}

export async function handleAttachCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleAttachCommand(context.args.slice(1), { terminalRuntime: context.terminalRuntime });
  } catch (error) {
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
