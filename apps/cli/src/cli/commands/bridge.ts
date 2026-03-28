import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import {
  readScopedTelegramBridgeConfig,
  removeScopedTelegramBridgeConfig,
  upsertScopedTelegramBridgeConfig,
} from '@/channels/channelBridgeAccountConfig';
import { resolveChannelBridgeRuntimeConfig } from '@/channels/channelBridgeConfig';
import { assertTelegramWebhookSecretToken } from '@/channels/providers/telegram/telegramWebhookSecretToken';
import { isLoopbackHostname } from '@/server/serverUrlClassification';
import { createLocalChannelBindingStore } from '@/channels/state/localBindingStore';
import { ensureExperimentalSettingsFeatureToggleEnabled } from '@/features/settingsFeatureToggles';
import { readCredentials, readSettings, updateSettings } from '@/persistence';
import { argvValue } from '@/cli/commands/server/commandUtilities';
import { join } from 'node:path';

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
  assertTelegramWebhookSecretToken(raw, {
    empty: `Invalid ${flagName} value: cannot be empty`,
    invalid: `Invalid ${flagName} value: must match [A-Za-z0-9_-] (Telegram webhook token restriction)`,
    tooLong: 'Webhook secret token is too long',
  });
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
  happier bridge telegram set [--bot-token <token>] [--allowed-chat-ids <csv>] [--allow-all-shared-chats <true|false>|--allow-all] [--require-topics <true|false>] [--tick-ms <n>] [--webhook-enabled <true|false>] [--webhook-secret <secret>] [--webhook-host <host>] [--webhook-port <n> (default: 8787)]
  happier bridge telegram clear

