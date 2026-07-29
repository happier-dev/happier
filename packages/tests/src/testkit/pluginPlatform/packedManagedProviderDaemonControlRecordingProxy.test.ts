import { once } from 'node:events';
import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startPackedManagedProviderDaemonControlRecordingProxy,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map(async (stop) => await stop()));
});

describe('packed managed Provider daemon-control evidence', () => {
  it('records the exact daemon session-started acknowledgement and not server registration', async () => {
    const target = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request before acknowledging it.
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    stops.push(async () => {
      const closed = once(target, 'close').catch(() => undefined);
      target.close();
      await closed;
    });
    const address = target.address();
    if (!address || typeof address === 'string') {
      throw new Error('daemon-control target did not bind');
    }

    const proxy =
      await startPackedManagedProviderDaemonControlRecordingProxy(
        address.port,
      );
    stops.push(proxy.stop);

    const registrationResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/sessions`,
      {
        method: 'POST',
        body: JSON.stringify({ id: 'session-canonical' }),
      },
    );
    expect(registrationResponse.status).toBe(200);
    expect(proxy.sessionStartedEntries()).toEqual([]);

    const daemonResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/session-started`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session-canonical',
          metadata: { hostPid: 42, path: '/tmp/workspace' },
        }),
      },
    );
    expect(daemonResponse.status).toBe(200);
    expect(proxy.sessionStartedEntries()).toEqual([
      expect.objectContaining({
        sessionId: 'session-canonical',
        status: 200,
        startedAtMs: expect.any(Number),
        acknowledgedAtMs: expect.any(Number),
      }),
    ]);
    expect(
      proxy.sessionStartedEntries()[0]!.acknowledgedAtMs,
    ).toBeGreaterThanOrEqual(
      proxy.sessionStartedEntries()[0]!.startedAtMs,
    );
  });

  it('holds one broker lookup and forwards it only to the current replacement target', async () => {
    const startTarget = async (status: number) => {
      const target = createServer(async (request, response) => {
        for await (const _chunk of request) {
          // Consume the request before responding.
        }
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          value: {
            accessToken: `target-${status}`,
            credentialContext: {
              credentialRevision: `revision-${status}`,
            },
          },
        }));
      });
      target.listen(0, '127.0.0.1');
      await once(target, 'listening');
      stops.push(async () => {
        const closed = once(target, 'close').catch(() => undefined);
        target.close();
        await closed;
      });
      const address = target.address();
      if (!address || typeof address === 'string') {
        throw new Error('daemon-control target did not bind');
      }
      return address.port;
    };
    const originalPort = await startTarget(200);
    const replacementPort = await startTarget(201);
    const proxy =
      await startPackedManagedProviderDaemonControlRecordingProxy(
        originalPort,
      );
    stops.push(proxy.stop);
    const purpose = {
      consumer: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      purpose: 'openai-upstream',
    } as const;
    const hold = proxy.holdNextLookup(purpose);
    const responsePromise = fetch(
      `http://127.0.0.1:${proxy.port}/connected-accounts/request-auth/lookup`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-connected-account-capability': 'old-capability',
        },
        body: JSON.stringify({ purpose }),
      },
    );

    await hold.started;
    proxy.retarget(replacementPort);
    hold.release();

    await expect(responsePromise).resolves.toMatchObject({ status: 201 });
    await hold.completed;
    expect(proxy.entries()).toEqual([
      expect.objectContaining({
        status: 201,
        purpose,
      }),
    ]);
  });
});
