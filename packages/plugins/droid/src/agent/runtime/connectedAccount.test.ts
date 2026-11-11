import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { DROID_CHATGPT_PURPOSE, DROID_CONNECTED_ACCOUNT_PURPOSES, prepareDroidConnectedAccount } from './connectedAccount.js';

const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected-chatgpt' };

describe('Droid connected-account declaration', () => {
  it('does not advertise a ChatGPT account when only Factory and BYOK auth are supported', () => {
    expect(DROID_CONNECTED_ACCOUNT_PURPOSES).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: DROID_CHATGPT_PURPOSE }),
    ]));
  });

  it('refuses a stale ChatGPT selection before credential materialization', async () => {
    const materialize = vi.fn<ConnectedAccountsService['materialize']>();
    await expect(prepareDroidConnectedAccount({
      connectedAccounts: [{ purpose: DROID_CHATGPT_PURPOSE, account }],
      launchEnvironment: { values: {}, unset: [] }, providerBinding: undefined,
    }, { services: { connectedAccounts: { getBinding: vi.fn(async () => null), materialize } } }, 'gpt-5.3-codex'))
      .rejects.toMatchObject({ code: 'droid_chatgpt_account_unsupported', retryable: false });
    expect(materialize).not.toHaveBeenCalled();
  });
});
