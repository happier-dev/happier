import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

/**
 * The cutover wire contract, read from the daemon side.
 *
 * The server route and this client are the two halves of ONE shape, and nothing
 * else pins them together: a divergence here is invisible to every coordinator
 * test, because those mock this function. The bodies asserted below are exactly
 * what `registerSessionAgentTransitionRoute` declares, so a route response-schema
 * change that this reader cannot parse fails here instead of silently degrading a
 * committed cutover to `outcome_unknown`.
 */

function currentView() {
  return {
    kind: 'legacy_v0' as const,
    expectedMetadataVersion: 7,
    metadataCiphertext: 'sealed',
    expectedAgentStateVersion: 3,
    agentStateCiphertext: null,
  };
}

const divider = { localId: 'agent-transition-divider:local-42', content: { t: 'plain' as const, v: {} } };

describe('commitSessionAgentTransitionCutover wire contract', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function importClient() {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    return (await import('./sessionAgentTransitionHttp')).commitSessionAgentTransitionCutover;
  }

  it('reads a committed cutover from the 200 success body the route sends', async () => {
    const commit = await importClient();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: { success: true, dividerSeq: 101 },
    } as never);

    await expect(commit({ token: 't', sessionId: 's1', currentView: currentView(), divider })).resolves.toEqual({
      status: 'settled',
      response: { ok: true, dividerSeq: 101 },
    });
  });

  it('carries the divider-verification demand instead of dropping it into a plain success', async () => {
    const commit = await importClient();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: { success: true, dividerSeq: 101, dividerVerificationRequired: true },
    } as never);

    await expect(commit({ token: 't', sessionId: 's1', currentView: currentView(), divider })).resolves.toEqual({
      status: 'settled',
      response: { ok: true, dividerSeq: 101, dividerVerificationRequired: true },
    });
  });

  it('reads the 409 no-effect discriminator, so a recoverable CAS loss is not an unknown outcome', async () => {
    const commit = await importClient();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 409,
      data: { effect: 'none', error: 'version-mismatch' },
    } as never);

    await expect(commit({ token: 't', sessionId: 's1', currentView: currentView(), divider })).resolves.toEqual({
      status: 'settled',
      response: { ok: false, effect: 'none', error: 'version-mismatch' },
    });
  });

  it('reads the 409 committed-effect discriminator, which authorizes a different recovery', async () => {
    const commit = await importClient();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 409,
      data: { effect: 'current_view_committed', error: 'divider-conflict' },
    } as never);

    await expect(commit({ token: 't', sessionId: 's1', currentView: currentView(), divider })).resolves.toEqual({
      status: 'settled',
      response: { ok: false, effect: 'current_view_committed', error: 'divider-conflict' },
    });
  });

  it('keeps a 500 that names its depth out of the unknown bucket', async () => {
    const commit = await importClient();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 500,
      data: { effect: 'current_view_committed', error: 'internal' },
    } as never);

    await expect(commit({ token: 't', sessionId: 's1', currentView: currentView(), divider })).resolves.toEqual({
      status: 'settled',
      response: { ok: false, effect: 'current_view_committed', error: 'internal' },
    });
  });

  it('reports an unparseable body as unknown rather than a definite effect', async () => {
    const commit = await importClient();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 500, data: 'gateway timeout' } as never);

    await expect(commit({ token: 't', sessionId: 's1', currentView: currentView(), divider }))
      .resolves.toMatchObject({ status: 'unknown' });
  });

  it('maps the route status-coded no-effect refusals onto the same union', async () => {
    for (const [status, error] of [
      [400, 'invalid-params'],
      [403, 'forbidden'],
      [404, 'session-not-found'],
    ] as const) {
      const commit = await importClient();
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ status, data: { error: 'x' } } as never);

      await expect(commit({ token: 't', sessionId: 's1', currentView: currentView(), divider })).resolves.toEqual({
        status: 'settled',
        response: { ok: false, effect: 'none', error },
      });
    }
  });
});
