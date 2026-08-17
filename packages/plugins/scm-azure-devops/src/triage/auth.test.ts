import type {
  ConnectedAccountMaterialization,
  QualifiedConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it, vi } from 'vitest';

import { materializeAzureDevOpsListedAuthorization } from './auth.js';
import type { AzureDevOpsListedAccountMaterializer, AzureDevOpsOrigin } from './types.js';

const ORIGIN: AzureDevOpsOrigin = Object.freeze({
  baseUrl: 'https://dev.azure.com/contoso',
  requestOrigin: 'https://dev.azure.com',
  forgeHostId: 'dev.azure.com',
  scopeSegment: 'contoso',
}) as AzureDevOpsOrigin;

const ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.scm.forge.azure-devops', localId: 'azure-devops-account' }),
  accountId: 'account-1',
}) as QualifiedConnectedAccountRef;

function materializer(
  value: ConnectedAccountMaterialization,
): AzureDevOpsListedAccountMaterializer {
  return { materializeListedAccount: async () => value };
}

describe('materializeAzureDevOpsListedAuthorization', () => {
  it('materializes the exact bound account against the configured request origin', async () => {
    const materializeListedAccount = vi.fn(
      async (): Promise<ConnectedAccountMaterialization> => ({
        kind: 'httpHeaders',
        headers: { Authorization: 'Bearer pat' },
      }),
    );
    const signal = new AbortController().signal;

    const outcome = await materializeAzureDevOpsListedAuthorization({
      connectedAccounts: { materializeListedAccount },
      purpose: 'azure-devops.triage.read',
      account: ACCOUNT,
      origin: ORIGIN,
      signal,
    });

    expect(outcome).toEqual({ ok: true, authorization: { headers: { Authorization: 'Bearer pat' } } });
    expect(materializeListedAccount).toHaveBeenCalledWith(
      {
        purpose: 'azure-devops.triage.read',
        account: ACCOUNT,
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://dev.azure.com',
          headerNames: ['authorization'],
        },
      },
      { signal },
    );
  });

  it('refuses headers that carry no usable authorization', async () => {
    // Previously any non-empty header map was accepted, so a materialization carrying only
    // `Accept` produced a client that read Azure DevOps anonymously.
    for (const headers of [{}, { Accept: 'application/json' }, { authorization: ' ' }]) {
      const outcome = await materializeAzureDevOpsListedAuthorization({
        connectedAccounts: materializer({ kind: 'httpHeaders', headers }),
        purpose: 'azure-devops.triage.read',
        account: ACCOUNT,
        origin: ORIGIN,
        signal: new AbortController().signal,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure.class).toBe('unauthorized');
    }
  });

  it('reports cancellation without asking the host to materialize anything', async () => {
    const materializeListedAccount = vi.fn(
      async (): Promise<ConnectedAccountMaterialization> => ({
        kind: 'httpHeaders',
        headers: { Authorization: 'Bearer pat' },
      }),
    );
    const controller = new AbortController();
    controller.abort();

    const outcome = await materializeAzureDevOpsListedAuthorization({
      connectedAccounts: { materializeListedAccount },
      purpose: 'azure-devops.triage.read',
      account: ACCOUNT,
      origin: ORIGIN,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.class).toBe('cancelled');
    expect(materializeListedAccount).not.toHaveBeenCalled();
  });

  it('never echoes the host rejection, which can carry the material it failed to deliver', async () => {
    const outcome = await materializeAzureDevOpsListedAuthorization({
      connectedAccounts: {
        materializeListedAccount: async () => {
          throw new Error('pat=super-secret-value');
        },
      },
      purpose: 'azure-devops.triage.read',
      account: ACCOUNT,
      origin: ORIGIN,
      signal: new AbortController().signal,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.class).toBe('unauthorized');
    expect(JSON.stringify(outcome.failure)).not.toContain('super-secret-value');
  });
});
