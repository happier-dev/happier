import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH } from './continuity.js';
import { CODEBUDDY_CODEX_PURPOSE, prepareCodeBuddyConnectedAccount } from './connectedAccounts.js';

const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected-chatgpt' };

describe('CodeBuddy connected-account declaration', () => {
  it('refuses a stale ChatGPT selection before any credential materialization', async () => {
    const materialize = vi.fn<ConnectedAccountsService['materialize']>();
    const getBinding = vi.fn(async (purpose: string) => purpose === CODEBUDDY_CODEX_PURPOSE
      ? { purpose, service: account.service, account, target: { kind: 'account' as const, displayName: 'ChatGPT' } } : null);
    await expect(prepareCodeBuddyConnectedAccount({ modelId: 'gpt-5.6-sol' }, {
      services: { connectedAccounts: { getBinding, materialize } },
    })).rejects.toMatchObject({ code: 'codebuddy_chatgpt_account_unsupported', retryable: false });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('does not advertise ChatGPT when no supported account is selected', async () => {
    const getBinding = vi.fn(async () => null);
    const prepared = await prepareCodeBuddyConnectedAccount({ modelId: 'gpt-5.6-sol' }, {
      services: { connectedAccounts: { getBinding, materialize: vi.fn() } },
    });
    expect(prepared).toBeNull();
  });
});

describe('CodeBuddy account continuity', () => {
  it('requires restart for static-token rotation and refuses unverifiable native account adoption', async () => {
    const adapter = CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH.continuity.runtimeAuthAdapter;
    expect(adapter.canHotApply()).toMatchObject({ status: 'unsupported', recovery: 'restart_resume', applied: false });
    expect(await adapter.verifyActiveAccount()).toMatchObject({ status: 'unavailable', retryable: false });
    expect(await CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH.continuity.verifyResumeReachable()).toMatchObject({ ok: false });
  });
});
