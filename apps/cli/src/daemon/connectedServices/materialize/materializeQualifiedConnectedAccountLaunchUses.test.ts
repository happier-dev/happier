import { describe, expect, it, vi } from 'vitest';

import {
  materializeQualifiedConnectedAccountLaunchUses,
} from './materializeQualifiedConnectedAccountLaunchUses';

const consumer = Object.freeze({
  pluginId: 'acme.example-agent',
  localId: 'example',
});
const service = Object.freeze({
  pluginId: 'acme.example-auth',
  localId: 'account',
});
const purpose = Object.freeze({ consumer, purpose: 'launch' });
const account = Object.freeze({ service, accountId: 'account-1' });

describe('materializeQualifiedConnectedAccountLaunchUses', () => {
  it('keeps account selection and credential-file paths in their canonical host owners', async () => {
    const getBinding = vi.fn(async () => ({ account }));
    const materialize = vi.fn(async (input: Readonly<{
      request: Readonly<{ kind: 'environment' | 'files' }>;
    }>) => input.request.kind === 'environment'
      ? { kind: 'environment' as const, env: { EXAMPLE_TOKEN: 'secret' } }
      : { kind: 'files' as const, files: { 'auth.json': new Uint8Array([1, 2, 3]) } });
    const dispose = vi.fn();
    const credentialFileMaterialize = vi.fn(async (input: Readonly<{
      retainCleanup(cleanup: Readonly<{ dispose(): void }>): void;
    }>) => {
      input.retainCleanup({ dispose });
      return {
        pathsByFileId: { '0': '/host-owned/auth.json' },
        dispose,
      };
    });
    const retainedCleanups: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];

    const environment = await materializeQualifiedConnectedAccountLaunchUses({
      connectedAccountsOwner: { getBinding, materialize } as never,
      credentialFileOwner: { materialize: credentialFileMaterialize } as never,
      snapshot: {
        purposes: [purpose],
        bindings: [{ purpose, target: { kind: 'account', account } }],
        environmentUses: [{
          purpose,
          serviceRefs: [service],
          environmentKey: 'EXAMPLE_TOKEN',
        }],
        fileEnvironmentUses: [{
          purpose,
          serviceRefs: [service],
          fileId: 'auth.json',
          environmentKey: 'EXAMPLE_AUTH_FILE',
        }],
      },
      sessionId: 'session-1',
      signal: new AbortController().signal,
      credentialFileScope: {
        generation: 'generation-1',
        pluginId: consumer.pluginId,
        contributionQualifiedId: 'acme.example-agent/agents/example',
        sessionId: 'session-1',
      },
      retainCredentialFileCleanup(cleanup) {
        retainedCleanups.push(cleanup);
      },
    });

    expect(environment).toEqual({
      EXAMPLE_TOKEN: 'secret',
      EXAMPLE_AUTH_FILE: '/host-owned/auth.json',
    });
    expect(getBinding).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      expectedAccount: account,
      request: { kind: 'environment', keys: ['EXAMPLE_TOKEN'] },
    }));
    expect(materialize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedAccount: account,
      request: { kind: 'files', fileIds: ['auth.json'] },
    }));
    expect(credentialFileMaterialize).toHaveBeenCalledWith(expect.objectContaining({
      files: { '0': new Uint8Array([1, 2, 3]) },
    }));
    expect(retainedCleanups).toHaveLength(1);
  });
});
