import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { createServiceHealthNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { readAccountNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { settingsParse } from '@/sync/domains/settings/settings';

// Only the network/socket boundary is replaced; Account custody, codecs,
// Artifact revisions and the ordinary Action front door remain real.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storage');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
afterEach(async () => {
    await account?.dispose();
    account = undefined;
    storage.setState(originalState, true);
});

describe('private notice dismissal through the Account Action front door', () => {
    it.each(['plain', 'e2ee'] as const)('dismisses exact %s notice revisions without fabricating recovery', async mode => {
        account = await createSecretSettingsTestHarness({ mode, settings: settingsParse({}) });
        const home = account;
        const owner = await captureLazyActionAccountContext(home.scope.serverId);
        try {
            const fixture = createUsageNoticeArtifactFixture({ id: '11111111-1111-4111-8111-111111111111' });
            await owner.createArtifactDocument({ artifactId: fixture.id, header: fixture.rawHeader ?? fixture.header, body: fixture.body ?? '' });
            const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
            const context = { surface: 'ui', authority: 'present_user', serverId: home.scope.serverId,
                runtimeAccountId: home.scope.accountId, expectedAccountId: home.scope.accountId } as const;
            const displayed = await owner.fetchArtifact(fixture.id, { fresh: true });
            if (!displayed) throw new Error('Missing created notice');
            expect(await execute('inbox.notice.dismiss', { artifactId: fixture.id }, context))
                .toMatchObject({ ok: true, result: { artifactId: fixture.id, status: 'dismissed' } });
            expect(await owner.fetchArtifact(fixture.id, { fresh: true }))
                .toMatchObject({ rawHeader: { kind: 'usage_notice.v1', status: 'dismissed' }, body: fixture.body });
            expect(await execute('inbox.notice.dismiss', { artifactId: fixture.id }, context))
                .toMatchObject({ ok: true, result: { status: 'unchanged' } });
            const recovery = createServiceHealthNoticeArtifactFixture(home.scope.serverId, {
                id: '33333333-3333-4333-8333-333333333333', header: {
                type: 'update', healthPhase: 'recovered', resolved: false,
            } });
            await owner.createArtifactDocument({ artifactId: recovery.id, header: recovery.rawHeader ?? recovery.header, body: recovery.body ?? '' });
            const stale = await owner.fetchArtifact(recovery.id, { fresh: true });
            if (!stale) throw new Error('Missing recovery notice');
            await owner.updateArtifact(recovery.id, { ...stale.header, title: 'New evidence' }, stale.body as string, stale);
            expect(await execute('inbox.notice.dismiss', { artifactId: recovery.id,
                expectedRevision: { headerVersion: stale.headerVersion, bodyVersion: stale.bodyVersion } }, context))
                .toMatchObject({ ok: false, errorCode: 'usage_notice_changed' });
            const beforeForeign = home.request.mock.calls.length;
            expect(await execute('inbox.notice.dismiss', { artifactId: recovery.id }, { ...context, expectedAccountId: 'foreign' }))
                .toMatchObject({ ok: false });
            expect(home.request.mock.calls).toHaveLength(beforeForeign);
            expect(await execute('inbox.notice.dismiss', { artifactId: recovery.id }, context)).toMatchObject({ ok: true });
            const settled = await owner.fetchArtifact(recovery.id, { fresh: true });
            expect(settled && readAccountNoticeArtifactHeader(settled, home.scope.accountId))
                .toMatchObject({ status: 'dismissed', healthPhase: 'recovered', resolved: true });
        } finally { owner.dispose(); }
    });
});
