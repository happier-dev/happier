import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import {
  hasSharedTelegramBridgeUpdate,
  readScopedTelegramBridgeConfig,
  removeScopedTelegramBridgeConfig,
  splitScopedTelegramBridgeUpdate,
  upsertScopedTelegramBridgeConfig,
} from '@/channels/channelBridgeAccountConfig';
import { resolveChannelBridgeRuntimeConfig } from '@/channels/channelBridgeConfig';
import {
  clearChannelBridgeTelegramConfigInKv,
  createAxiosChannelBridgeKvClient,
  readChannelBridgeTelegramConfigFromKv,
  upsertChannelBridgeTelegramConfigInKv,
} from '@/channels/channelBridgeServerKv';
import { overlayServerKvTelegramConfigInSettings } from '@/channels/channelBridgeServerConfigOverlay';
import { readCredentials, readSettings, updateSettings } from '@/persistence';
import { argvValue } from '@/cli/commands/server/commandUtilities';

function parseBooleanInput(raw: string, flagName: string): boolean {
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`Invalid ${flagName} value: ${raw}`);
}

function parseIntegerInput(raw: string, flagName: string, min: number, max: number): number {
  const trimmed = raw.trim();
  if (!/^[-]?\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${flagName} value: ${raw}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${flagName} value: ${raw}`);
  }
  return Math.trunc(parsed);
}

function parseCsvList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function validateTelegramWebhookSecretToken(raw: string, flagName: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error(`Invalid ${flagName} value: must match [A-Za-z0-9_-] (Telegram webhook token restriction)`);
  }
}

function maskSecret(value: string): string {
  if (!value.trim()) return '<empty>';
  return `<${value.length} chars>`;
}

async function resolveActiveAuthContext(): Promise<Readonly<{ accountId: string; token: string }>> {
  const credentials = await readCredentials();
  if (!credentials) {
    throw new Error('Not authenticated. Run: happier auth login');
  }
  const payload = decodeJwtPayload(credentials.token);
  const accountId = payload && typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!accountId) {
    throw new Error('Unable to resolve account id from credentials token');
  }
  return {
    accountId,
    token: credentials.token,
  };
}

function showBridgeHelp(): void {
  console.log(`
${chalk.bold('happier bridge')} - Channel bridge configuration (account-scoped)

${chalk.bold('Usage:')}
  happier bridge list
  happier bridge telegram set --bot-token <token> [--allowed-chat-ids <csv>|--allow-all] [--require-topics <true|false>] [--tick-ms <n>] [--webhook-enabled <true|false>] [--webhook-secret <secret>] [--webhook-host <host>] [--webhook-port <n>]
  happier bridge telegram clear

${chalk.bold('Notes:')}
  - Scope is the active server + authenticated account.
  - Secrets are local-only (settings/env), not synced to server KV.
  - Non-secret bridge config is synced to server KV + scoped settings.json.
  - Restart daemon to apply: happier daemon stop && happier daemon start
`);
}

async function cmdList(): Promise<void> {
  const serverId = String(configuration.activeServerId ?? '').trim();
  if (!serverId) {
    throw new Error('Unable to resolve active server id');
  }
  const auth = await resolveActiveAuthContext();
  const accountId = auth.accountId;
  const settings = await readSettings();

  let serverKvRecord: Awaited<ReturnType<typeof readChannelBridgeTelegramConfigFromKv>>['record'] | null = null;
  let serverKvError: string | null = null;
  try {
    const kv = createAxiosChannelBridgeKvClient({ token: auth.token });
    const fetched = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId,
      allowUnsupportedSchema: true,
    });
    serverKvRecord = fetched.record;
  } catch (error) {
    serverKvError = error instanceof Error ? error.message : String(error);
  }

  const scopedTelegram = readScopedTelegramBridgeConfig({
    settings,
    serverId,
    accountId,
  });

  const runtimeSettings = overlayServerKvTelegramConfigInSettings({
    settings,
    serverId,
    accountId,
    record: serverKvRecord,
  });

  const effective = resolveChannelBridgeRuntimeConfig({
    env: process.env,
    settings: runtimeSettings,
    serverId,
    accountId,
  });

  const daemonRunning = await checkIfDaemonRunningAndCleanupStaleState();

  console.log(chalk.bold('Bridge scope'));
  console.log(`  Server:  ${serverId}`);
  console.log(`  Account: ${accountId}`);
  console.log(`  Daemon:  ${daemonRunning ? 'running' : 'stopped'}`);

  console.log(chalk.bold('\nTelegram (scoped settings.json)'));
  if (!scopedTelegram) {
    console.log('  configured: no');
  } else {
    const scopedToken = typeof scopedTelegram.botToken === 'string' ? scopedTelegram.botToken : '';
    const scopedAllowed = Array.isArray(scopedTelegram.allowedChatIds) ? scopedTelegram.allowedChatIds : [];
    const scopedRequireTopics = scopedTelegram.requireTopics === true;
    console.log('  configured: yes');
    console.log(`  botToken: ${maskSecret(scopedToken)}`);
    console.log(`  allowedChatIds: ${scopedAllowed.length > 0 ? scopedAllowed.join(', ') : '(allow all)'}`);
    console.log(`  requireTopics: ${scopedRequireTopics ? 'true' : 'false'}`);
  }

  console.log(chalk.bold('\nTelegram (server KV)'));
  if (serverKvError) {
    console.log(`  unavailable: ${serverKvError}`);
  } else if (!serverKvRecord) {
    console.log('  configured: no');
  } else {
    const remoteAllowed = Array.isArray(serverKvRecord.telegram.allowedChatIds) ? serverKvRecord.telegram.allowedChatIds : [];
    const remoteRequireTopics = serverKvRecord.telegram.requireTopics === true;
    const remoteWebhookEnabled = serverKvRecord.telegram.webhook?.enabled === true;
    const remoteWebhookHost =
      typeof serverKvRecord.telegram.webhook?.host === 'string' ? serverKvRecord.telegram.webhook.host : '(default)';
    const remoteWebhookPort =
      typeof serverKvRecord.telegram.webhook?.port === 'number' ? String(serverKvRecord.telegram.webhook.port) : '(default)';

    console.log('  configured: yes');
    console.log('  botToken: (not stored in server KV)');
    console.log(`  allowedChatIds: ${remoteAllowed.length > 0 ? remoteAllowed.join(', ') : '(allow all)'}`);
    console.log(`  requireTopics: ${remoteRequireTopics ? 'true' : 'false'}`);
    console.log(`  webhook.enabled: ${remoteWebhookEnabled ? 'true' : 'false'}`);
    console.log(`  webhook.host: ${remoteWebhookHost}`);
    console.log(`  webhook.port: ${remoteWebhookPort}`);
  }

  console.log(chalk.bold('\nTelegram (effective runtime: env > server KV > settings.json)'));
  console.log(`  botToken: ${maskSecret(effective.telegram.botToken)}`);
  console.log(
    `  allowedChatIds: ${effective.telegram.allowedChatIds.length > 0 ? effective.telegram.allowedChatIds.join(', ') : '(allow all)'}`,
  );
  console.log(`  requireTopics: ${effective.telegram.requireTopics ? 'true' : 'false'}`);
  console.log(`  webhook.enabled: ${effective.telegram.webhookEnabled ? 'true' : 'false'}`);
  console.log(`  webhook.host: ${effective.telegram.webhookHost}`);
  console.log(`  webhook.port: ${effective.telegram.webhookPort}`);
}

async function cmdTelegramSet(args: string[]): Promise<void> {
  const serverId = String(configuration.activeServerId ?? '').trim();
  if (!serverId) {
    throw new Error('Unable to resolve active server id');
  }
  const auth = await resolveActiveAuthContext();
  const accountId = auth.accountId;

  const rawBotToken = argvValue(args, '--bot-token');
  const hasBotTokenFlag = args.some((arg) => arg === '--bot-token' || arg.startsWith('--bot-token='));
  const botToken = rawBotToken.trim();
  const allowedChatIdsRaw = argvValue(args, '--allowed-chat-ids').trim();
  const allowAll = args.includes('--allow-all');
  const requireTopicsRaw = argvValue(args, '--require-topics').trim();
  const tickMsRaw = argvValue(args, '--tick-ms').trim();
  const webhookEnabledRaw = argvValue(args, '--webhook-enabled').trim();
  const webhookSecret = argvValue(args, '--webhook-secret').trim();
  const webhookHost = argvValue(args, '--webhook-host').trim();
  const webhookPortRaw = argvValue(args, '--webhook-port').trim();

  if (allowAll && allowedChatIdsRaw) {
    throw new Error('Cannot combine --allow-all with --allowed-chat-ids');
  }

  const update: {
    tickMs?: number;
    botToken?: string;
    allowedChatIds?: string[];
    requireTopics?: boolean;
    webhookEnabled?: boolean;
    webhookSecret?: string;
    webhookHost?: string;
    webhookPort?: number;
  } = {};

  if (hasBotTokenFlag) {
    if (!botToken) {
      throw new Error('Invalid --bot-token value: cannot be empty');
    }
    update.botToken = botToken;
  }
  if (allowAll) {
    update.allowedChatIds = [];
  } else if (allowedChatIdsRaw) {
    update.allowedChatIds = parseCsvList(allowedChatIdsRaw);
  }
  if (requireTopicsRaw) {
    update.requireTopics = parseBooleanInput(requireTopicsRaw, '--require-topics');
  }
  if (tickMsRaw) {
    update.tickMs = parseIntegerInput(tickMsRaw, '--tick-ms', 250, 60_000);
  }
  if (webhookEnabledRaw) {
    update.webhookEnabled = parseBooleanInput(webhookEnabledRaw, '--webhook-enabled');
  }
  if (webhookSecret) {
    validateTelegramWebhookSecretToken(webhookSecret, '--webhook-secret');
    update.webhookSecret = webhookSecret;
  }
  if (webhookHost) {
    update.webhookHost = webhookHost;
  }
  if (webhookPortRaw) {
    update.webhookPort = parseIntegerInput(webhookPortRaw, '--webhook-port', 1, 65_535);
  }

  if (Object.keys(update).length === 0) {
    throw new Error(
      'No updates provided. Use flags like --bot-token, --allowed-chat-ids, --allow-all, --require-topics, --tick-ms, --webhook-enabled, --webhook-secret, --webhook-host, --webhook-port',
    );
  }

  const split = splitScopedTelegramBridgeUpdate({ update });

  if (hasSharedTelegramBridgeUpdate({ update: split.sharedUpdate })) {
    const kv = createAxiosChannelBridgeKvClient({ token: auth.token });
    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId,
      update: split.sharedUpdate,
    });
  }

  await updateSettings(async (current) =>
    upsertScopedTelegramBridgeConfig({
      settings: current,
      serverId,
      accountId,
      update: split.localUpdate,
    }),
  );

  console.log(chalk.green('✓ Saved Telegram bridge config for active account scope'));
  console.log(`  Server:  ${serverId}`);
  console.log(`  Account: ${accountId}`);
  console.log(
    hasSharedTelegramBridgeUpdate({ update: split.sharedUpdate })
      ? '  Persisted: non-secret fields -> server KV, full config -> scoped settings.json'
      : '  Persisted: secrets-only update -> scoped settings.json (server KV unchanged)',
  );
  console.log('  Restart daemon to apply changes:');
  console.log(chalk.cyan('  happier daemon stop && happier daemon start'));
}

async function cmdTelegramClear(): Promise<void> {
  const serverId = String(configuration.activeServerId ?? '').trim();
  if (!serverId) {
    throw new Error('Unable to resolve active server id');
  }
  const auth = await resolveActiveAuthContext();
  const accountId = auth.accountId;

  const kv = createAxiosChannelBridgeKvClient({ token: auth.token });
  await clearChannelBridgeTelegramConfigInKv({
    kv,
    serverId,
  });

  await updateSettings(async (current) =>
    removeScopedTelegramBridgeConfig({
      settings: current,
      serverId,
      accountId,
    }),
  );

  console.log(chalk.green('✓ Cleared Telegram bridge config for active account scope'));
  console.log(`  Server:  ${serverId}`);
  console.log(`  Account: ${accountId}`);
  console.log('  Cleared: server KV + scoped settings.json');
  console.log('  Restart daemon to apply changes:');
  console.log(chalk.cyan('  happier daemon stop && happier daemon start'));
}

async function cmdTelegram(args: string[]): Promise<void> {
  const sub = String(args[0] ?? '').trim();
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    showBridgeHelp();
    return;
  }
  if (sub === 'set') {
    await cmdTelegramSet(args.slice(1));
    return;
  }
  if (sub === 'clear') {
    await cmdTelegramClear();
    return;
  }
  throw new Error(`Unknown bridge telegram subcommand: ${sub}`);
}

export async function handleBridgeCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const sub = String(args[0] ?? '').trim();

  try {
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
      showBridgeHelp();
      return;
    }
    if (sub === 'list') {
      await cmdList();
      return;
    }
    if (sub === 'telegram') {
      await cmdTelegram(args.slice(1));
      return;
    }
    throw new Error(`Unknown bridge subcommand: ${sub}`);
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