${chalk.bold('Notes:')}
  - Scope is the active server + authenticated account.
  - Bridge config is local-only (settings/env) in v1.
  - Conversation bindings are created from the channel itself via slash commands:
      /sessions, /attach <session-id-or-prefix>, /detach, /help
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

  const scopedTelegram = readScopedTelegramBridgeConfig({
    settings,
    serverId,
    accountId,
  });

  const effective = resolveChannelBridgeRuntimeConfig({
    env: process.env,
    settings,
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
    const scopedAllowAllSharedChats = scopedTelegram.allowAllSharedChats === true;
    const scopedRequireTopics = scopedTelegram.requireTopics === true;
    console.log('  configured: yes');
    console.log(`  botToken: ${maskSecret(scopedToken)}`);
    if (scopedAllowAllSharedChats) {
      console.log('  allowedChatIds: (allow all shared chats - DANGEROUS)');
    } else {
      console.log(`  allowedChatIds: ${scopedAllowed.length > 0 ? scopedAllowed.join(', ') : '(dm-only)'}`);
    }
    console.log(`  requireTopics: ${scopedRequireTopics ? 'true' : 'false'}`);
  }

  console.log(chalk.bold('\nTelegram (effective runtime: env > settings.json)'));
  console.log(`  botToken: ${maskSecret(effective.telegram.botToken)}`);
  if (effective.telegram.allowAllSharedChats) {
    console.log('  allowedChatIds: (allow all shared chats - DANGEROUS)');
  } else {
    console.log(
      `  allowedChatIds: ${effective.telegram.allowedChatIds.length > 0 ? effective.telegram.allowedChatIds.join(', ') : '(dm-only)'}`,
    );
  }
  console.log(`  requireTopics: ${effective.telegram.requireTopics ? 'true' : 'false'}`);
  console.log(`  webhook.enabled: ${effective.telegram.webhookEnabled ? 'true' : 'false'}`);
  console.log(`  webhook.host: ${effective.telegram.webhookHost}`);
  console.log(`  webhook.port: ${effective.telegram.webhookPort}`);

  try {
    const store = createLocalChannelBindingStore({ accountId });
    const bindings = await store.listBindings();
    const bindingsFile = join(configuration.activeServerDir, 'channel-bridges', 'v1', 'account', accountId, 'bindings.json');
    console.log(chalk.bold('\nBindings (local state)'));
    console.log(`  file: ${bindingsFile}`);
    if (bindings.length === 0) {
      console.log('  (none) - attach from a DM or a shared chat topic using /attach <session-id-or-prefix>');
    } else {
      console.log(`  count: ${bindings.length}`);
      for (const binding of bindings.slice(0, 20)) {
        const thread = binding.threadId ? `/${binding.threadId}` : '';
        const owner = binding.ownerSenderId ? `owner=${binding.ownerSenderId}` : 'owner=<missing>';
        const inbound = binding.inboundMode === 'anyone' ? 'anyone' : 'ownerOnly';
        const allowMissing = binding.allowMissingSenderId ? ', allowMissingSenderId=true' : '';
        console.log(
          `  - ${binding.providerId}:${binding.conversationId}${thread} → ${binding.sessionId} (${inbound}${allowMissing}; ${owner})`,
        );
      }
      if (bindings.length > 20) {
        console.log(`  … and ${bindings.length - 20} more`);
      }
    }
  } catch (error) {
    console.log(chalk.yellow('\nBindings (local state)'));
    console.log(chalk.yellow(`  Failed to read bindings: ${error instanceof Error ? error.message : String(error)}`));
  }
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
  const hasAllowedChatIdsFlag = args.some((arg) => arg === '--allowed-chat-ids' || arg.startsWith('--allowed-chat-ids='));
  const allowAllSharedChatsRaw = argvValue(args, '--allow-all-shared-chats').trim();
  const hasAllowAllSharedChatsFlag = args.some((arg) => arg === '--allow-all-shared-chats' || arg.startsWith('--allow-all-shared-chats='));
  const allowAll = args.includes('--allow-all');
  const requireTopicsRaw = argvValue(args, '--require-topics').trim();
  const hasRequireTopicsFlag = args.some((arg) => arg === '--require-topics' || arg.startsWith('--require-topics='));
  const tickMsRaw = argvValue(args, '--tick-ms').trim();
  const hasTickMsFlag = args.some((arg) => arg === '--tick-ms' || arg.startsWith('--tick-ms='));
  const webhookEnabledRaw = argvValue(args, '--webhook-enabled').trim();
  const hasWebhookEnabledFlag = args.some((arg) => arg === '--webhook-enabled' || arg.startsWith('--webhook-enabled='));
  const webhookSecret = argvValue(args, '--webhook-secret').trim();
  const hasWebhookSecretFlag = args.some((arg) => arg === '--webhook-secret' || arg.startsWith('--webhook-secret='));
  const webhookHost = argvValue(args, '--webhook-host').trim();
  const hasWebhookHostFlag = args.some((arg) => arg === '--webhook-host' || arg.startsWith('--webhook-host='));
  const webhookPortRaw = argvValue(args, '--webhook-port').trim();
  const hasWebhookPortFlag = args.some((arg) => arg === '--webhook-port' || arg.startsWith('--webhook-port='));

  if (hasAllowedChatIdsFlag && !allowedChatIdsRaw) {
    throw new Error('Invalid --allowed-chat-ids value: cannot be empty');
  }
  if (hasAllowAllSharedChatsFlag && !allowAllSharedChatsRaw) {
    throw new Error('Invalid --allow-all-shared-chats value: cannot be empty');
  }
  if (hasRequireTopicsFlag && !requireTopicsRaw) {
    throw new Error('Invalid --require-topics value: cannot be empty');
  }
  if (hasTickMsFlag && !tickMsRaw) {
    throw new Error('Invalid --tick-ms value: cannot be empty');
  }
  if (hasWebhookEnabledFlag && !webhookEnabledRaw) {
    throw new Error('Invalid --webhook-enabled value: cannot be empty');
  }
  if (hasWebhookSecretFlag && !webhookSecret) {
    throw new Error('Invalid --webhook-secret value: cannot be empty');
  }
  if (hasWebhookHostFlag && !webhookHost) {
    throw new Error('Invalid --webhook-host value: cannot be empty');
  }
  if (hasWebhookPortFlag && !webhookPortRaw) {
    throw new Error('Invalid --webhook-port value: cannot be empty');
  }

  if (allowAll && allowedChatIdsRaw) {
    throw new Error('Cannot combine --allow-all with --allowed-chat-ids');
  }
  if (allowAllSharedChatsRaw && allowedChatIdsRaw && parseBooleanInput(allowAllSharedChatsRaw, '--allow-all-shared-chats')) {
    throw new Error('Cannot combine --allow-all-shared-chats=true with --allowed-chat-ids');
  }

  const update: {
    tickMs?: number;
    botToken?: string;
    allowedChatIds?: string[];
    allowAllSharedChats?: boolean;
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
    update.allowAllSharedChats = true;
  } else if (allowedChatIdsRaw) {
    const parsedAllowedChatIds = parseCsvList(allowedChatIdsRaw);
    if (parsedAllowedChatIds.length === 0) {
      throw new Error('Invalid --allowed-chat-ids value: provide at least one chat id');
    }
    update.allowedChatIds = parsedAllowedChatIds;
  }
  if (allowAllSharedChatsRaw) {
    update.allowAllSharedChats = parseBooleanInput(allowAllSharedChatsRaw, '--allow-all-shared-chats');
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
    if (!isLoopbackHostname(webhookHost)) {
      throw new Error('Invalid --webhook-host value: must be a loopback address (127.0.0.1, ::1, or localhost)');
    }
    update.webhookHost = webhookHost;
  }
  if (webhookPortRaw) {
    update.webhookPort = parseIntegerInput(webhookPortRaw, '--webhook-port', 1, 65_535);
  }

  if (Object.keys(update).length === 0) {
    throw new Error(
      'No updates provided. Use flags like --bot-token, --allowed-chat-ids, --allow-all, --allow-all-shared-chats, --require-topics, --tick-ms, --webhook-enabled, --webhook-secret, --webhook-host, --webhook-port',
    );
  }

  await updateSettings(async (current) =>
    ensureExperimentalSettingsFeatureToggleEnabled({
      settings: upsertScopedTelegramBridgeConfig({
        settings: current,
        serverId,
        accountId,
        update,
      }),
      featureId: 'channelBridges',
    }),
  );

  console.log(chalk.green('✓ Saved Telegram bridge config for active account scope'));
  console.log(`  Server:  ${serverId}`);
  console.log(`  Account: ${accountId}`);
  console.log('  Persisted: scoped settings.json');
  console.log('  Enabled: experimental feature toggle channelBridges');
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
  console.log('  Cleared: scoped settings.json');
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
