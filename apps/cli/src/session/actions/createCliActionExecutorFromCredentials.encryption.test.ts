import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionRequestEnvelopeV2Schema, openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { ExternalActionMachineBootstrapListV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

import { withCliApiToken } from '@/auth/cliApiToken';
import { reloadConfiguration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

const persistentMachineBootstrap = ExternalActionMachineBootstrapListV1Schema.parse([
  { id: 'machine-1', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null },
]);

describe('CLI encrypted SDK transport through real HTTP', () => {
  it.each([false, true])('keeps local credential custody and protects the complete Action (direct daemon: %s)', async (directDaemon) => {
    const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const context = { serverIdentityId: 'srv_sdk', accountId: 'account-1', tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const token = formatAccountApiTokenCredentialV1({ bearer, wrappingSecret: encodeBase64(wrappingSecret, 'base64url'),
      serverIdentityId: context.serverIdentityId, accountId: context.accountId, contentPublicKey: context.contentPublicKey });
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret, contentPrivateKey: material.machineKey,
      randomBytes: (length) => new Uint8Array(length).fill(3) });
    const captured: unknown[] = [];
    const failures: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        captured.push({ path: request.url, authorization: request.headers.authorization, body });
        expect(request.headers.authorization).toBe(`Bearer ${bearer}`);
        let result: unknown;
        if (request.url?.endsWith('/encryption-access')) {
          expect(body).toBe('{}');
          result = { v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess };
        } else if (request.url?.endsWith('/v1/machines')) {
          // A protected Action aimed at a Machine first asks the bootstrap
          // projection what that Machine publishes, so a restricted Runner is
          // sealed with its own content key. This Home hosts one ordinary
          // persistent daemon, so the released Account sealing stands.
          result = persistentMachineBootstrap;
        } else {
          const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(body));
          expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine-1' });
          const actionId = decodeURIComponent(request.url!.split('/').at(-1)!);
          const binding = { serverIdentityId: context.serverIdentityId, accountId: context.accountId,
            credentialId: context.tokenId, actionId,
            requestId: envelope.requestId, target: envelope.target! };
          const input = openExternalActionRequestV2({ envelope, binding, material })?.input;
          const executionResult = actionId === 'session.list'
            ? { sessions: [{ id: 'c123456789012345678901234', tag: 'private-tag-sentinel', createdAt: 1, updatedAt: 2,
              active: true, activeAt: 2, share: null, encryption: null }], nextCursor: null, hasNext: false }
            // A real `session.message.send` admission result: the SDK settles
            // every success through the Action's declared output schema, so the
            // private sentinel has to travel inside a result the Action can
            // actually return.
            : { status: 'accepted', localId: 'private-result-sentinel' };
          expect(input).toMatchObject(actionId === 'session.list'
            ? { limit: 200 }
            : { sessionId: 'c123456789012345678901234', message: 'private-input-sentinel' });
          result = prepareExternalActionResponseV2({ request: envelope, binding, material, executedMachineId: 'machine-1',
            randomBytes: (length) => new Uint8Array(length).fill(4), execution: { ok: true, result: executionResult } }).response;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      })().catch((error: unknown) => { failures.push(error); response.writeHead(500); response.end('{}'); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN']);
    try {
      await withTempDir('happier-cli-encrypted-sdk-', async (homeDir) => {
        env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: endpoint, HAPPIER_TOKEN: undefined });
        reloadConfiguration();
        if (directDaemon) {
          await mkdir(join(homeDir, 'servers', 'cloud'), { recursive: true });
          await writeFile(join(homeDir, 'servers', 'cloud', 'daemon.state.json'), JSON.stringify({ pid: process.pid,
            httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', machineId: 'machine-1' }));
        }
        await withCliApiToken(token, async () => {
          const credentials = await readStoredCredentials();
          expect(credentials?.token).toBe(bearer);
          if (!credentials) throw new Error('Expected invocation credential');
          const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'cloud', serverApiUrl: endpoint, machineId: 'machine-1' });
          await expect(executor.execute('session.message.send', {
            sessionId: directDaemon ? 'private-tag-sentinel' : 'c123456789012345678901234', message: 'private-input-sentinel',
          }, { surface: 'cli' })
            .catch((error: unknown) => { if (failures.length) throw new AggregateError(failures, 'HTTP fixture failed'); throw error; }))
            .resolves.toEqual({ ok: true, result: { status: 'accepted', localId: 'private-result-sentinel' } });
        });
        expect(failures).toEqual([]);
        // Each protected client pays exactly one encryption-access read and one
        // Machine bootstrap read before its Action; the direct-daemon arm builds
        // three of them (two Session resolutions plus the send).
        expect((captured as readonly { path: string }[]).map((entry) => entry.path)).toEqual(
          directDaemon
            ? ['/v1/auth/api-tokens/encryption-access', '/v1/machines', '/v1/actions/session.list',
              '/v1/auth/api-tokens/encryption-access', '/v1/machines', '/v1/actions/session.list',
              '/v1/auth/api-tokens/encryption-access', '/v1/machines', '/v1/actions/session.message.send']
            : ['/v1/auth/api-tokens/encryption-access', '/v1/machines', '/v1/actions/session.message.send'],
        );
        expect(JSON.stringify(captured)).not.toContain('sentinel');
        expect(JSON.stringify(captured)).not.toContain(token);
      });
    } finally {
      env.restore(); reloadConfiguration();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('keeps a protected direct-daemon Board effect bound to its exact Session target', async () => {
    const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const context = { serverIdentityId: 'srv_sdk', accountId: 'account-1', tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const token = formatAccountApiTokenCredentialV1({ bearer, wrappingSecret: encodeBase64(wrappingSecret, 'base64url'),
      serverIdentityId: context.serverIdentityId, accountId: context.accountId, contentPublicKey: context.contentPublicKey });
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret, contentPrivateKey: material.machineKey,
      randomBytes: (length) => new Uint8Array(length).fill(3) });
    const sessionId = 'c123456789012345678901234';
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const captured: Array<Readonly<{ path: string; body: string }>> = [];
    const failures: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        captured.push({ path: request.url ?? '', body });
        expect(request.headers.authorization).toBe(`Bearer ${bearer}`);
        let result: unknown;
        if (request.url?.endsWith('/encryption-access')) {
          result = { v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess };
        } else if (request.url?.endsWith('/v1/machines')) {
          // Session targets also use the real Runner bootstrap projection before
          // sealing. This ordinary daemon has no Runner Session claim.
          result = persistentMachineBootstrap;
        } else {
          const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(body));
          expect(envelope.target).toEqual({ kind: 'session', sessionId });
          const actionId = decodeURIComponent(request.url!.split('/').at(-1)!);
          expect(actionId).toBe('session.board.item.upsert');
          const binding = { serverIdentityId: context.serverIdentityId, accountId: context.accountId,
            credentialId: context.tokenId, actionId, requestId: envelope.requestId, target: envelope.target! };
          expect(openExternalActionRequestV2({ envelope, binding, material })?.input).toMatchObject({
            sessionId,
            itemId: 'private-item-sentinel',
            item: { title: 'private-title-sentinel' },
          });
          result = prepareExternalActionResponseV2({ request: envelope, binding, material, executedMachineId: 'machine-1',
            randomBytes: (length) => new Uint8Array(length).fill(4), execution: { ok: true, result: {
              v: 1, serverId: 'cloud', sessionId,
              result: { operation: 'upsert_item', itemId: 'private-item-sentinel', outcome: 'created', itemRevision: revision, layoutRevision: revision },
              destination: { tabId: 'overview', width: 'wide' },
              preview: { title: 'private-title-sentinel', sourceKind: 'declarative' },
            } } }).response;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      })().catch((error: unknown) => { failures.push(error); response.writeHead(500); response.end('{}'); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN']);
    try {
      await withTempDir('happier-cli-encrypted-board-', async (homeDir) => {
        env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: endpoint, HAPPIER_TOKEN: undefined });
        reloadConfiguration();
        await mkdir(join(homeDir, 'servers', 'cloud'), { recursive: true });
        await writeFile(join(homeDir, 'servers', 'cloud', 'daemon.state.json'), JSON.stringify({ pid: process.pid,
          httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', machineId: 'machine-1' }));
        await withCliApiToken(token, async () => {
          const credentials = await readStoredCredentials();
          if (!credentials) throw new Error('Expected invocation credential');
          const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'cloud', serverApiUrl: endpoint, machineId: 'machine-1' });
          await expect(executor.execute('session.board.item.upsert', {
            sessionId,
            itemId: 'private-item-sentinel',
            expectedItemRevision: null,
            item: {
              v: 1,
              title: 'private-title-sentinel',
              frame: 'card',
              height: { mode: 'auto', fallback: 'regular' },
              source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'private-body-sentinel' } } },
            },
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
          }, { surface: 'cli' })
            .catch((error: unknown) => { if (failures.length) throw new AggregateError(failures, 'HTTP fixture failed'); throw error; }))
            .resolves.toMatchObject({ ok: true, result: { sessionId, result: { operation: 'upsert_item', outcome: 'created' } } });
        });
        expect(failures).toEqual([]);
        expect(captured.map(({ path }) => path)).toEqual([
          '/v1/auth/api-tokens/encryption-access',
          '/v1/machines',
          '/v1/actions/session.board.item.upsert',
        ]);
        expect(JSON.stringify(captured)).not.toContain('sentinel');
        expect(JSON.stringify(captured)).not.toContain(token);
      });
    } finally {
      env.restore(); reloadConfiguration();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
