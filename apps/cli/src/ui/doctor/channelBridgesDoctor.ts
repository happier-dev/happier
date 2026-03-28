import chalk from 'chalk';

import { resolveChannelBridgeRuntimeConfig } from '@/channels/channelBridgeConfig';
import type { ChannelSessionBinding } from '@/channels/core/channelBridgeWorker';
import { createLocalChannelBindingStore } from '@/channels/state/localBindingStore';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';

export type ChannelBridgeDoctorSectionResult = Readonly<{
  hasCriticalFailures: boolean;
}>;

function formatBindingRef(binding: ChannelSessionBinding): string {
  const thread = binding.threadId ? `/${binding.threadId}` : '';
  return `${binding.providerId}:${binding.conversationId}${thread}`;
}

function formatSenderIdStatus(binding: ChannelSessionBinding): string {
  if (binding.ownerSenderId) return `owner=${binding.ownerSenderId}`;
  if (binding.allowMissingSenderId) return 'owner=<missing> (allowMissingSenderId=true)';
  return 'owner=<missing>';
}

function formatInboundMode(binding: ChannelSessionBinding): string {
  const mode = binding.inboundMode === 'anyone' ? 'anyone' : 'ownerOnly';
  const missing = binding.allowMissingSenderId ? ', allowMissingSenderId=true' : '';
  return `${mode}${missing}`;
}

function isTelegramConfigured(runtime: ReturnType<typeof resolveChannelBridgeRuntimeConfig>['providers']['telegram']): boolean {
  return (
    runtime.botToken.trim().length > 0
    || runtime.webhookEnabled
    || runtime.webhookSecret.trim().length > 0
    || runtime.allowedChatIds.length > 0
    || runtime.allowAllSharedChats
    || runtime.requireTopics
  );
}

export async function runChannelBridgeDoctorSection(params: Readonly<{
  settings: unknown;
  credentialsToken: string | null;
}>): Promise<ChannelBridgeDoctorSectionResult> {
  const serverId = String(configuration.activeServerId ?? '').trim();
  const payload = params.credentialsToken ? decodeJwtPayload(params.credentialsToken) : null;
  const accountId = payload && typeof payload.sub === 'string' ? payload.sub.trim() : '';

  const runtime = resolveChannelBridgeRuntimeConfig({
    env: process.env,
    settings: params.settings,
    serverId,
    accountId: accountId || null,
  });

  console.log(chalk.bold('\n🔌 Channel Bridges'));
  console.log(`Server scope: ${serverId || '(unknown)'}`);
  console.log(`Account scope: ${accountId || '(unknown)'}`);
  console.log('Runtime source: env > local settings');

  let hasCriticalFailures = false;

  const telegram = runtime.providers.telegram;
  if (!isTelegramConfigured(telegram)) {
    console.log(chalk.gray('Telegram bridge not configured for active scope'));
    return { hasCriticalFailures };
  }

  const tokenMissing = telegram.botToken.trim().length === 0;
  if (tokenMissing) {
    console.log(chalk.red('❌ Telegram bridge configuration present but bot token is missing (bridge will not start)'));
    hasCriticalFailures = true;
  } else {
    console.log(chalk.green('✓ Telegram bridge configured (bot token present)'));
  }

  if (telegram.allowAllSharedChats) {
    console.log(chalk.yellow('⚠️  allowAllSharedChats=true (any shared chat can be attached; high risk)'));
  }

  const allowedChatIdsLabel = (() => {
    if (telegram.allowAllSharedChats) {
      return '(allow all shared chats - UNSAFE)';
    }
    if (telegram.allowedChatIds.length > 0) {
      return telegram.allowedChatIds.join(', ');
    }
    return '(dm-only)';
  })();

  console.log(`  allowedChatIds: ${allowedChatIdsLabel}`);
  console.log(`  requireTopics: ${telegram.requireTopics ? 'true' : 'false'}`);
  console.log(`  webhook.enabled: ${telegram.webhookEnabled ? 'true' : 'false'}`);
  console.log(`  webhook.host: ${telegram.webhookHost}`);
  console.log(`  webhook.port: ${telegram.webhookPort}`);

  if (telegram.webhookEnabled && telegram.webhookSecret.trim().length === 0) {
    console.log(chalk.yellow('⚠️  webhook.enabled=true but webhook.secret is missing (daemon will fall back to polling)'));
  }

  if (!accountId) {
    console.log(chalk.gray('Bindings: unavailable (no authenticated account id)'));
    return { hasCriticalFailures };
  }

  try {
    const store = createLocalChannelBindingStore({ accountId });
    const bindings = await store.listBindings();
    console.log(chalk.bold('\nBindings (local state)'));
    console.log(`  count: ${bindings.length}`);

    const riskyAnyone = bindings.filter((binding) => binding.inboundMode === 'anyone').length;
    const riskyMissingSender = bindings.filter((binding) => binding.allowMissingSenderId).length;
    if (riskyAnyone > 0) {
      console.log(chalk.yellow(`⚠️  ${riskyAnyone} binding(s) allow inbound from anyone`));
    }
    if (riskyMissingSender > 0) {
      console.log(chalk.yellow(`⚠️  ${riskyMissingSender} binding(s) allow missing sender identity (unsafe)`));
    }

    const displayLimit = 20;
    for (const binding of bindings.slice(0, displayLimit)) {
      console.log(
        `  - ${formatBindingRef(binding)} → ${binding.sessionId} (${formatInboundMode(binding)}; ${formatSenderIdStatus(binding)})`,
      );
    }
    if (bindings.length > displayLimit) {
      console.log(`  … and ${bindings.length - displayLimit} more`);
    }
    console.log(chalk.gray('Manage bindings in-channel: /sessions, /attach, /detach, /help'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`⚠️  Failed to read local bindings: ${message}`));
  }

  return { hasCriticalFailures };
}
