import { X509Certificate } from 'node:crypto';
import {
  access,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import {
  createServer,
  type Socket,
} from 'node:net';
import { once } from 'node:events';
import {
  connect as connectTls,
  TLSSocket,
} from 'node:tls';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createEphemeralTlsServerFixture,
} from './ephemeralTlsServerFixture.mjs';

const rmMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  rmMock.mockImplementation(actual.rm);
  return {
    ...actual,
    rm: rmMock,
  };
});

describe('ephemeral TLS server fixture', () => {
  it('creates a usable private CA/leaf pair with local and requested SANs', async () => {
    const fixture = await createEphemeralTlsServerFixture({
      additionalDnsNames: ['chatgpt.com'],
    });
    const sockets = new Set<Socket | TLSSocket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const tlsSocket = new TLSSocket(socket, {
        isServer: true,
        secureContext: fixture.secureContext,
      });
      sockets.add(tlsSocket);
      tlsSocket.once('close', () => sockets.delete(tlsSocket));
      tlsSocket.once('secure', () => tlsSocket.end('ok'));
      tlsSocket.once('error', () => tlsSocket.destroy());
    });

    try {
      const ca = new X509Certificate(
        await readFile(fixture.caCertificatePath),
      );
      const leaf = new X509Certificate(
        await readFile(fixture.leafCertificatePath),
      );
      expect(ca.ca).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.issuer).toBe(ca.subject);
      expect(leaf.checkHost('localhost')).toBe('localhost');
      expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
      expect(leaf.checkHost('chatgpt.com')).toBe('chatgpt.com');

      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      expect(address && typeof address === 'object').toBe(true);
      if (!address || typeof address === 'string') {
        throw new Error('ephemeral_tls_fixture_test_address_missing');
      }
      const client = connectTls({
        host: '127.0.0.1',
        port: address.port,
        servername: 'localhost',
        ca: await readFile(fixture.caCertificatePath),
      });
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      await once(client, 'secureConnect');
      const [payload] = await once(client, 'data') as [Buffer];
      expect(payload.toString('utf8')).toBe('ok');

      if (process.platform !== 'win32') {
        expect((await stat(fixture.directoryPath)).mode & 0o777).toBe(0o700);
        const fileStats = await Promise.all([
          stat(fixture.caCertificatePath),
          stat(fixture.leafCertificatePath),
          stat(fixture.privateKeyPath),
        ]);
        expect(fileStats.map((entry) => entry.mode & 0o777)).toEqual([
          0o600,
          0o600,
          0o600,
        ]);
      }
    } finally {
      const closed = once(server, 'close').catch(() => undefined);
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
      await fixture.cleanup();
    }
  });

  it('removes all generated material and cleanup remains idempotent', async () => {
    const fixture = await createEphemeralTlsServerFixture();
    await expect(access(fixture.privateKeyPath)).resolves.toBeUndefined();

    await fixture.cleanup();
    await fixture.cleanup();

    await expect(access(fixture.directoryPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retries cleanup after a transient removal failure', async () => {
    const fixture = await createEphemeralTlsServerFixture();
    rmMock.mockRejectedValueOnce(
      Object.assign(new Error('synthetic cleanup failure'), {
        code: 'EACCES',
      }),
    );

    try {
      await expect(fixture.cleanup()).rejects.toMatchObject({
        code: 'EACCES',
      });
      await fixture.cleanup();
      await expect(access(fixture.directoryPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(fixture.directoryPath, { recursive: true, force: true });
    }
  });
});
