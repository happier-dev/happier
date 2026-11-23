import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseTls } from '../connection.js';
import { mysqlConnectionOptions, openMysqlConnection } from './mysql.js';
import { openPostgresqlConnection } from './postgresql.js';

// A private CA signs a leaf whose only name is `localhost`, the shape of a
// self-generated database certificate reached through another host name.
// Keys are generated per run; the repository never tracks private keys.
let ca = '';
let serverTls = { key: '', cert: '' };
let certificates = '';
beforeAll(async () => {
  certificates = await mkdtemp(join(tmpdir(), 'happier-database-tls-'));
  const openssl = (...args: string[]) => promisify(execFile)('openssl', args, { cwd: certificates });
  await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2',
    '-subj', '/CN=Happier Database TLS Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  await openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
  await writeFile(join(certificates, 'server.ext'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  await openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.crt', '-days', '2', '-extfile', 'server.ext');
  const read = (name: string) => readFile(join(certificates, name), 'utf8');
  ca = await read('ca.crt');
  serverTls = { key: await read('server.key'), cert: await read('server.crt') };
}, 60_000);
afterAll(async () => { if (certificates) await rm(certificates, { recursive: true, force: true }); });

type Observed = {
  connections: number;
  tlsLogins: number;
  plaintextLogins: number;
};
const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(handle: (socket: Socket, observed: Observed) => void) {
  const observed: Observed = {
    connections: 0,
    tlsLogins: 0,
    plaintextLogins: 0,
  };
  const server = createServer((socket) => {
    observed.connections++;
    socket.on('error', () => {});
    handle(socket, observed);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, observed };
}

function upgrade(socket: Socket, buffered?: Buffer): TLSSocket {
  // The MySQL client starts TLS right after SSLRequest, so its hello can share
  // the request chunk. Replay those bytes ahead of the rest of the socket.
  const readable = new PassThrough();
  if (buffered?.length) readable.write(buffered);
  socket.pipe(readable);
  const secure = new TLSSocket(Duplex.from({ readable, writable: socket }), { isServer: true, ...serverTls });
  secure.on('error', () => {});
  return secure;
}

/** PostgreSQL SSLRequest negotiation; a login that reaches the server is refused with 28P01. */
function postgres(acceptsTls: boolean) {
  return listen((socket, observed) =>
    socket.once('data', (first) => {
      if (first.length !== 8 || first.readInt32BE(4) !== 80877103) {
        observed.plaintextLogins++;
        socket.destroy();
        return;
      }
      if (!acceptsTls) {
        socket.write('N');
        socket.on('data', () => {
          observed.plaintextLogins++;
          socket.destroy();
        });
        return;
      }
      socket.write('S');
      const secure = upgrade(socket);
      secure.once('data', () => {
        observed.tlsLogins++;
        const fields = Buffer.from(
          'SFATAL\0VFATAL\0C28P01\0Mfixture refused login\0\0',
        );
        const length = Buffer.alloc(4);
        length.writeInt32BE(fields.length + 4);
        secure.end(Buffer.concat([Buffer.from('E'), length, fields]));
      });
    }),
  );
}

function mysqlPacket(sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}

/** MySQL protocol 10 greeting; a login that reaches the server is refused with 1045. */
function mysql(acceptsTls: boolean) {
  const capabilities =
    0x1 | 0x200 | 0x8000 | 0x80000 | (acceptsTls ? 0x800 : 0);
  const u16 = (value: number) => {
    const out = Buffer.alloc(2);
    out.writeUInt16LE(value);
    return out;
  };
  const greeting = mysqlPacket(
    0,
    Buffer.concat([
      Buffer.from([10]),
      Buffer.from('8.4.0\0'),
      Buffer.from([1, 0, 0, 0]),
      Buffer.alloc(8, 0x61),
      Buffer.from([0]),
      u16(capabilities & 0xffff),
      Buffer.from([0x21]),
      u16(2),
      u16(capabilities >>> 16),
      Buffer.from([21]),
      Buffer.alloc(10),
      Buffer.alloc(12, 0x62),
      Buffer.from([0]),
      Buffer.from('mysql_native_password\0'),
    ]),
  );
  const refusal = mysqlPacket(
    3,
    Buffer.concat([
      Buffer.from([0xff]),
      u16(1045),
      Buffer.from('#28000fixture refused login'),
    ]),
  );
  return listen((socket, observed) => {
    socket.write(greeting);
    socket.once('data', (request) => {
      // SSLRequest carries only the 32-byte capability header; anything else is a plaintext login.
      if (request.readUIntLE(0, 3) !== 32) {
        observed.plaintextLogins++;
        socket.destroy();
        return;
      }
      const secure = upgrade(socket, request.subarray(36));
      secure.once('data', () => {
        observed.tlsLogins++;
        secure.end(refusal);
      });
    });
  });
}

const unverified: DatabaseTls = { trust: 'encrypted_unverified' };

describe('PostgreSQL endpoint trust', () => {
  it('verified mode refuses an untrusted or name-mismatched certificate and never retries without verification', async () => {
    const { port, observed } = await postgres(true);
    await expect(
      openPostgresqlConnection(
        `postgresql://reader:pw@localhost:${port}/app`,
        undefined,
        { tls: {} },
      ),
    ).rejects.toThrow();
    await expect(
      openPostgresqlConnection(
        `postgresql://reader:pw@127.0.0.1:${port}/app`,
        undefined,
        { tls: { trust: 'verified', ca } },
      ),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(observed).toEqual({
      connections: 2,
      tlsLogins: 0,
      plaintextLogins: 0,
    });
    // The trusted CA and matching name complete the login exchange over TLS.
    await expect(
      openPostgresqlConnection(
        `postgresql://reader:pw@localhost:${port}/app`,
        undefined,
        { tls: { ca } },
      ),
    ).rejects.toMatchObject({ code: '28P01' });
    expect(observed.tlsLogins).toBe(1);
  });

  it('encrypted-unverified mode logs in over TLS to the same server and ignores URL options that disable TLS', async () => {
    const { port, observed } = await postgres(true);
    await expect(
      openPostgresqlConnection(
        `postgresql://reader:pw@127.0.0.1:${port}/app?sslmode=disable`,
        undefined,
        { tls: unverified },
      ),
    ).rejects.toMatchObject({ code: '28P01' });
    expect(observed).toEqual({
      connections: 1,
      tlsLogins: 1,
      plaintextLogins: 0,
    });
  });

  it('encrypted-unverified mode refuses a server that offers only plaintext', async () => {
    const { port, observed } = await postgres(false);
    await expect(
      openPostgresqlConnection(
        `postgresql://reader:pw@127.0.0.1:${port}/app`,
        undefined,
        { tls: unverified },
      ),
    ).rejects.toThrow('The server does not support SSL connections');
    expect(observed.plaintextLogins).toBe(0);
  });
});

describe('MySQL endpoint trust', () => {
  it('maps each declared mode to driver TLS options', () => {
    expect(
      mysqlConnectionOptions('mysql://reader:pw@db.example/app', {
        trust: 'verified',
        ca,
      }).ssl,
    ).toEqual({ rejectUnauthorized: true, verifyIdentity: true, ca });
    expect(
      mysqlConnectionOptions(
        'mysql://reader:pw@db.example/app?ssl=false',
        unverified,
      ),
    ).toMatchObject({
      uri: 'mysql://reader:pw@db.example/app',
      ssl: { rejectUnauthorized: false, verifyIdentity: false },
    });
  });

  it('verified mode authenticates the dialed name and never retries without verification', async () => {
    const { port, observed } = await mysql(true);
    const via = () => async () => {
      const stream = connect(port, '127.0.0.1');
      await once(stream, 'connect');
      return { stream, close: async () => { stream.destroy(); } };
    };
    // A trusted chain whose names omit the dialed proxy host is refused before login.
    await expect(openMysqlConnection(`mysql://reader:pw@proxy.example.invalid:${port}/app`, undefined,
      { tls: { ca }, openStream: via() })).rejects.toThrow('Hostname/IP does not match certificate');
    // The driver cannot check an IP literal against the certificate, so verified mode refuses it.
    await expect(openMysqlConnection(`mysql://reader:pw@127.0.0.1:${port}/app`, undefined, { tls: { ca } }))
      .rejects.toMatchObject({ failure: { code: 'database_read_role_tls_hostname_required' } });
    expect(observed).toEqual({ connections: 1, tlsLogins: 0, plaintextLogins: 0 });
    await expect(openMysqlConnection(`mysql://reader:pw@localhost:${port}/app`, undefined,
      { tls: { ca }, openStream: via() })).rejects.toMatchObject({ errno: 1045 });
    expect(observed.tlsLogins).toBe(1);
  });

  it('encrypted-unverified mode logs in over TLS to the same server', async () => {
    const { port, observed } = await mysql(true);
    await expect(openMysqlConnection(`mysql://reader:pw@127.0.0.1:${port}/app`, undefined, { tls: unverified }))
      .rejects.toMatchObject({ errno: 1045 });
    expect(observed).toEqual({ connections: 1, tlsLogins: 1, plaintextLogins: 0 });
  });

  it('encrypted-unverified mode refuses a server that offers only plaintext', async () => {
    const { port, observed } = await mysql(false);
    await expect(
      openMysqlConnection(
        `mysql://reader:pw@127.0.0.1:${port}/app`,
        undefined,
        { tls: unverified },
      ),
    ).rejects.toMatchObject({ code: 'HANDSHAKE_NO_SSL_SUPPORT' });
    expect(observed.plaintextLogins).toBe(0);
  });
});
