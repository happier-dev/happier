import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { readKeychainBundle } from '../../../../../scripts/pipeline/secrets/read-keychain-bundle.mjs';

const BOT_TOKEN_ENV_KEY = 'HAPPIER_GITHUB_BOT_TOKEN';
const KEYCHAIN_SERVICE = 'happier/ghops';
const KEYCHAIN_ACCOUNT = 'happier-bot';
const MAX_REQUEST_BYTES = 4096;

function defaultReadCredential() {
  return readKeychainBundle({ service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
}

function writeResponse(socket, response) {
  socket.end(`${JSON.stringify(response)}\n`);
}

function serveRequest(socket, rawRequest, readCredential) {
  let request;
  try {
    request = JSON.parse(rawRequest);
  } catch {
    writeResponse(socket, { version: 1, ok: false, error: 'invalid request' });
    return;
  }
  if (request?.version !== 1 || request?.operation !== 'read-ghops-credential') {
    writeResponse(socket, { version: 1, ok: false, error: 'unsupported request' });
    return;
  }
  try {
    const bundle = readCredential();
    const token = String(bundle?.[BOT_TOKEN_ENV_KEY] ?? '').trim();
    if (!token) throw new Error('credential is missing');
    writeResponse(socket, {
      version: 1,
      ok: true,
      credential: { [BOT_TOKEN_ENV_KEY]: token },
    });
  } catch {
    writeResponse(socket, { version: 1, ok: false, error: 'credential unavailable' });
  }
}

export async function prepareGhopsBrokerDirectory({ rootDirectory = '/tmp', uid } = {}) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error('[execution-host] ghops credential broker requires a POSIX user id');
  }
  const directory = join(rootDirectory, `happier-ghops-brokers-${uid}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.uid !== uid) {
    throw new Error('[execution-host] ghops broker path must be a real directory owned by the execution-host user');
  }
  await chmod(directory, 0o700);
  return directory;
}

export async function startGhopsCredentialBroker({
  readCredential = defaultReadCredential,
  rootDirectory = '/tmp',
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const directory = await prepareGhopsBrokerDirectory({ rootDirectory, uid });
  const socketPath = join(directory, `broker-${process.pid}-${randomUUID()}.sock`);
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        writeResponse(socket, { version: 1, ok: false, error: 'request too large' });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      serveRequest(socket, input.slice(0, newline), readCredential);
    });
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(socketPath, resolvePromise);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await rm(socketPath, { force: true });
    throw error;
  }

  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(socketPath, { force: true });
    },
  };
}
