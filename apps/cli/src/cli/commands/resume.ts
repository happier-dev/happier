import chalk from 'chalk';
import React from 'react';
import { render } from 'ink';

import { readCredentials, type Credentials } from '@/persistence';
import { createSessionAttachFile } from '@/daemon/sessionAttachFile';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { fetchSessionById, fetchSessionsPage, type RawSessionListRow, type RawSessionRecord } from '@/sessionControl/sessionsHttp';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { resolveSessionEncryptionContextFromCredentials, tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';
import { encodeBase64 } from '@/api/encryption';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { AccountSettings } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol';
import { applyProviderSpawnExtrasToProcessEnv } from '@/settings/providerSettings';
import { cleanupStdinAfterInk } from '@/ui/ink/cleanupStdinAfterInk';
import { createNonBlockingStdout } from '@/ui/ink/nonBlockingStdout';
import { restoreStdinBestEffort } from '@/ui/ink/restoreStdinBestEffort';
import { SessionResumeSelector, type SessionResumeSelectorRow } from '@/ui/ink/SessionResumeSelector';
import { buildCliSessionRowModel } from '@/sessionControl/buildCliSessionRowModel';

import type { CommandContext, CommandHandler } from '@/cli/commandRegistry';

type InkInstance = {
  unmount: () => void;
};

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

function hasSetRawMode(stream: NodeJS.ReadStream): stream is NodeJS.ReadStream & { setRawMode: (mode: boolean) => void } {
  return typeof (stream as { setRawMode?: unknown }).setRawMode === 'function';
}

function canUseInkSelector(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && hasSetRawMode(process.stdin));
}

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

