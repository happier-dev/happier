import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  chmod,
  readFile,
  rm,
} from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import { dirname } from 'node:path';
import { connect as connectTls } from 'node:tls';

import { describe, expect, it } from 'vitest';

import {
  startPackedManagedProviderTlsRecordingProxy,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';

describe('packed managed Provider decrypted upstream observer', () => {
  it('records the exact prompt and Authorization fingerprint after CONNECT and TLS', async () => {
    const managedOrigin = new URL('https://chatgpt.com');
    const managedConnectTarget =
      `${managedOrigin.hostname}:${managedOrigin.port || '443'}`;
    const observer = await startPackedManagedProviderTlsRecordingProxy();
    const proxyUrl = new URL(observer.url);
    const socket = connectTcp({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
    });
    try {
      await once(socket, 'connect');
      socket.write([
        `CONNECT ${managedConnectTarget} HTTP/1.1`,
        `Host: ${managedConnectTarget}`,
        '',
        '',
      ].join('\r\n'));
      const [connectResponse] = await once(socket, 'data') as [Buffer];
      expect(connectResponse.toString('utf8'))
        .toContain('200 Connection Established');

      const tlsSocket = connectTls({
        socket,
        servername: managedOrigin.hostname,
        ca: await readFile(observer.caCertPath),
      });
      await once(tlsSocket, 'secureConnect');
      const promptSentinel = 'packed-managed-first-prompt:test-boundary';
      const token = 'packed-test-access-token';
      const body = JSON.stringify({
        input: [{ role: 'user', content: promptSentinel }],
      });
      tlsSocket.write([
        'POST /backend-api/codex/responses HTTP/1.1',
        `Host: ${managedOrigin.hostname}`,
        `Authorization: Bearer ${token}`,
        'ChatGPT-Account-Id: packed-account',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
      await once(tlsSocket, 'data');

      expect(observer.connectTargets()).toEqual([managedConnectTarget]);
      expect(observer.entries()).toEqual([expect.objectContaining({
        connectTarget: managedConnectTarget,
        method: 'POST',
        path: '/backend-api/codex/responses',
        body,
        authorizationFingerprint:
          `sha256:${createHash('sha256').update(token).digest('hex')}`,
        accountHeader: 'packed-account',
      })]);
    } finally {
      socket.destroy();
      await observer.stop();
    }
  });

  it('holds only the matching request until one explicit release', async () => {
    const managedOrigin = new URL('https://chatgpt.com');
    const managedConnectTarget = 'chatgpt.com:443';
    const observer = await startPackedManagedProviderTlsRecordingProxy();
    const sockets: Array<ReturnType<typeof connectTcp>> = [];
    const connectObserver = async () => {
      const proxyUrl = new URL(observer.url);
      const socket = connectTcp({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port),
      });
      sockets.push(socket);
      await once(socket, 'connect');
      socket.write([
        `CONNECT ${managedConnectTarget} HTTP/1.1`,
        `Host: ${managedConnectTarget}`,
        '',
        '',
      ].join('\r\n'));
      const [connectResponse] = await once(socket, 'data') as [Buffer];
      expect(connectResponse.toString('utf8'))
        .toContain('200 Connection Established');
      const tlsSocket = connectTls({
        socket,
        servername: managedOrigin.hostname,
        ca: await readFile(observer.caCertPath),
      });
      await once(tlsSocket, 'secureConnect');
      return tlsSocket;
    };
    const sendRequest = (
      tlsSocket: Awaited<ReturnType<typeof connectObserver>>,
      body: string,
    ): Promise<string> => {
      const response = once(tlsSocket, 'data')
        .then(([chunk]) => (chunk as Buffer).toString('utf8'));
      tlsSocket.write([
        'POST /backend-api/codex/responses HTTP/1.1',
        `Host: ${managedOrigin.hostname}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
      return response;
    };

    try {
      const sentinel = 'packed-managed-held-upstream:test-boundary';
      const hold = observer.holdNextRequestBodyContaining(sentinel);
      const heldSocket = await connectObserver();
      const heldResponse = sendRequest(
        heldSocket,
        JSON.stringify({ input: sentinel }),
      );
      await expect.poll(
        () => observer.entries()
          .filter((entry) => entry.body.includes(sentinel)).length,
      ).toBe(1);
      const responseBeforeRelease = await Promise.race([
        heldResponse.then(() => 'responded'),
        new Promise<'pending'>((resolvePending) => {
          setTimeout(() => resolvePending('pending'), 100);
        }),
      ]);
      expect(responseBeforeRelease).toBe('pending');

      hold.release();
      await expect(heldResponse).resolves.toContain('HTTP/1.1 400');
      await hold.completed;
      expect(observer.entries()
        .filter((entry) => entry.body.includes(sentinel))).toHaveLength(1);

      const ordinarySocket = await connectObserver();
      await expect(sendRequest(
        ordinarySocket,
        JSON.stringify({ input: 'ordinary-nonmatching-request' }),
      )).resolves.toContain('HTTP/1.1 502');
    } finally {
      for (const socket of sockets) socket.destroy();
      await observer.stop();
    }
  });

  it('removes its ephemeral certificate material on idempotent stop', async () => {
    const observer = await startPackedManagedProviderTlsRecordingProxy();
    const caCertPath = observer.caCertPath;
    await expect(access(caCertPath)).resolves.toBeUndefined();

    await observer.stop();
    await observer.stop();

    await expect(access(caCertPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'retries certificate cleanup after a transient removal failure',
    async () => {
      const observer = await startPackedManagedProviderTlsRecordingProxy();
      const fixtureDirectoryPath = dirname(observer.caCertPath);
      await chmod(fixtureDirectoryPath, 0o000);

      try {
        await expect(observer.stop()).rejects.toMatchObject({
          code: 'EACCES',
        });
        await chmod(fixtureDirectoryPath, 0o700);
        await observer.stop();
        await expect(access(fixtureDirectoryPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await chmod(fixtureDirectoryPath, 0o700).catch(() => undefined);
        await rm(fixtureDirectoryPath, { recursive: true, force: true });
      }
    },
  );
});
