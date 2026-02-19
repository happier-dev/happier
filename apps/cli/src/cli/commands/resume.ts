import chalk from 'chalk';

import { configuration } from '@/configuration';
import { readCredentials, type Credentials } from '@/persistence';
import { decodeBase64, decrypt, encodeBase64 } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { createSessionAttachFile } from '@/daemon/sessionAttachFile';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { fetchSessionById, type RawSessionRecord } from '@/sessionControl/sessionsHttp';

import type { CommandContext, CommandHandler } from '@/cli/commandRegistry';

type FetchSessionByIdFn = (params: { token: string; sessionId: string }) => Promise<RawSessionRecord | null>;

function resolveCatalogAgentIdFromMetadata(metadata: Record<string, unknown>): CatalogAgentId {
  const rawFlavor = typeof (metadata as any).flavor === 'string' ? String((metadata as any).flavor).trim() : '';
  const byFlavor = rawFlavor.split('-')[0] as CatalogAgentId;
  if (byFlavor && Object.prototype.hasOwnProperty.call(AGENTS, byFlavor)) {
    return byFlavor;
  }

  const has = (key: string) => typeof (metadata as any)[key] === 'string' && String((metadata as any)[key]).trim().length > 0;
  if (has('codexSessionId')) return 'codex';
  if (has('geminiSessionId')) return 'gemini';
  if (has('opencodeSessionId')) return 'opencode';
  if (has('auggieSessionId')) return 'auggie';
  if (has('qwenSessionId')) return 'qwen';
  if (has('kimiSessionId')) return 'kimi';
  if (has('kiloSessionId')) return 'kilo';
  if (has('piSessionId')) return 'pi';
  if (has('claudeSessionId')) return 'claude';

  return 'claude';
}

async function resolveAgentHandler(agentId: CatalogAgentId): Promise<CommandHandler> {
  const entry = AGENTS[agentId];
  if (!entry?.getCliCommandHandler) {
    throw new Error(`Agent '${agentId}' has no CLI command handler registered`);
  }
  return await entry.getCliCommandHandler();
}

export async function handleResumeCommand(
  argv: string[],
  deps?: Readonly<{
    terminalRuntime?: CommandContext['terminalRuntime'];
    rawArgv?: CommandContext['rawArgv'];
    readCredentialsFn?: () => Promise<Credentials | null>;
    fetchSessionByIdFn?: FetchSessionByIdFn;
    resolveAgentHandlerFn?: (agentId: CatalogAgentId) => Promise<CommandHandler>;
    chdirFn?: (nextDir: string) => void;
  }>,
): Promise<void> {
  const sessionId = argv[0]?.trim();
  if (!sessionId) {
    console.error(chalk.red('Error:'), 'Missing session ID.');
    console.log('');
    console.log('Usage: happier resume <sessionId>');
    process.exit(1);
  }

  const readCredentialsFn = deps?.readCredentialsFn ?? readCredentials;
  const fetchSessionByIdFn = deps?.fetchSessionByIdFn ?? fetchSessionById;
  const resolveAgentHandlerFn = deps?.resolveAgentHandlerFn ?? resolveAgentHandler;
  const chdirFn = deps?.chdirFn ?? ((nextDir: string) => process.chdir(nextDir));

  const credentials = await readCredentialsFn();
  if (!credentials) {
    console.error(chalk.yellow('⚠️  Not authenticated with Happier'));
    console.error(chalk.gray('  Please run "happier auth login" first'));
    process.exit(1);
  }

  if (credentials.encryption.type !== 'dataKey') {
    console.error(chalk.red('Error:'), 'This terminal is connected using legacy credentials and cannot decrypt sessions.');
    console.error(chalk.gray('Reconnect this terminal from the Happier app (Terminal Connect V2).'));
    process.exit(1);
  }

  const rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId });
  if (!rawSession) {
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const encryptedDekBase64 = typeof rawSession.dataEncryptionKey === 'string' ? (rawSession.dataEncryptionKey as string) : null;
  const sessionEncryptionKey = openSessionDataEncryptionKey({
    credential: credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64,
  });
  if (!sessionEncryptionKey) {
    console.error(chalk.red('Error:'), 'Failed to open session dataEncryptionKey. Reconnect your terminal with V2 provisioning.');
    process.exit(1);
  }

  const rawMetadata = typeof rawSession.metadata === 'string' ? (rawSession.metadata as string) : '';
  if (!rawMetadata) {
    console.error(chalk.red('Error:'), 'Session metadata is missing.');
    process.exit(1);
  }

  const decryptedMetadata = decrypt(sessionEncryptionKey, 'dataKey', decodeBase64(rawMetadata));
  if (!decryptedMetadata || typeof decryptedMetadata !== 'object' || Array.isArray(decryptedMetadata)) {
    console.error(chalk.red('Error:'), 'Failed to decrypt session metadata.');
    process.exit(1);
  }

  const metadata = decryptedMetadata as Record<string, unknown>;
  const directory = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  if (!directory) {
    console.error(chalk.red('Error:'), 'Session metadata is missing a working directory path.');
    process.exit(1);
  }

  const agentId = resolveCatalogAgentIdFromMetadata(metadata);
  const attach = await createSessionAttachFile({
    happySessionId: sessionId,
    payload: {
      encryptionKeyBase64: encodeBase64(sessionEncryptionKey, 'base64'),
      encryptionVariant: 'dataKey',
    },
  });

  const prevAttachEnv = process.env.HAPPIER_SESSION_ATTACH_FILE;
  process.env.HAPPIER_SESSION_ATTACH_FILE = attach.filePath;

  try {
    chdirFn(directory);

    const handler = await resolveAgentHandlerFn(agentId);
    const context: CommandContext = {
      args: [agentId, '--existing-session', sessionId, '--started-by', 'terminal'],
      rawArgv: deps?.rawArgv ?? ['happier', 'resume', sessionId],
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
