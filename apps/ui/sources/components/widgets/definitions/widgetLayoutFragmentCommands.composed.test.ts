import { createElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, waitForTestEvent } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { isApprovalArtifactKindV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { ModalProvider } = await import('@/modal/ModalProvider');
const { runAddWidgetLayoutFragmentCommandV1 } = await import('./widgetLayoutFragmentCommands');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
});

it('carries the saved name into the native group Action review and placed copy', async () => {
    const serverId = await homes.addHome({ name: 'Home A', serverUrl: 'https://fragment-copy.test', accountId: 'account-a', currentAccount: true });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fragment-copy.test', accountId: 'account-a',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) }, request: homes.request });
    installHomeGovernanceBoundaries(homes);
    await homes.requireUiApproval(serverId, 'widgets.group.add');
    expect(getActiveServerAccountScope()).toEqual({ serverId, accountId: 'account-a' });
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'home' as const } };
    const controller = new AbortController();
    const executor = createDefaultActionExecutor();
    const readLayout = () => executor.execute('home.hub.layout.get', {}, { surface: 'ui', authority: 'present_user', serverId });
    const approvalArtifacts = () => homes.artifacts(serverId).list().filter(row =>
        isApprovalArtifactKindV1(Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind')));
    const definition = { kind: 'builtin', id: 'machine_fleet' } as const;
    const screen = await renderScreen(createElement(ModalProvider, { children: null }));
    try {
        const originalLayout = await readLayout();
        expect(originalLayout).toMatchObject({ ok: true });
        const command = runAddWidgetLayoutFragmentCommandV1({ width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
            { kind: 'widget', instance: { v: 1, definition, bindings: {} } },
        ] }, surface, { name: 'Release checks', signal: controller.signal });
        await waitForTestEvent(screen.subscribe, () => {
            expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull();
            expect(screen.getTextContent()).toContain('Release checks');
        });
        expect(await readLayout()).toEqual(originalLayout);
        expect(approvalArtifacts()).toEqual([]);
        await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        expect(await command).toMatchObject({ kind: 'applied' });
        expect(await readLayout()).toMatchObject({ ok: true, result: { layout: { items: expect.arrayContaining([
            expect.objectContaining({ kind: 'group', title: 'Release checks', width: 'full', frameStyle: 'card', dividers: 'hairline',
                children: [expect.objectContaining({ kind: 'widget', instance: expect.objectContaining({ definition, bindings: {} }) })] }),
        ]) } } });
        expect(approvalArtifacts()).toEqual([]);
    } finally {
        controller.abort();
        await screen.unmount();
    }
});
