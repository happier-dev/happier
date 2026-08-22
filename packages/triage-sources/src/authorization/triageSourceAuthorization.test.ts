import type {
  ConnectedAccountMaterialization,
  ConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it, vi } from 'vitest';

import {
  materializeTriageSourceAuthorizationV1,
  readTriageSourceAuthorizationV1,
  type TriageListedAccountMaterializerV1,
} from './triageSourceAuthorization.js';

const ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.scm.forge.example', localId: 'example-account' }),
  accountId: 'account-1',
});

const PURPOSE = 'example.triage.read';
const ORIGIN = 'https://api.example.test';

function materializer(
  implementation: TriageListedAccountMaterializerV1['materializeListedAccount'],
): TriageListedAccountMaterializerV1 {
  return { materializeListedAccount: implementation };
}

function headers(value: ConnectedAccountMaterialization): TriageListedAccountMaterializerV1 {
  return materializer(async () => value);
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('materializeTriageSourceAuthorizationV1', () => {
  it('requests the exact bound account for the declared purpose and request origin', async () => {
    const materializeListedAccount = vi.fn<
      TriageListedAccountMaterializerV1['materializeListedAccount']
    >(async () => ({ kind: 'httpHeaders' as const, headers: { authorization: 'Bearer t' } }));
    const signal = new AbortController().signal;

    const outcome = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: materializer(materializeListedAccount),
      purpose: PURPOSE,
      account: ACCOUNT,
      origin: ORIGIN,
      signal,
    });

    expect(outcome).toEqual({
      ok: true,
      headers: { authorization: 'Bearer t' },
      authorization: 'Bearer t',
    });
    expect(materializeListedAccount).toHaveBeenCalledWith(
      {
        purpose: PURPOSE,
        account: ACCOUNT,
        materialization: {
          kind: 'httpHeaders',
          origin: ORIGIN,
          headerNames: ['authorization'],
        },
      },
      { signal },
    );
  });

  it('omits the signal option entirely when the caller supplied none', async () => {
    const materializeListedAccount = vi.fn<
      TriageListedAccountMaterializerV1['materializeListedAccount']
    >(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer t' } }));

    await materializeTriageSourceAuthorizationV1({
      connectedAccounts: materializer(materializeListedAccount),
      purpose: PURPOSE,
      account: ACCOUNT,
      origin: ORIGIN,
    });

    expect(materializeListedAccount.mock.calls[0]?.[1]).toEqual({});
  });

  it('reads the authorization header under any casing and trims it', async () => {
    const outcome = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: headers({ kind: 'httpHeaders', headers: { AUTHORIZATION: ' Bearer t ' } }),
      purpose: PURPOSE,
      account: ACCOUNT,
      origin: ORIGIN,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.authorization).toBe('Bearer t');
    // The header map is returned as materialized: a forge may need its exact casing.
    expect(outcome.headers).toEqual({ AUTHORIZATION: ' Bearer t ' });
  });

  it('refuses a materialization that is not HTTP headers', async () => {
    const outcome = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: headers({ kind: 'environment', env: { TOKEN: 't' } }),
      purpose: PURPOSE,
      account: ACCOUNT,
      origin: ORIGIN,
    });

    expect(outcome).toEqual({ ok: false, reason: 'unsupportedMaterialization' });
  });

  it('refuses headers that carry no usable authorization', async () => {
    // Sending the request anyway would spend the user's read as an anonymous call and
    // then classify the forge's `401`/`404` as if the account had been refused.
    for (const value of [{}, { Accept: 'application/json' }, { authorization: '   ' }]) {
      const outcome = await materializeTriageSourceAuthorizationV1({
        connectedAccounts: headers({ kind: 'httpHeaders', headers: value }),
        purpose: PURPOSE,
        account: ACCOUNT,
        origin: ORIGIN,
      });
      expect(outcome).toEqual({ ok: false, reason: 'authorizationHeaderMissing' });
    }
  });

  it('reports cancellation before it asks the host to materialize anything', async () => {
    const materializeListedAccount = vi.fn<
      TriageListedAccountMaterializerV1['materializeListedAccount']
    >(async () => ({ kind: 'httpHeaders' as const, headers: { authorization: 'Bearer t' } }));

    const outcome = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: materializer(materializeListedAccount),
      purpose: PURPOSE,
      account: ACCOUNT,
      origin: ORIGIN,
      signal: abortedSignal(),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('cancelled');
    expect(materializeListedAccount).not.toHaveBeenCalled();
  });

  it('classifies an abort rejection as cancellation', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const outcome = await materializeTriageSourceAuthorizationV1({
        connectedAccounts: materializer(async () => {
          throw Object.assign(new Error('aborted'), { name });
        }),
        purpose: PURPOSE,
        account: ACCOUNT,
        origin: ORIGIN,
      });
      expect(outcome).toEqual({ ok: false, reason: 'cancelled' });
    }
  });

  it('classifies any other rejection as a materialization failure, without echoing it', async () => {
    // The rejection can carry the very material it failed to deliver, so it never travels
    // out of this module and into a caller's failure detail, log line, or persisted row.
    const outcome = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: materializer(async () => {
        throw new Error('token=secret-value');
      }),
      purpose: PURPOSE,
      account: ACCOUNT,
      origin: ORIGIN,
    });

    expect(outcome).toEqual({ ok: false, reason: 'materializationFailed' });
    expect(JSON.stringify(outcome)).not.toContain('secret-value');
  });

  it('reports a rejection observed after cancellation as cancellation', async () => {
    const controller = new AbortController();
    const outcome = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: materializer(async () => {
        controller.abort();
        throw new Error('connection closed');
      }),
      purpose: PURPOSE,
      account: ACCOUNT,
      origin: ORIGIN,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('cancelled');
  });
});

describe('readTriageSourceAuthorizationV1', () => {
  it('admits a materialization the caller already holds by exactly the same rule', () => {
    expect(readTriageSourceAuthorizationV1({ kind: 'httpHeaders', headers: { Authorization: 'token t' } }))
      .toEqual({
        ok: true,
        headers: { Authorization: 'token t' },
        authorization: 'token t',
      });
    expect(readTriageSourceAuthorizationV1({ kind: 'files', files: {} }))
      .toEqual({ ok: false, reason: 'unsupportedMaterialization' });
    expect(readTriageSourceAuthorizationV1({ kind: 'httpHeaders', headers: { Accept: 'x' } }))
      .toEqual({ ok: false, reason: 'authorizationHeaderMissing' });
  });
});
