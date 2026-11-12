import { describe, expect, it, vi } from 'vitest';
import { OPENAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-openai/connected-account-service';
import { CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH } from './continuity.js';
import { CODEBUDDY_KEY_ACCOUNTS, prepareCodeBuddyConnectedAccount } from './connectedAccounts.js';

describe('CodeBuddy connected-account declaration', () => {
  it('uses the admitted Session account instead of re-reading a durable default', async () => {
    const selected = { service: CODEBUDDY_KEY_ACCOUNTS[0]!.service, accountId: 'session-selected' };
    const expectedAccounts: string[] = [];
    const getBinding = vi.fn(async (purpose: string) => purpose === 'openai-api-key'
      ? { purpose, service: selected.service, account: selected, target: { kind: 'account' as const, displayName: 'Default' } } : null);
    const materialize = vi.fn(async (_purpose: string, _request: unknown, options?: { expectedAccount?: { accountId: string } }) => {
      expectedAccounts.push(options?.expectedAccount?.accountId ?? 'missing');
      return { kind: 'environment' as const, env: { [OPENAI_SELECTED_API_KEY_ENV]: 'selected-key' } };
    });
    const prepared = await prepareCodeBuddyConnectedAccount({ modelId: 'gpt-5.6-sol' }, {
      services: { connectedAccounts: { getBinding, materialize } },
    });
    try { expect(expectedAccounts).toEqual(['session-selected']); } finally { prepared?.dispose(); }
  });

  it('retains the native launch when no supported account is selected', async () => {
    const getBinding = vi.fn(async () => null);
    const prepared = await prepareCodeBuddyConnectedAccount({ modelId: 'gpt-5.6-sol' }, {
      services: { connectedAccounts: { getBinding, materialize: vi.fn() } },
    });
    expect(prepared).toBeNull();
  });

  it('proves native resume through the shared ACP inspection owner', async () => {
    const methods: string[] = [];
    await expect(CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH.continuity.verifyResumeReachable({ vendorResumeId: 'codebuddy-session', sessionFiles: {
      verifyDeclaredPaths: async () => ({ found: false }), findDeclaredCandidate: async () => ({ found: false }),
    }, nativeInspection: { cwd: '/real/codebuddy/workspace', withDeclaredJsonRpcClient: async (_command, inspect) => await inspect({
      request: async method => { methods.push(method); return {}; }, notify: async () => undefined,
      onNotification: () => () => undefined, onRequest: () => () => undefined,
    }, new AbortController().signal) } })).resolves.toEqual({ ok: true, proof: 'native_session' });
    expect(methods).toEqual(['initialize', 'session/load']);
  });
});

describe('CodeBuddy account continuity', () => {
  it('requires restart for static-token rotation and refuses unverifiable native account adoption', async () => {
    const adapter = CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH.continuity.runtimeAuthAdapter;
    expect(adapter.canHotApply()).toMatchObject({ status: 'unsupported', recovery: 'restart_resume', applied: false });
    expect(await adapter.verifyActiveAccount()).toMatchObject({ status: 'unavailable', retryable: false });
    expect(await CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH.continuity.verifyResumeReachable({
      vendorResumeId: null,
      sessionFiles: {
        verifyDeclaredPaths: async () => ({ found: false }),
        findDeclaredCandidate: async () => ({ found: false }),
      },
    })).toEqual({ ok: false, reason: 'vendor_resume_id_missing' });
  });
});
