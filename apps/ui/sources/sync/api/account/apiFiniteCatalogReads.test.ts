import { expect, it } from 'vitest';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

installDisconnectedServerSocketBoundary();
// Prepare the real runtime after installing its transport boundary, before the
// per-test deadline measures the finite read rather than cold graph loading.
await loadSyncSingletonForTests();

it.each(['prompts', 'notifications'] as const)('admits a finite %s borrower while retained history cleanup is pending', async domain => {
    let historyStarted = false;
    let releaseHistory!: () => void;
    const history = new Promise<void>(resolve => { releaseHistory = resolve; });
    const account = await restoreServerAccountForTest({ serverUrl: `https://finite-${domain}.example.test`, accountId: `finite-${domain}`,
        request: async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed', rows:
                PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 4, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) });
            if (path === '/v1/account/entity-rows/notification-channels') return Response.json({ status: 'present', revision: 4,
                content: { t: 'plain', v: { v: 1, channels: [] } } });
            if (path === '/v2/account/settings/history') {
                historyStarted = true;
                await history;
                return Response.json({ snapshots: [] });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(account.home.id);
    let reading: Promise<unknown> | undefined;
    let projected: unknown;
    try {
        reading = domain === 'prompts'
            ? (await import('./apiPromptLibraryCatalog')).readPromptLibraryCatalogProjectionInContext(context)
            : (await import('./apiNotificationChannelCatalog')).readNotificationChannelCatalogProjectionInContext(context);
        void reading.then(value => { projected = value; });
        if (domain === 'prompts') {
            // The observed Account catalog loader owns prompts source maintenance; a finite
            // borrower is admitted from the complete rows without starting retained history.
            await expect.poll(() => projected).toMatchObject({ catalog: { status: 'ready' } });
            expect(historyStarted).toBe(false);
        } else {
            await expect.poll(() => historyStarted).toBe(true);
            expect(projected).toMatchObject({ catalog: { status: 'ready' } });
        }
    } finally {
        releaseHistory();
        await reading;
        context.dispose();
        await account.dispose();
    }
});
