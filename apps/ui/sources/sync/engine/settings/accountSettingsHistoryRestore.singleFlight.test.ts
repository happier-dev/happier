import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { normalizeAccountSettingsHistoryAfterTransfer } from './accountSettingsHistoryRestore';

describe('Account Settings history maintenance requests', () => {
    it.each([false, true])('distinguishes completed history from retained credential sources without marking them applied (retained: %s)', async retained => {
        let detailReads = 0;
        let writes = 0;
        const versions = Array.from({ length: 25 }, (_, index) => index + 1);
        const home = await serveAccountHomes({
            homes: [{ key: 'home', serverUrl: `https://history-convergence-${retained ? 'retained' : 'complete'}.test`, accountId: 'alice', accountMode: 'plain',
                encryptionCurrentness: () => ({ mode: 'plain', version: 1, settingsVersion: 26,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) }],
            route: async request => {
                if (request.method !== 'GET' && request.path.startsWith('/v2/account/settings/history/')) writes++;
                if (request.path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (request.path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed', rows: [] });
                if (request.path.startsWith('/v1/account/entity-rows/')) return Response.json({ error: 'not_found' }, { status: 404 });
                if (request.path === '/v2/account/settings/history') return Response.json({ snapshots: versions.map(version => ({
                    version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100,
                })) });
                const detail = /^\/v2\/account\/settings\/history\/(\d+)$/.exec(request.path);
                if (detail) {
                    detailReads++;
                    return Response.json({ version: Number(detail[1]), createdAt: '2026-01-01T00:00:00.000Z',
                        content: { t: 'plain', v: { preferredLanguage: 'de',
                            ...(retained ? { inferenceOpenAIKey: 'synthetic-retained-history-value' } : {}) } } });
                }
                return undefined;
            },
        });
        const context = await captureLazyActionAccountContext(home.homes.home!.id);
        try {
            const scan = () => normalizeAccountSettingsHistoryAfterTransfer({
                credentials: context.credentials, encryption: null,
                settingsScope: { serverId: context.serverId, accountId: context.accountId },
                destinationAuthority: { activeTransferredRoots: [] },
                requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
            });
            const expected = retained ? { status: 'cleanup-pending', versions } : { status: 'complete' };
            expect(await scan()).toEqual(expected);
            expect(detailReads).toBe(25);
            const firstPassReads = detailReads;
            expect(await scan()).toEqual(expected);
            // A settled pass reads no history again until an input moves. Retained
            // sources stay reported pending; nothing here marks them applied.
            expect(detailReads).toBe(firstPassReads);
            expect(writes).toBe(0);
        } finally {
            context.dispose();
            await home.dispose();
        }
    });

    it('walks retained history once for different catalog triggers, one at a time, and again once an input moves', async () => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let detailReads = 0;
        let settingsVersion = 26;
        let revealed = false;
        const versions = [1, 2];
        const home = await serveAccountHomes({
            homes: [{ key: 'home', serverUrl: 'https://history-triggers.test', accountId: 'alice', accountMode: 'plain',
                encryptionCurrentness: () => ({ mode: 'plain', version: 1, settingsVersion,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) }],
            route: async request => {
                if (request.path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (request.path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed', rows: [] });
                if (request.path.startsWith('/v1/account/entity-rows/')) return Response.json({ error: 'not_found' }, { status: 404 });
                if (request.path === '/v2/account/settings/history') return Response.json({ snapshots: versions.map(version => ({
                    version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100,
                })) });
                const detail = /^\/v2\/account\/settings\/history\/(\d+)$/.exec(request.path);
                if (!detail) return undefined;
                detailReads++;
                if (!revealed) { revealed = true; entered.resolve(); await release.promise; }
                return Response.json({ version: Number(detail[1]), createdAt: '2026-01-01T00:00:00.000Z',
                    content: { t: 'plain', v: { inferenceOpenAIKey: 'synthetic-retained-history-value' } } });
            },
        });
        const context = await captureLazyActionAccountContext(home.homes.home!.id);
        try {
            const scan = (expectedProfileTransferRevision?: 'absent') => normalizeAccountSettingsHistoryAfterTransfer({
                credentials: context.credentials, encryption: null,
                settingsScope: { serverId: context.serverId, accountId: context.accountId },
                destinationAuthority: { activeTransferredRoots: [] },
                ...(expectedProfileTransferRevision ? { expectedProfileTransferRevision } : {}),
                requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
            });
            const pending = { status: 'cleanup-pending', versions };
            const catalog = scan();
            await entered.promise;
            const profiles = scan('absent');
            release.resolve();
            expect(await Promise.all([catalog, profiles])).toEqual([pending, pending]);
            expect(detailReads).toBe(versions.length);
            settingsVersion++;
            expect(await scan()).toEqual(pending);
            expect(detailReads).toBe(versions.length * 2);
        } finally {
            release.resolve();
            context.dispose();
            await home.dispose();
        }
    });

    it.each([
        { accountMode: 'plain' as const, differentProof: false },
        { accountMode: 'e2ee' as const, differentProof: false },
        { accountMode: 'e2ee' as const, differentProof: true },
    ])('shares equivalent $accountMode cleanup and scans again only when its inputs change (different proof: $differentProof)', async ({ accountMode, differentProof }) => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let detailReads = 0;
        let cleanupWrites = 0;
        let settingsVersion = 7;
        let accountVersion = 1;
        let transferRevision: number | null = null;
        let privateRevision: number | null = null;
        let detailUnavailable = false;
        let recoveryRevision = 1;
        const credentials = { token: createAccountTokenForTests('alice'),
            ...(accountMode === 'e2ee' ? { secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') } : {}) };
        const home = await serveAccountHomes({
            homes: [{ key: 'home', serverUrl: 'https://history-maintenance.test', accountId: 'alice', accountMode,
                credentials,
                encryptionCurrentness: () => ({
                    ...createAccountEncryptionCurrentnessFixtureForCredentials(credentials), version: accountVersion, settingsVersion,
                }),
            }],
            route: async request => {
                if (request.method !== 'GET' && (request.path === '/v2/account/settings'
                    || request.path.startsWith('/v2/account/settings/history/'))) cleanupWrites++;
                if (request.path === '/v1/account/entity-rows/profiles/transfer') return Response.json(transferRevision === null
                    ? { status: 'absent' } : { status: 'deleted', revision: transferRevision });
                if (request.path === '/v1/account/entity-rows/mcp') return Response.json(privateRevision === null
                    ? { status: 'absent' } : { status: 'deleted', revision: privateRevision });
                if (request.path === '/v2/account/settings/history') return Response.json({ snapshots: [{
                    version: 6, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100,
                }] });
                if (request.path === '/v2/account/settings/history/6') {
                    detailReads += 1;
                    entered.resolve();
                    await release.promise;
                    if (detailUnavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
                    return Response.json({ version: 6, createdAt: '2026-01-01T00:00:00.000Z',
                        content: { t: 'plain', v: { preferredLanguage: 'de' } } });
                }
                return undefined;
            },
        });
        const contexts = await Promise.all([
            captureLazyActionAccountContext(home.homes.home!.id),
            captureLazyActionAccountContext(home.homes.home!.id),
        ]);
        try {
            const encryptions = await Promise.all(contexts.map(context => context.resolveAccountEncryption()));
            const scan = (index: number, roots: string[]) => {
                const context = contexts[index]!;
                return normalizeAccountSettingsHistoryAfterTransfer({
                    credentials: context.credentials, encryption: encryptions[index]!.encryption,
                    settingsScope: { serverId: context.serverId, accountId: context.accountId },
                    destinationAuthority: { activeTransferredRoots: roots,
                        ...(differentProof && index === 1 ? { savedSecretTransfers: [{ savedSecretId: 'old', resourceId: 'resource', expectedRevision: 1 }] } : {}) },
                    savedSecretRecovery: { accountId: context.accountId, source: { version: 7, raw: { preferredLanguage: 'de' } },
                        resources: [{ resourceId: 'resource', ownerAccountId: context.accountId, revision: recoveryRevision, materialStatus: 'ready' }] },
                    requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                });
            };
            const first = scan(0, ['profiles']);
            await entered.promise;
            const second = scan(1, ['mcpServers']);
            release.resolve();
            expect(await Promise.all([first, second])).toEqual([{ status: 'complete' }, { status: 'complete' }]);
            expect(detailReads).toBe(differentProof ? 2 : 1);
            accountVersion++;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 2 : 1);
            const settledReads = detailReads;
            for (let wake = 0; wake < 5; wake++) {
                accountVersion++;
                expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            }
            expect(detailReads - settledReads).toBe(0);
            expect(cleanupWrites).toBe(0);
            // Row 6 holds no saved-secret content, so its clean verdict holds under recovery: an input
            // change re-lists history but re-reads the row only when the verdict key changes.
            settingsVersion++;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 2 : 1);
            transferRevision = 1;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 2 : 1);
            // A tombstoned private catalog adds an active root: a new verdict key reads the row again.
            privateRevision = 1;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 3 : 2);
            settingsVersion++;
            detailUnavailable = true;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            detailUnavailable = false;
            recoveryRevision++;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 3 : 2);
        } finally {
            release.resolve();
            contexts.forEach(context => context.dispose());
            await home.dispose();
        }
    });
    it('reuses rows verified clean on an earlier app start and reads only rows created since', async () => {
        const detailReads: number[] = [];
        let versions = [3, 2, 1];
        let settingsVersion = 4;
        const home = await serveAccountHomes({
            homes: [{ key: 'home', serverUrl: 'https://history-relaunch.test', accountId: 'alice', accountMode: 'plain',
                encryptionCurrentness: () => ({ mode: 'plain', version: 1, settingsVersion,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) }],
            route: async request => {
                if (request.path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (request.path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed', rows: [] });
                if (request.path.startsWith('/v1/account/entity-rows/')) return Response.json({ error: 'not_found' }, { status: 404 });
                if (request.path === '/v2/account/settings/history') return Response.json({ snapshots: versions.map(version => ({
                    version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100,
                })) });
                const detail = /^\/v2\/account\/settings\/history\/(\d+)$/.exec(request.path);
                if (!detail) return undefined;
                detailReads.push(Number(detail[1]));
                return Response.json({ version: Number(detail[1]), createdAt: '2026-01-01T00:00:00.000Z',
                    content: { t: 'plain', v: { preferredLanguage: 'de' } } });
            },
        });
        const context = await captureLazyActionAccountContext(home.homes.home!.id);
        try {
            // Each launch is a fresh module instance: nothing survives in process memory.
            const scanOnFreshLaunch = async () => {
                vi.resetModules();
                const launched = await import('./accountSettingsHistoryRestore');
                return launched.normalizeAccountSettingsHistoryAfterTransfer({
                    credentials: context.credentials, encryption: null,
                    settingsScope: { serverId: context.serverId, accountId: context.accountId },
                    destinationAuthority: { activeTransferredRoots: [] },
                    requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                });
            };
            expect(await scanOnFreshLaunch()).toEqual({ status: 'complete' });
            expect(detailReads).toEqual([3, 2, 1]);
            expect(await scanOnFreshLaunch()).toEqual({ status: 'complete' });
            expect(detailReads).toEqual([3, 2, 1]);
            // A Settings write between launches retains one new row: only that row is read.
            settingsVersion = 5;
            versions = [4, 3, 2, 1];
            expect(await scanOnFreshLaunch()).toEqual({ status: 'complete' });
            expect(detailReads).toEqual([3, 2, 1, 4]);
        } finally {
            context.dispose();
            await home.dispose();
        }
    });
});
