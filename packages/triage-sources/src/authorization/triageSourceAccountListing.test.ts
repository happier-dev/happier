import type {
  ConnectedAccountBindingSummary,
  ConnectedAccountMetadataList,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it, vi } from 'vitest';

import {
  readTriageSourceAccountListingV1,
  type TriageSourceAccountListerV1,
} from './triageSourceAccountListing.js';

const PURPOSE = 'example.triage.read';

const SERVICE = Object.freeze({ pluginId: 'happier.scm.forge.example', localId: 'example-account' });

const LISTING: ConnectedAccountMetadataList = Object.freeze({
  status: 'complete' as const,
  accounts: Object.freeze([
    Object.freeze({
      account: Object.freeze({ service: SERVICE, accountId: 'account-1' }),
      displayName: 'Example',
      state: 'connected' as const,
      connectedAccountOrigins: Object.freeze([]),
      connectedAccountBases: Object.freeze([]),
    }),
  ]),
}) as ConnectedAccountMetadataList;

const BINDING: ConnectedAccountBindingSummary = Object.freeze({
  purpose: PURPOSE,
  service: SERVICE,
  account: Object.freeze({ service: SERVICE, accountId: 'account-1' }),
  target: Object.freeze({ kind: 'account' as const, displayName: 'Example' }),
});

/** The host's refusal to list a purpose it holds no selection for. */
function notSelected(): Error & { code: string } {
  return Object.assign(new Error('resource not selected'), {
    code: 'plugin_host_access_resource_not_selected',
  });
}

function lister(
  listAccounts: TriageSourceAccountListerV1['listAccounts'],
  getBinding: TriageSourceAccountListerV1['getBinding'],
): TriageSourceAccountListerV1 {
  return { listAccounts, getBinding };
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('readTriageSourceAccountListingV1', () => {
  it('returns the host listing for a bound purpose without asking for the binding', async () => {
    const getBinding = vi.fn<TriageSourceAccountListerV1['getBinding']>(async () => BINDING);
    const listAccounts = vi.fn<TriageSourceAccountListerV1['listAccounts']>(async () => LISTING);

    const outcome = await readTriageSourceAccountListingV1({
      connectedAccounts: lister(listAccounts, getBinding),
      purpose: PURPOSE,
      limit: 8,
    });

    expect(outcome).toEqual({ kind: 'listed', listing: LISTING });
    expect(listAccounts).toHaveBeenCalledWith({ purpose: PURPOSE, limit: 8 }, {});
    expect(getBinding).not.toHaveBeenCalled();
  });

  /**
   * The discriminating case. `listAccounts` and `getBinding` resolve the SAME
   * authorized target; the only difference is that one throws where the other
   * answers `null`. A source that reports this as a provider read failure
   * accuses a provider it never contacted.
   */
  it('reports an unbound purpose as unbound, not as a failed listing', async () => {
    const outcome = await readTriageSourceAccountListingV1({
      connectedAccounts: lister(
        async () => { throw notSelected(); },
        async () => null,
      ),
      purpose: PURPOSE,
    });

    expect(outcome).toEqual({ kind: 'unbound' });
  });

  it('reports a listing throw as failed while the purpose is still bound', async () => {
    const error = new Error('listing exploded');

    const outcome = await readTriageSourceAccountListingV1({
      connectedAccounts: lister(
        async () => { throw error; },
        async () => BINDING,
      ),
      purpose: PURPOSE,
    });

    expect(outcome).toEqual({ kind: 'failed', error });
  });

  it('keeps the original listing error when the binding read itself fails', async () => {
    const error = new Error('listing exploded');

    const outcome = await readTriageSourceAccountListingV1({
      connectedAccounts: lister(
        async () => { throw error; },
        async () => { throw new Error('binding exploded'); },
      ),
      purpose: PURPOSE,
    });

    expect(outcome).toEqual({ kind: 'failed', error });
  });

  it('never converts a cancelled listing into an unbound claim', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const getBinding = vi.fn<TriageSourceAccountListerV1['getBinding']>(async () => null);

    const outcome = await readTriageSourceAccountListingV1({
      connectedAccounts: lister(async () => { throw abort; }, getBinding),
      purpose: PURPOSE,
      signal: abortedSignal(),
    });

    expect(outcome).toEqual({ kind: 'failed', error: abort });
    expect(getBinding).not.toHaveBeenCalled();
  });

  it('forwards the invocation signal to both host reads', async () => {
    const signal = new AbortController().signal;
    const getBinding = vi.fn<TriageSourceAccountListerV1['getBinding']>(async () => null);
    const listAccounts = vi.fn<TriageSourceAccountListerV1['listAccounts']>(async () => {
      throw notSelected();
    });

    await readTriageSourceAccountListingV1({
      connectedAccounts: lister(listAccounts, getBinding),
      purpose: PURPOSE,
      signal,
    });

    expect(listAccounts).toHaveBeenCalledWith({ purpose: PURPOSE }, { signal });
    expect(getBinding).toHaveBeenCalledWith(PURPOSE, { signal });
  });
});
