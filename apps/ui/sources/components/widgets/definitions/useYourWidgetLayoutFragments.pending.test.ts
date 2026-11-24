import { type WidgetLayoutFragmentGroupV1 } from '@happier-dev/protocol/widgets';
import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { Pressable, Text, View } = await import('react-native');
const { ModalProvider } = await import('@/modal/ModalProvider');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useYourWidgetLayoutFragments } = await import('./useYourWidgetLayoutFragments');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { storage } = await import('@/sync/domains/state/storage');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    standardCleanup();
    retirePresentationNotice();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
});

describe('saved-group management with explicit Ask on UI', () => {
    it.each(['rename', 'duplicate', 'delete'] as const)('holds %s for native confirmation, then settles the saved group', async intent => {
        const serverId = await homes.addHome({ name: 'Home A', serverUrl: 'https://fragments-pending.test', accountId: 'account-a' });
        const account = { serverId, accountId: 'account-a' };
        connection = await restoreServerAccountForTest({ serverUrl: 'https://fragments-pending.test', accountId: 'account-a', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        storage.setState({ profileScope: account, settingsScope: account });
        await homes.requireUiApproval(serverId, intent === 'rename' ? 'widgets.fragment.update'
            : intent === 'delete' ? 'widgets.fragment.delete' : 'widgets.fragment.duplicate');
        const executor = createDefaultActionExecutor();
        const context = { serverId, surface: 'ui', authority: 'present_user' } as const;
        const group = { width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget',
            instance: { v: 1, definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }] } satisfies WidgetLayoutFragmentGroupV1;
        expect(await executor.execute('widgets.fragment.create', { account, artifactId: 'saved', fragment: {
            name: 'Release checks', inputs: { fields: [] }, inputSchema: { type: 'object' }, group,
        } }, context)).toMatchObject({ ok: true });
        const artifacts = homes.artifacts(serverId);
        const original = artifacts.readPlainBody('saved');

        function SavedGroups() {
            const { fragments, actionsFor } = useYourWidgetLayoutFragments(account);
            return createElement(View, null, fragments.map(fragment => createElement(View, { key: fragment.artifactId },
                createElement(Text, { testID: `saved-group.${fragment.artifactId}` }, fragment.name),
                ...actionsFor(fragment).map(action => createElement(Pressable, {
                    key: action.id, testID: `saved-group.${fragment.artifactId}.${action.id}`, onPress: action.onPress,
                })),
            )));
        }

        const screen = await renderScreen(createElement(ModalProvider, null, createElement(SavedGroups)));
        try {
            await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('saved-group.saved')).not.toBeNull());
            await screen.pressByTestIdAsync(`saved-group.saved.${intent}`);
            if (intent === 'rename') {
                await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('web-prompt-input')).not.toBeNull());
                await act(async () => { screen.changeTextByTestId('web-prompt-input', 'Release room'); });
                await screen.pressByTestIdAsync('web-prompt-confirm');
            }
            await waitForTestEvent(screen.subscribe, () =>
                expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
            expect(screen.findByTestId('saved-group.saved')?.props.children).toBe(intent === 'rename' ? 'Release room' : 'Release checks');
            expect(artifacts.readPlainBody('saved')).toBe(original);
            expect(artifacts.list().map(row => row.id)).toEqual(['saved']);
            await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');

            const expectedName = intent === 'rename' ? 'Release room' : 'Release checks';
            await waitForTestEvent(screen.subscribe, () => {
                if (intent === 'delete') {
                    expect(screen.findByTestId('saved-group.saved')).toBeNull();
                } else {
                    expect(screen.findByTestId('saved-group.saved')?.props.children).toBe(expectedName);
                    if (intent === 'duplicate') expect(screen.getTextContent()).toContain('Release checks copy');
                }
            });
            if (intent === 'delete') {
                expect(await executor.execute('widgets.fragment.get', { account, artifactId: 'saved' }, context))
                    .toMatchObject({ ok: false, errorCode: 'widget_fragment_not_found' });
                expect(artifacts.list()).toEqual([]);
            } else {
                await waitForHomeGovernance(async () => {
                    expect(await executor.execute('widgets.fragment.get', { account, artifactId: 'saved' }, context))
                        .toMatchObject({ ok: true, result: { fragment: { id: 'saved', name: expectedName, group } } });
                });
                const ids = artifacts.list().map(row => row.id);
                expect(ids).toHaveLength(intent === 'duplicate' ? 2 : 1);
                if (intent === 'duplicate') {
                    expect(artifacts.readPlainBody('saved')).toBe(original);
                    const copyId = ids.find(id => id !== 'saved')!;
                    expect(await executor.execute('widgets.fragment.get', { account, artifactId: copyId }, context))
                        .toMatchObject({ ok: true, result: { fragment: { id: copyId, name: 'Release checks copy', group } } });
                }
            }
            expect(readPresentationNotice()).toBeNull();
        } finally { await screen.unmount(); }
    });
});
