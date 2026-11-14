import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { AutomationEventDeclarationReleaseV1, PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { readProjectAccountRowsObservation } from '@/workspaces/projectAccountRows';
import { projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { acquireRequesterAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from './serverHttpBaseUrl';

/**
 * P03 R3: read-only consumers borrow the held Account encryption observation.
 * HTTP is the only boundary; the real observation, socket channel and readers run.
 */
async function heldObservationFixture() {
    const channel = await createRequesterCurrentnessSocketHarness();
    const secret = new Uint8Array(32).fill(9);
    const accountId = 'r3-read-consumer-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    const currentness: AccountEncryptionCurrentnessResponse = { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current',
        contentKeyFingerprint: fingerprint, updatedAt: 1 };
    const modeReads = { currentness: 0, mode: 0 };
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const reply = (status: number, body: unknown) => {
                response.statusCode = status;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(body));
            };
            const url = request.url ?? '';
            if (url === '/v1/account/encryption/currentness') { modeReads.currentness++; return reply(200, currentness); }
            if (url === '/v1/account/encryption') { modeReads.mode++; return reply(200, { mode: currentness.mode, updatedAt: currentness.updatedAt }); }
            if (url.startsWith('/v1/account/project-rows')) {
                const result = projectAccountRowsReadHttpResponse([], url, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
                return reply(result.status, result.data);
            }
            return reply(404, { error: 'not_found' });
        });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl: base });
    await holder.read();
    return {
        base, accountId,
        credentials: { token, encryption: { type: 'legacy' as const, secret } },
        modeReads: () => ({ ...modeReads }),
        async close() {
            await holder.dispose();
            await channel.close();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

it('refreshes an adopted Automation definition set 21 times without an Account mode HTTP read', async () => {
    const fixture = await heldObservationFixture();
    close = fixture.close;
    const caller = { pluginId: 'com.acme.github', machineId: 'machine-current', materializationId: 'materialization-current' } as const satisfies PluginMachineMaterializationRefV1;
    const eventDeclarationRelease = { release: { pluginId: caller.pluginId, version: '1.0.0' },
        archiveDigestSha256: `sha256:${'a'.repeat(64)}` } as const satisfies AutomationEventDeclarationReleaseV1;
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
        credentials: fixture.credentials, caller, occurrenceId: 'occurrence-current',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-current', installSource: 'archive' },
        transport: { kind: 'checkpointedPull' }, occurrenceSignal: new AbortController().signal,
        isOccurrenceCurrent: () => true, revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
        readStoredDefinitions: async () => ({ kind: 'page', revision: '7', eventDeclarationRelease, definitions: [], nextCursor: null }),
    });
    const before = fixture.modeReads();
    for (let index = 0; index < 21; index += 1) {
        await expect(runWithServerHttpBaseUrl(fixture.base, () => owner.refresh())).resolves.toMatchObject({ revision: '7' });
    }
    const after = fixture.modeReads();
    expect({ currentness: after.currentness - before.currentness, mode: after.mode - before.mode }).toEqual({ currentness: 0, mode: 0 });
});

it('reads Project rows for attribution 10 times without an Account mode HTTP read', async () => {
    const fixture = await heldObservationFixture();
    close = fixture.close;
    const before = fixture.modeReads();
    for (let index = 0; index < 10; index += 1) {
        await runWithServerHttpBaseUrl(fixture.base, () => readProjectAccountRowsObservation({
            credentials: fixture.credentials, serverId: 'home-r3', selection: { kinds: ['workspace-ref'] },
        }));
    }
    const after = fixture.modeReads();
    expect({ currentness: after.currentness - before.currentness, mode: after.mode - before.mode }).toEqual({ currentness: 0, mode: 0 });
});
