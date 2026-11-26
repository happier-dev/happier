import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';
import {
  runStandardAcpProvider,
  type StandardAcpProviderConfig,
  type StandardAcpProviderRunOptions,
} from '@/agent/runtime/runStandardAcpProvider';
import { createPiAcpRuntime } from '@/backends/pi/acp/runtime';
import { buildPiToolsForPermissionMode } from '@/backends/pi/acp/backend';
import { createPiSharedTerminalHost, type PiSharedTerminalHost } from '@/backends/pi/sharedControl/piSharedTerminalHost';
import { resolvePiSharedTerminalLaunch } from '@/backends/pi/sharedControl/resolvePiSharedTerminalLaunch';
import { resolvePiToolsDeliveryAvailability } from '@/backends/pi/shellBridge/resolvePiShellBridgeAvailability';
import { resolvePiContinueSessionFile } from '@/backends/pi/utils/resolvePiContinueSessionFile';

type PiRunOptions = StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
  /** Pi's `--continue` / `-c`: resume the session plain `pi --continue` would open here. */
  continueRecentSession?: boolean;
};

export async function runPi(opts: PiRunOptions): Promise<void> {
  const resume = await resolvePiRunResume(opts);
  const launch = resolvePiSharedTerminalLaunch({
    startedBy: opts.startedBy,
    hasTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    terminalRuntime: opts.terminalRuntime,
    env: process.env,
  });
  if (launch.kind === 'rpc' && launch.fallback === 'connected_service') {
    // Still before any terminal UI exists, so the user can read why the native TUI is not shown.
    logger.infoFile('[pi] Native terminal skipped for connected-service credentials; using Pi RPC');
    process.stderr.write('Pi native terminal is not available with connected-service credentials yet; using the Happier Pi view.\n');
  }
  await runStandardAcpProvider({ ...opts, resume }, launch.kind === 'shared' ? createSharedTerminalConfig(opts) : createRpcConfig(opts));
}

/**
 * An explicit `--resume` wins. `--continue` resolves the session file in Happier and resumes it
 * through the deterministic `--session <file>` path rather than forwarding Pi's `--continue`.
 */
async function resolvePiRunResume(opts: PiRunOptions): Promise<string | undefined> {
  if (opts.resume?.trim() || opts.continueRecentSession !== true) return opts.resume;
  // The directory Happier launches Pi in. A copy of env keeps the daemon's requested-directory
  // variable for the session start that consumes it.
  const cwd = await resolvePiProcessCwd(resolveRequestedSessionDirectory({ env: { ...process.env } }));
  const { sessionDir, sessionFile } = await resolvePiContinueSessionFile({ cwd, env: process.env });
  if (sessionFile) {
    logger.infoFile(`[pi] --continue resumes ${sessionFile}`);
    return sessionFile;
  }
  // Still before any terminal UI exists.
  logger.infoFile(`[pi] --continue found no previous session in ${sessionDir}`);
  process.stderr.write(`No previous Pi session in ${sessionDir}; starting a new one.\n`);
  return undefined;
}

/**
 * The `process.cwd()` Pi reports when launched in `directory`; Pi encodes its session dir from it.
 * POSIX getcwd() returns the physical path. Windows returns the launch path as given, keeping
 * junctions, symlinks and subst or mapped drives that realpath would resolve.
 */
async function resolvePiProcessCwd(directory: string): Promise<string> {
  const launched = resolve(directory);
  if (process.platform === 'win32') return launched;
  return await realpath(launched).catch(() => launched);
}

type PiRuntimeParams = Parameters<StandardAcpProviderConfig['createRuntime']>[0];

function createPiRuntime(opts: PiRunOptions, params: PiRuntimeParams, sharedTerminal?: PiSharedTerminalHost) {
  return createPiAcpRuntime({
    directory: params.directory,
    machineId: params.machineId,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.setThinking,
    getSessionOpenAbortSignal: params.getAbortSignal,
    memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
    getPermissionMode: params.getPermissionMode,
    processEnv: params.processEnv,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: params.providerInputConsumer,
    credentials: opts.credentials,
    accountSettings: opts.accountSettingsContext?.settings ?? null,
    ...(sharedTerminal ? { sharedTerminal } : {}),
  });
}

function createRpcConfig(opts: PiRunOptions): StandardAcpProviderConfig {
  return {
    flavor: 'pi',
    backendDisplayName: 'Pi',
    uiLogPrefix: '[Pi]',
    providerName: 'Pi',
    waitingForCommandLabel: 'Pi',
    agentMessageType: 'pi',
    supportsMcpServers: false,
    resolveToolsDeliveryAvailability: resolvePiToolsDeliveryAvailability,
    deliversSystemPromptAtSpawn: true,
    machineMetadata: initialMachineMetadata,
    loadTerminalDisplay: async () => (await import('@/backends/pi/ui/PiTerminalDisplay')).PiTerminalDisplay,
    resolvePermissionModeQueueKey: (permissionMode) => buildPiToolsForPermissionMode(permissionMode)?.join(',') ?? 'native',
    createRuntime: (params) => createPiRuntime(opts, params),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[pi] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  };
}

/**
 * `happier pi` in the user's own terminal: Pi's native TUI owns the screen and Happier attaches
 * through the bridge extension. Pi is the runtime here, so the runner never draws, its keepalive
 * reports local control, and Pi exiting ends the runner.
 */
function createSharedTerminalConfig(opts: PiRunOptions): StandardAcpProviderConfig {
  const rpc = createRpcConfig(opts);
  let sharedTerminal: PiSharedTerminalHost | null = null;
  return {
    ...rpc,
    startRuntimeBeforeFirstPrompt: true,
    shouldRenderTerminalDisplay: () => false,
    resolveKeepAliveMode: () => 'local',
    // A reset would re-adopt the same live Pi session while claiming a fresh one.
    describeUnavailableRuntimeReset: (cause) => (cause === 'clear'
      ? 'This Pi session runs in your terminal, so Happier cannot clear it. To start fresh, quit Pi and run `happier pi` again.'
      : 'The requested settings do not apply to this live Pi session. Pi keeps the permissions it started with. To change them, quit Pi and run `happier pi` again.'),
    createRuntime: (params) => {
      // Created with the runtime: Pi exiting ends the runner through its termination path.
      const host = sharedTerminal ?? createPiSharedTerminalHost({ requestRunnerTermination: params.requestRunnerTermination });
      sharedTerminal = host;
      return createPiRuntime(opts, params, host);
    },
    onAfterStart: ({ session }) => sharedTerminal?.publishLocalControl(session),
    onSessionSwap: ({ session }) => sharedTerminal?.publishLocalControl(session),
    onDispose: async () => {
      await sharedTerminal?.dispose();
    },
  };
}
