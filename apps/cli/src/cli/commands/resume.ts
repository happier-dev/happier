import { requireEncryptedSessionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import chalk from 'chalk';

import { readCredentials, readSettings, type Credentials } from '@/persistence';
import { createSessionAttachFile } from '@/daemon/sessionAttachFile';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { fetchSessionById, fetchSessionsPage, type RawSessionListRow, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { resolveSessionEncryptionContextFromCredentials, tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { encodeBase64 } from '@/api/encryption';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { AccountSettings, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import {
  accountSettingsParse,
  ConnectedServiceBindingsV1Schema,
  SessionTerminalMetadataSchema,
} from '@happier-dev/protocol';
import { canUseInkSelector, runSessionActionSelector } from '@/ui/ink/runSessionActionSelector';
import { buildCliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { buildContinueSelectionModel } from '@/cli/commands/resumeInteractiveSelection';
import { RESUME_COMMAND_USAGE } from '@/cli/commandSurfaceManifest';
import { handleAttachCommand } from '@/cli/commands/attach';
import { readTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { probeSessionRunnerPresence } from '@/daemon/sessions/isSessionRunnerActive';
import { evaluateCliSessionAttachEligibility } from '@/session/attach/evaluateCliSessionAttachEligibility';
import { configuration } from '@/configuration';
import { isTmuxAvailable } from '@/integrations/tmux';
import { hostname } from 'node:os';
import {
  overlayDirectConnectedServiceEnvironment,
  resolveDirectConnectedServiceEnvironment,
} from '@/cli/connectedServices/resolveDirectConnectedServiceEnvironment';

import type { CommandContext, CommandHandler } from '@/cli/commandRegistry';
import { fail, neutral, warn } from '@happier-dev/cli-common/output';

type FetchSessionByIdFn = (params: { token: string; sessionId: string }) => Promise<RawSessionRecord | null>;
type FetchSessionsPageFn = (params: { token: string; cursor?: string; limit?: number; activeOnly?: boolean; archivedOnly?: boolean }) => Promise<{
  sessions: RawSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

type ReadAccountSettingsFn = (params: { credentials: Credentials }) => Promise<AccountSettings>;

type ResumableSessionSelection =
  | { type: 'selected'; sessionId: string }
  | { type: 'cancelled' }
  | { type: 'none' };

async function resolveAgentHandler(agentId: CatalogAgentId): Promise<CommandHandler> {
  const entry = AGENTS[agentId];
  if (!entry?.getCliCommandHandler) {
    throw new Error(`Agent '${agentId}' has no CLI command handler registered`);
  }
  return await entry.getCliCommandHandler();
}

async function defaultReadAccountSettings(params: { credentials: Credentials }): Promise<AccountSettings> {
  const ctx = await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'fast' });
  return ctx.settings;
}

function readConnectedServicesFromSessionMetadata(
  metadata: Record<string, unknown> | null,
): ConnectedServiceBindingsV1 | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata?.connectedServices);
  return parsed.success ? parsed.data : null;
}

async function selectContinuableSessionId(params: Readonly<{
  credentials: Credentials;
  accountSettings: AccountSettings;
  fetchSessionsPageFn: FetchSessionsPageFn;
}>): Promise<ResumableSessionSelection> {
  const settings = await readSettings();
  const model = await buildContinueSelectionModel({
    credentials: params.credentials,
    accountSettings: params.accountSettings,
    fetchSessionsPageFn: params.fetchSessionsPageFn,
    currentMachineId: typeof settings.machineId === 'string' && settings.machineId.trim() ? settings.machineId.trim() : null,
    currentMachineHost: hostname(),
    readTerminalAttachmentInfoFn: readTerminalAttachmentInfo,
    isTmuxAvailableFn: isTmuxAvailable,
  });

  if (model.rows.length === 0) return { type: 'none' };

  const selection = await runSessionActionSelector({
    title: 'Continue a session',
    actionVerb: 'continue',
    rows: model.rows,
    footerHint: model.footerHint,
    onProbe: model.probeSessionIdFn,
  });
  return selection.type === 'selected' ? selection : { type: 'cancelled' };
}

export async function handleResumeCommand(
  argv: string[],
  deps?: Readonly<{
    terminalRuntime?: CommandContext['terminalRuntime'];
    rawArgv?: CommandContext['rawArgv'];
    readCredentialsFn?: () => Promise<Credentials | null>;
    readAccountSettingsFn?: ReadAccountSettingsFn;
    fetchSessionByIdFn?: FetchSessionByIdFn;
    fetchSessionsPageFn?: FetchSessionsPageFn;
    resolveAgentHandlerFn?: (agentId: CatalogAgentId) => Promise<CommandHandler>;
    chdirFn?: (nextDir: string) => void;
    canUseInkSelectorFn?: () => boolean;
    selectContinuableSessionIdFn?: typeof selectContinuableSessionId;
    attachDeps?: Parameters<typeof handleAttachCommand>[1];
  }>,
): Promise<void> {
  const hasHelpFlag = argv.some((arg) => {
    const trimmed = typeof arg === 'string' ? arg.trim() : '';
    return trimmed === '--help' || trimmed === '-h';
  });
  if (hasHelpFlag) {
    console.log(RESUME_COMMAND_USAGE);
    console.log('');
    console.log('Attaches to a running session, or resumes a stopped session when supported.');
    return;
  }

  const readCredentialsFn = deps?.readCredentialsFn ?? readCredentials;
  const readAccountSettingsFn = deps?.readAccountSettingsFn ?? defaultReadAccountSettings;
  const fetchSessionByIdFn = deps?.fetchSessionByIdFn ?? fetchSessionById;
  const fetchSessionsPageFn = deps?.fetchSessionsPageFn ?? fetchSessionsPage;
  const resolveAgentHandlerFn = deps?.resolveAgentHandlerFn ?? resolveAgentHandler;
  const chdirFn = deps?.chdirFn ?? ((nextDir: string) => process.chdir(nextDir));
  const canUseInkSelectorFn = deps?.canUseInkSelectorFn ?? canUseInkSelector;
  const selectContinuableSessionIdFn = deps?.selectContinuableSessionIdFn ?? selectContinuableSessionId;

  const credentials = await readCredentialsFn();
  if (!credentials) {
    console.error(warn('Not authenticated with Happier'));
    console.error(chalk.gray('  Please run "happier auth login" first'));
    process.exit(1);
  }

  const rawInput = argv[0]?.trim() ?? '';
  const isInteractive = rawInput.length === 0;

  const accountSettings = await readAccountSettingsFn({ credentials }).catch(() => accountSettingsParse({}));

  let sessionIdOrPrefix = rawInput;
  if (isInteractive) {
    if (!canUseInkSelectorFn()) {
      console.error(fail('Interactive session selection is not available (raw TTY mode not supported).'));
      console.log('');
      console.log('Hint: run `happier session list` and then `happier resume <session-id>`.');
      process.exit(1);
    }

    const selected = await selectContinuableSessionIdFn({
      credentials,
      accountSettings,
      fetchSessionsPageFn,
    });
    if (selected.type === 'cancelled') {
      console.log(neutral('Continue cancelled'));
      return;
    }
    if (selected.type === 'none') {
      console.log('No sessions available to continue from here.');
      return;
    }
    sessionIdOrPrefix = selected.sessionId;
  }

  if (!sessionIdOrPrefix) {
    console.error(fail('Missing session ID.'));
    console.log('');
    console.log('Usage: happier resume <sessionId>');
    process.exit(1);
  }

  let rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: sessionIdOrPrefix });
  if (!rawSession) {
    const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix: sessionIdOrPrefix });
    if (!resolved.ok) {
      if (resolved.code === 'session_id_ambiguous') {
        throw new Error(`Session id is ambiguous (${resolved.candidates?.join(', ') ?? 'multiple matches'})`);
      }
      if (resolved.code === 'session_lookup_timeout') {
        throw new Error('Session lookup timed out; try again');
      }
      throw new Error('Session not found');
    }
    rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: resolved.sessionId });
  }
  if (!rawSession) throw new Error(`Session not found: ${sessionIdOrPrefix}`);

  const sessionMetadata = tryDecryptSessionMetadata({ credentials, rawSession });
  const rowModel = buildCliSessionRowModel({ credentials, rawSession, accountSettings });

  if (rowModel.archivedAt !== null) {
    throw new Error('Session is archived and cannot be resumed.');
  }
  const savedTerminal = SessionTerminalMetadataSchema.safeParse(sessionMetadata?.terminal);
  const inheritedTerminal = deps?.terminalRuntime;
  const inheritedHerdrMatchesSavedPane = inheritedTerminal?.mode === 'herdr'
    && savedTerminal.success && savedTerminal.data.mode === 'herdr'
    && Boolean(savedTerminal.data.herdr?.paneId?.trim())
    && inheritedTerminal.herdrPaneId === savedTerminal.data.herdr?.paneId
    && inheritedTerminal.herdrSocketPath === savedTerminal.data.herdr?.socketPath
    && inheritedTerminal.herdrSessionName === savedTerminal.data.herdr?.sessionName;
  // Herdr's deferred resume can arrive before relay activity has expired. The
  // inherited pane is only placement: auth, runner custody and provider admission
  // still own this same-session continuation. Unknown/present never imply absence.
  const resumeInInheritedHerdrPane = inheritedHerdrMatchesSavedPane
    && (await probeSessionRunnerPresence({ sessionId: rawSession.id, trackedSessions: [] })).state === 'runner_absent';
  let openRestorationCandidate = false;
  if (rowModel.active !== true && !resumeInInheritedHerdrPane) {
    const settings = await (deps?.attachDeps?.readSettingsFn ?? readSettings)();
    const eligibility = await evaluateCliSessionAttachEligibility({
      credentials, rawSession,
      currentMachineId: typeof settings.machineId === 'string' ? settings.machineId.trim() || null : null,
      currentMachineHost: hostname(),
      localAttachmentInfo: await (deps?.attachDeps?.readTerminalAttachmentInfoFn ?? readTerminalAttachmentInfo)({
        happyHomeDir: configuration.happyHomeDir, sessionId: rawSession.id,
      }),
      insideTmux: Boolean(process.env.TMUX),
      currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
    });
    openRestorationCandidate = eligibility.eligible && eligibility.attachStrategy === 'terminal_host';
  }
  if ((rowModel.active === true || openRestorationCandidate) && !resumeInInheritedHerdrPane) {
    await handleAttachCommand([rawSession.id], {
      ...deps?.attachDeps,
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn: async () => rawSession,
    });
    return;
  }

  const directory = rowModel.path;
  if (!directory) {
    if (!sessionMetadata) {
      throw new Error('Failed to decrypt session metadata. Reconnect your terminal and try again.');
    }
    throw new Error('Session metadata is missing a working directory path.');
  }

  const inferredAgentId = rowModel.agentId;
  if (typeof inferredAgentId !== 'string' || !Object.prototype.hasOwnProperty.call(AGENTS, inferredAgentId)) {
    throw new Error(`Unknown agentId: ${String(inferredAgentId)}`);
  }
  const agentId = inferredAgentId as CatalogAgentId;

  const vendorResume = rowModel.vendorResume;
  if (!vendorResume.eligible) {
    throw new Error(`Session is not vendor-resumable (${vendorResume.reasonCode}).`);
  }

  const attach = await createSessionAttachFile({
    happySessionId: rawSession.id,
    payload: rowModel.encryptionMode === 'plain'
      ? { v: 2, encryptionMode: 'plain' }
      : (() => {
        const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  requireEncryptedSessionContext(ctx);
        return {
          v: 2 as const,
          encryptionMode: 'e2ee' as const,
          encryptionKeyBase64: encodeBase64(ctx.encryptionKey, 'base64'),
          encryptionVariant: ctx.encryptionVariant,
        };
      })(),
  });

  const prevAttachEnv = process.env.HAPPIER_SESSION_ATTACH_FILE;
  process.env.HAPPIER_SESSION_ATTACH_FILE = attach.filePath;
  let restoreConnectedServiceEnv: (() => void) | null = null;
  let connectedServiceEnv: Awaited<
    ReturnType<typeof resolveDirectConnectedServiceEnvironment>
  > = null;
  let handlerCompleted = false;

  try {
    chdirFn(directory);
    const connectedServices = readConnectedServicesFromSessionMetadata(sessionMetadata);
    connectedServiceEnv = connectedServices
      ? await resolveDirectConnectedServiceEnvironment({
          agentId,
          credentials,
          accountSettings,
          directory,
          sessionId: rawSession.id,
          vendorResumeId: vendorResume.vendorResumeId,
          sessionMetadata,
          connectedServices,
        })
      : null;
    if (connectedServiceEnv) {
      restoreConnectedServiceEnv = overlayDirectConnectedServiceEnvironment(
        connectedServiceEnv.env,
      );
    }

    const handler = await resolveAgentHandlerFn(agentId);
    const context: CommandContext = {
      args: [agentId, '--existing-session', rawSession.id, '--resume', vendorResume.vendorResumeId, '--started-by', 'terminal'],
      rawArgv: deps?.rawArgv ?? ['happier', 'resume', rawSession.id],
      terminalRuntime: deps?.terminalRuntime ?? null,
    };
    await handler(context);
    handlerCompleted = true;
  } catch (error) {
    if (!handlerCompleted) {
      connectedServiceEnv?.cleanupOnFailure?.();
    }
    // The file owner records incomplete cleanup by default. Retain the provider's
    // original failure rather than replacing it with this nonfatal retirement error.
    await attach.cleanup().catch(() => {});
    throw error;
  } finally {
    restoreConnectedServiceEnv?.();
    if (handlerCompleted) {
      connectedServiceEnv?.cleanupOnExit?.();
    }
    if (prevAttachEnv === undefined) {
      delete process.env.HAPPIER_SESSION_ATTACH_FILE;
    } else {
      process.env.HAPPIER_SESSION_ATTACH_FILE = prevAttachEnv;
    }
  }
}

export async function handleResumeCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleResumeCommand(context.args.slice(1), {
      terminalRuntime: context.terminalRuntime,
      rawArgv: context.rawArgv,
    });
  } catch (error) {
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