async function selectResumableSessionId(params: Readonly<{
  credentials: Credentials;
  accountSettings: AccountSettings;
  fetchSessionsPageFn: FetchSessionsPageFn;
}>): Promise<ResumableSessionSelection> {
  const page = await params.fetchSessionsPageFn({ token: params.credentials.token, limit: 200 });
  const rows = page.sessions
    .map((raw) => buildCliSessionRowModel({ credentials: params.credentials, rawSession: raw, accountSettings: params.accountSettings }))
    .filter((row) => row.isSystem !== true)
    .filter((row) => row.archivedAt === null && row.active !== true)
    .filter((row) => Boolean(row.path))
    .filter((row) => row.vendorResume.eligible === true)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (rows.length === 0) return { type: 'none' };

  const selectorRows: SessionResumeSelectorRow[] = rows.map((row) => ({
    sessionId: row.id,
    agentId: row.agentId,
    updatedAt: row.updatedAt,
    title: [row.tag, row.title].filter((v) => typeof v === 'string' && v.trim().length > 0).join(' · '),
    path: row.path ?? '',
  }));

  let inkInstance: InkInstance | null = null;
  let resolveSelection: ((value: ResumableSessionSelection) => void) | null = null;
  const selectionPromise = new Promise<ResumableSessionSelection>((resolve) => {
    resolveSelection = resolve;
  });
  try {
    console.clear();
    inkInstance = render(
      React.createElement(SessionResumeSelector, {
        rows: selectorRows,
        onSelect: (value) => resolveSelection?.({ type: 'selected', sessionId: value }),
        onCancel: () => resolveSelection?.({ type: 'cancelled' }),
      }),
      {
        exitOnCtrlC: false,
        patchConsole: false,
        stdout: createNonBlockingStdout(process.stdout),
      },
    );

    process.stdin.resume();
    if (process.stdin.isTTY && hasSetRawMode(process.stdin)) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');

    const selection = await selectionPromise;
    return selection;
  } finally {
    try {
      inkInstance?.unmount();
    } catch {
      // ignore
    }
    await cleanupStdinAfterInk({ stdin: process.stdin, drainMs: 75 });
    restoreStdinBestEffort({ stdin: process.stdin });
  }
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
    selectResumableSessionIdFn?: typeof selectResumableSessionId;
  }>,
): Promise<void> {
  const hasHelpFlag = argv.some((arg) => {
    const trimmed = typeof arg === 'string' ? arg.trim() : '';
    return trimmed === '--help' || trimmed === '-h';
  });
  if (hasHelpFlag) {
    console.log('happier resume');
    console.log('happier resume <session-id-or-prefix>');
    console.log('');
    console.log('Resumes an inactive session (vendor-resume) from the CLI.');
    return;
  }

  const readCredentialsFn = deps?.readCredentialsFn ?? readCredentials;
  const readAccountSettingsFn = deps?.readAccountSettingsFn ?? defaultReadAccountSettings;
  const fetchSessionByIdFn = deps?.fetchSessionByIdFn ?? fetchSessionById;
  const fetchSessionsPageFn = deps?.fetchSessionsPageFn ?? fetchSessionsPage;
  const resolveAgentHandlerFn = deps?.resolveAgentHandlerFn ?? resolveAgentHandler;
  const chdirFn = deps?.chdirFn ?? ((nextDir: string) => process.chdir(nextDir));
  const canUseInkSelectorFn = deps?.canUseInkSelectorFn ?? canUseInkSelector;
  const selectResumableSessionIdFn = deps?.selectResumableSessionIdFn ?? selectResumableSessionId;

  const credentials = await readCredentialsFn();
  if (!credentials) {
    console.error(chalk.yellow('⚠️  Not authenticated with Happier'));
    console.error(chalk.gray('  Please run "happier auth login" first'));
    process.exit(1);
  }

  const rawInput = argv[0]?.trim() ?? '';
  const isInteractive = rawInput.length === 0;

  const accountSettings = await readAccountSettingsFn({ credentials }).catch(() => accountSettingsParse({}));

  let sessionIdOrPrefix = rawInput;
  if (isInteractive) {
    if (!canUseInkSelectorFn()) {
      console.error(chalk.red('Error:'), 'Interactive resume is not available (raw TTY mode not supported).');
      console.log('');
      console.log('Hint: run `happier session list --resumable` and then `happier resume <session-id>`.');
      process.exit(1);
    }

    const selected = await selectResumableSessionIdFn({
      credentials,
      accountSettings,
      fetchSessionsPageFn,
    });
    if (selected.type === 'cancelled') {
      console.log(chalk.blue('Resume cancelled'));
      return;
    }
    if (selected.type === 'none') {
      console.log('No resumable sessions found.');
      return;
    }
    sessionIdOrPrefix = selected.sessionId;
  }

  if (!sessionIdOrPrefix) {
    console.error(chalk.red('Error:'), 'Missing session ID.');
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
      throw new Error('Session not found');
    }
    rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: resolved.sessionId });
  }
  if (!rawSession) throw new Error(`Session not found: ${sessionIdOrPrefix}`);

  const rowModel = buildCliSessionRowModel({ credentials, rawSession, accountSettings });

  if (rowModel.archivedAt !== null) {
    throw new Error('Session is archived and cannot be resumed.');
  }
  if (rowModel.active === true) {
    throw new Error('Session is already active and cannot be resumed.');
  }

  const directory = rowModel.path;
  if (!directory) {
    const metadata = tryDecryptSessionMetadata({ credentials, rawSession });
    if (!metadata) {
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

  // Ensure provider spawn routing env vars are applied even if downstream bootstrap returns from cache.
  applyProviderSpawnExtrasToProcessEnv({ agentId, settings: accountSettings });

  const attach = await createSessionAttachFile({
    happySessionId: rawSession.id,
    payload: rowModel.encryptionMode === 'plain'
      ? { v: 2, encryptionMode: 'plain' }
      : (() => {
        const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
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

  try {
    chdirFn(directory);

    const handler = await resolveAgentHandlerFn(agentId);
    const context: CommandContext = {
      args: [agentId, '--existing-session', rawSession.id, '--resume', vendorResume.vendorResumeId, '--started-by', 'terminal'],
      rawArgv: deps?.rawArgv ?? ['happier', 'resume', rawSession.id],
      terminalRuntime: deps?.terminalRuntime ?? null,
    };
    await handler(context);
  } catch (error) {
    await attach.cleanup().catch(() => {});
    throw error;
  } finally {
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
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
