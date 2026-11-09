import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { snapshotConnectedAccountEstablishedResult } from '../../../../../../packages/cli-common/src/connectedAccounts/producerResultSnapshot';
import { createAntigravityConnectedAccountRuntime } from '../../../../../../packages/plugins/antigravity/src/connectedAccounts/antigravityConnectedAccountRuntime';
import { createConnectedAccountRequestAuthService, type ConnectedAccountRequestAuthSubject } from './ConnectedAccountRequestAuthService';
import { parseHttpHeadersRequestAuthMaterial } from './parseHttpHeadersRequestAuthMaterial';

describe('Connected Account request-auth header material', () => {
    it('carries real service headers, expiry and facts through snapshots, lookup and the strict SDK transport with one materialization', async () => {
        const runtime = createAntigravityConnectedAccountRuntime();
        const account = { service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }, accountId: 'selected' };
        const purpose = { consumer: { pluginId: 'happier.provider.test', localId: 'gateway' }, purpose: 'upstream' };
        const materialization = { kind: 'httpHeaders' as const, origin: 'https://daily-cloudcode-pa.googleapis.com', headerNames: ['authorization'] };
        const binding = { purpose, target: { kind: 'account' as const, account } };
        const expiresAt = Date.now() + 60_000;
        const credentials = new Map([['accessToken', 'fixture-token'], ['projectId', 'fixture-project'], ['expiresAtMs', String(expiresAt)]]);
        const context = { account, signal: new AbortController().signal,
            credentials: { async get(key: string) { return credentials.get(key) ?? null; } },
            configuration: { target: { kind: 'account' as const, account, modeId: 'oauth-personal' }, revision: 'configuration-1', values: {}, async getSecret() { return null; } },
        } as Parameters<typeof runtime.materialize>[1];
        let materializations = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => ({ account, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }),
            materializeHeaders: async () => {
                materializations++;
                const result = await runtime.materialize(materialization, context);
                const snapshot = snapshotConnectedAccountEstablishedResult({ kind: 'materialize', request: materialization }, result, { quotaLeafUnavailable: false });
                return parseHttpHeadersRequestAuthMaterial(materialization, snapshot);
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_unchanged' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const subject: ConnectedAccountRequestAuthSubject = { subjectId: 'fixture-gateway', isCurrent: () => true,
            registerRedaction: () => undefined, resolvePurposeUse: () => ({ binding, use: { purpose, materialization } }),
            listPurposeUses: () => [{ binding, use: { purpose, materialization } }],
        };
        const server = createServer((_request, response) => {
            void owner.lookupRequestAuth({ subject, purpose }).then(value => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: true, value }));
            }).catch(() => {
                response.writeHead(503, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: false, error: { code: 'request_auth_unavailable' } }));
            });
        });
        const directory = await mkdtemp(join(tmpdir(), 'happier-request-auth-headers-'));
        try {
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Fixture HTTP address unavailable');
            const capabilityFile = join(directory, 'capability.json');
            await writeFile(capabilityFile, JSON.stringify({ v: 2, materializationId: 'fixture', subjectScopeDigest: 'a'.repeat(64), capability: 'a'.repeat(43), httpPort: address.port }));
            const client = await createConnectedAccountRequestAuthClient({ capabilityFile });
            const results = await Promise.all([client.lookupConnectedAccountRequestAuth({ purpose }), client.lookupConnectedAccountRequestAuth({ purpose })]);
            expect(results[0]).toMatchObject({ headers: { authorization: 'Bearer fixture-token' }, facts: { projectId: 'fixture-project' }, expiresAt,
                credentialContext: { account, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
            });
            expect(results[1]).toEqual(results[0]);
            expect(materializations).toBe(1);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    });
});
