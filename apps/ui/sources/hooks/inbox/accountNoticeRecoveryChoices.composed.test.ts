import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AccountNoticeRecoveryChoices } from '@/components/inbox/cards/AccountNoticeRecoveryChoices';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { createAccountNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { readAccountNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createAccountNoticeInvestigation } from './accountNoticeInvestigation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storage');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
afterEach(async () => { standardCleanup(); await account?.dispose(); account = undefined; storage.setState(originalState, true); });

describe('notice recovery choices through the existing Account Action ingress', () => {
    it('dismisses a retained usage notice through the ordinary Account Action', async () => {
        account = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({}) });
        const home = account;
        const owner = await captureLazyActionAccountContext(home.scope.serverId);
        try {
            const legacy = createUsageNoticeArtifactFixture({ id: '22222222-2222-4222-8222-222222222222' });
            await owner.createArtifactDocument({ artifactId: legacy.id, header: legacy.rawHeader ?? legacy.header, body: legacy.body ?? '' });
            const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
            const context = { surface: 'ui', authority: 'present_user', serverId: home.scope.serverId,
                runtimeAccountId: home.scope.accountId, expectedAccountId: home.scope.accountId } as const;
            expect(await execute('inbox.notice.dismiss', { artifactId: legacy.id }, context)).toMatchObject({ ok: true });
            expect(await owner.fetchArtifact(legacy.id, { fresh: true }))
                .toMatchObject({ rawHeader: { kind: 'usage_notice.v1', status: 'dismissed' }, body: legacy.body });
        } finally { owner.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('admits the %s owner, keeps choice display pure and refuses stale or foreign presses', async mode => {
        account = await createSecretSettingsTestHarness({ mode, settings: settingsParse({}) });
        const home = account;
        const owner = await captureLazyActionAccountContext(home.scope.serverId);
        try {
            const artifactId = '11111111-1111-4111-8111-111111111111';
            const rollback = { serverId: home.scope.serverId, environmentId: 'environment', expectedRevision: 1,
                requestKey: 'recover', targetLinkId: 'runtime', expectedTargetLinkRevision: 1,
                deploymentId: 'previous', contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };
            const fixture = createAccountNoticeArtifactFixture({ id: artifactId, header: {
                source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
                    environmentId: 'environment', targetLinkId: 'runtime', condition: 'deployment_failed' } },
                page: { kind: 'host', page: 'environment', targetLinkId: 'runtime',
                    environment: { serverId: home.scope.serverId, projectSourceId: 'project', environmentId: 'environment' } },
                type: 'blocked', healthPhase: 'open', recoveryChoices: [
                    { actionId: 'deployments.rollback', input: { ...rollback, restoreBackupId: 'backup' }, label: 'Restore backup and roll back code' },
                    { actionId: 'deployments.rollback', input: rollback, label: 'Roll back code only' },
                    { actionId: 'inbox.notice.dismiss', input: { artifactId }, label: 'Keep and fix forward' },
                ],
            } });
            await owner.createArtifactDocument({ artifactId, header: fixture.rawHeader ?? fixture.header, body: fixture.body ?? '' });
            const readEntry = async () => {
                const artifact = await owner.fetchArtifact(artifactId, { fresh: true });
                if (!artifact) throw new Error('Missing produced notice');
                const header = readAccountNoticeArtifactHeader(artifact, home.scope.accountId);
                if (!header) throw new Error('Unreadable produced notice');
                return { artifact, header };
            };
            const entry = await readEntry();
            const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
            let current = true;
            const model = createAccountNoticeInvestigation({ scope: home.scope, execute, isCurrent: () => current });
            const readsBeforeDisplay = home.request.mock.calls.length;
            const choices = model.readRecoveryChoices(entry);
            expect(choices).toHaveLength(3);
            for (let i = 0; i < 100; i++) expect(model.readRecoveryChoices(entry)).toBe(choices);
            expect(home.request.mock.calls).toHaveLength(readsBeforeDisplay);
            current = false;
            expect(await model.runRecoveryChoice(entry, 2)).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(home.request.mock.calls).toHaveLength(readsBeforeDisplay);
            current = true;
            const foreign = { ...entry, artifact: { ...entry.artifact, ownerAccountId: 'foreign' } };
            expect(model.readRecoveryChoices(foreign)).toEqual([]);
            expect(await model.runRecoveryChoice(foreign, 2)).toMatchObject({ ok: false });
            expect(home.request.mock.calls).toHaveLength(readsBeforeDisplay);
            const wrongTarget = createAccountNoticeArtifactFixture({ id: artifactId, header: {
                ...entry.header, recoveryChoices: [{ actionId: 'inbox.notice.dismiss', input: { artifactId: 'another-owned-notice' }, label: 'Keep' }],
            } });
            expect(model.readRecoveryChoices({ artifact: wrongTarget, header: entry.header })).toEqual([]);
            expect(home.request.mock.calls).toHaveLength(readsBeforeDisplay);
            home.replaceSettings(settingsParse({ ...home.persistedSettings, actionsSettingsV1:
                normalizeActionsSettingsV1({ v: 1, actions: { 'deployments.rollback': { enabled: false } } }) }));
            expect(await model.runRecoveryChoice(entry, 0)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
            await owner.updateArtifact(artifactId, { ...entry.artifact.header, title: 'New failure evidence' }, entry.artifact.body as string, entry.artifact);
            expect(await model.runRecoveryChoice(entry, 2)).toMatchObject({ ok: false, errorCode: 'usage_notice_changed' });
            const updated = await readEntry();
            const screen = await renderScreen(React.createElement(AccountNoticeRecoveryChoices, {
                entry: updated, recovery: model, testID: 'notice.recovery',
            }));
            await screen.pressByTestIdAsync('notice.recovery.choice.2');
            await vi.waitFor(async () => expect((await readEntry()).header.status).toBe('dismissed'));
            expect((await readEntry()).header).toMatchObject({ status: 'dismissed', resolved: false,
                recoveryChoices: updated.header.recoveryChoices });
            const dismissed = await readEntry();
            await screen.update(React.createElement(AccountNoticeRecoveryChoices, {
                entry: dismissed, recovery: model, testID: 'notice.recovery',
            }));
            expect(screen.findHostByTestId('notice.recovery.choice.2')).toBeNull();
            const context = { surface: 'ui', authority: 'present_user', serverId: home.scope.serverId,
                runtimeAccountId: home.scope.accountId, expectedAccountId: home.scope.accountId } as const;
            const recoveredId = '33333333-3333-4333-8333-333333333333';
            const recovered = createAccountNoticeArtifactFixture({ id: recoveredId, header: { ...entry.header,
                type: 'update', healthPhase: 'recovered', recoveryChoices: [
                    { actionId: 'inbox.notice.dismiss', input: { artifactId: recoveredId }, label: 'Keep' },
                ] } });
            await owner.createArtifactDocument({ artifactId: recoveredId, header: recovered.rawHeader ?? recovered.header, body: recovered.body ?? '' });
            expect(await execute('inbox.notice.dismiss', { artifactId: recoveredId }, context)).toMatchObject({ ok: true });
            const dismissedRecovery = await owner.fetchArtifact(recoveredId, { fresh: true });
            expect(dismissedRecovery && readAccountNoticeArtifactHeader(dismissedRecovery, home.scope.accountId))
                .toMatchObject({ status: 'dismissed', healthPhase: 'recovered', resolved: true,
                    recoveryChoices: recovered.header.recoveryChoices });
        } finally { owner.dispose(); }
    });
});
