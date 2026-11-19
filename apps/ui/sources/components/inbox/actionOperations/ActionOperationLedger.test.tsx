import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { chooseDropdownMenuItem } from '@/dev/testkit/harness/dropdownMenuHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { ActionOperationLedgerView, ActionOperationRows } from './ActionOperationLedger';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroupRowPositionProvider } from '@/components/ui/lists/ItemGroupRowPosition';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';

const initialState = storage.getState();
let homeA = '';
let homeB = '';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
beforeEach(async () => {
    storage.setState(initialState, true);
    homeA = (await upsertServerProfile({ serverUrl: 'https://ledger-a.example.test', name: 'Home A' })).id;
    homeB = (await upsertServerProfile({ serverUrl: 'https://ledger-b.example.test', name: 'Home B' })).id;
});

afterEach(async () => {
    await standardCleanup();
    storage.setState(initialState, true);
    await removeServerProfile(homeA);
    await removeServerProfile(homeB);
});

describe('ActionOperationLedgerView', () => {
    it('surfaces the retained setup review and opens the held operation from Review', async () => {
        const snapshot = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: 'team-source-setup', revision: 1,
            actionId: 'projects.prepare', state: 'accepted', scope: { accountId: 'account', machineId: 'machine' },
            title: 'Set up a project', createdAt: 1, cancellation: 'supported',
            progress: { kind: 'phase', phase: 'setup', label: 'Preparing project' },
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: homeA,
                machineId: 'machine', workspaceRefId: 'checkout', cwd: '/tmp/team-source',
                sourceWorkspace: { serverId: homeA, machineId: 'machine', workspaceId: 'checkout', rootPath: '/tmp/team-source' } },
            setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required',
                reviewedEffectDigest: 'reviewed', reviewedEffect: {} },
        });
        const operation = { serverId: homeA, snapshot, observation: 'available' as const, isUnavailableProjection: false };
        const onOpenOperation = vi.fn();
        const screen = await renderScreen(<ActionOperationLedgerView operations={[operation]} onOpenOperation={onOpenOperation} />);

        expect(screen.findByTestId('inbox.section.operations.needsAttention')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Needs you');
        await screen.pressByTestIdAsync('action-operation-review.team-source-setup');
        expect(onOpenOperation).toHaveBeenCalledWith(operation);
    });

    it('offers explicit dismissal for terminal failures in Activity as well as Inbox', async () => {
        const onDismiss = vi.fn();
        const failed = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'failed', revision: 1,
            actionId: 'session.spawn_new', state: 'failed', scope: { accountId: 'account', machineId: 'machine' },
            title: 'Create session', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'unsupported',
            error: { errorCode: 'internal_error', error: 'Workspace is read-only' } });
        const screen = await renderScreen(<ActionOperationRows operations={[{
            serverId: homeA, snapshot: failed, observation: 'available', isUnavailableProjection: false,
        }]} onOpenOperation={() => {}} onDismissOperation={onDismiss} />);
        expect(screen.getTextContent()).toContain('Workspace is read-only');
        expect(screen.findByTestId('action-operation-dismiss.failed')).not.toBeNull();
        await screen.pressByTestIdAsync('action-operation-dismiss.failed');
        expect(onDismiss.mock.calls[0]?.[0].snapshot).toEqual(failed);
    });


    it('names the execution worker when operation custody stays on the Source Machine', async () => {
        const machines = [
            createMachineFixture({ id: 'source', metadata: { ...createMachineFixture().metadata!, host: 'Source computer' } }),
            createMachineFixture({ id: 'worker', metadata: { ...createMachineFixture().metadata!, host: 'Build worker' } }),
        ];
        storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [homeA]: machines }, machineListStatusByServerId: { [homeA]: 'idle' } });
        const snapshot = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: 'worker-operation', revision: 1, actionId: 'projects.script.run',
            state: 'accepted', scope: { accountId: 'account', machineId: 'source' },
            title: 'Build', createdAt: 1, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: homeA,
                machineId: 'worker', workspaceRefId: 'worker-checkout', cwd: '/worker/repo' },
        });
        const screen = await renderScreen(<ActionOperationRows operations={[{
            serverId: homeA, snapshot, observation: 'available', isUnavailableProjection: false,
        }]} presentation="inbox" onOpenOperation={() => {}} />);
        expect(screen.getTextContent()).toContain('Build worker');
        expect(screen.getTextContent()).not.toContain('Source computer');
    });

    it('distributes a parent ItemGroup row across every rendered operation row', async () => {
        const operation = {
            serverId: 'server-1',
            snapshot: {
                version: 1 as const,
                operationId: 'operation-1',
                revision: 1,
                actionId: 'session.fork',
                state: 'running' as const,
                scope: { accountId: 'account-1', machineId: 'machine-1' },
                title: 'Fork session',
                createdAt: 100,
                cancellation: 'unsupported' as const,
            },
            observation: 'available' as const,
            isUnavailableProjection: false,
        };
        const screen = await renderScreen(
            <ItemGroupRowPositionProvider value={{ isFirst: true, isLast: true }}>
                <ActionOperationRows
                    operations={[operation, {
                        ...operation,
                        snapshot: { ...operation.snapshot, operationId: 'operation-2' },
                    }]}
                    onOpenOperation={vi.fn()}
                    showDivider={false}
                />
            </ItemGroupRowPositionProvider>,
        );

        expect(screen.findAllByType(Item).map((node) => node.props.showDivider)).toEqual([true, false]);
        expect(screen.findAllByType(ItemGroupRowPositionProvider).map((node) => node.props.value)).toEqual([
            { isFirst: true, isLast: true },
            { isFirst: true, isLast: false },
            { isFirst: false, isLast: true },
        ]);
    });

    it('does not invent Home-wide freshness for a Session-scoped operation', async () => {
        const screen = await renderScreen(
            <ActionOperationRows
                operations={[{
                    serverId: homeB,
                    snapshot: {
                        version: 1,
                        operationId: 'operation-offline',
                        revision: 1,
                        actionId: 'session.fork',
                        state: 'running',
                        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
                        title: 'Fork session',
                        createdAt: 100,
                        cancellation: 'unsupported',
                    },
                    observation: 'available',
                    isUnavailableProjection: false,
                }]}
                onOpenOperation={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).toContain('Home B');
        expect(screen.getTextContent()).not.toContain('Offline');
    });
    it('renders Inbox status inline and resolves from a separate control without opening detail', async () => {
        const onOpenOperation = vi.fn();
        const onDismissOperation = vi.fn();
        const operation = {
            serverId: 'server-1',
            snapshot: {
                version: 1 as const,
                operationId: 'operation-inbox-failed',
                revision: 2,
                actionId: 'session.spawn_new',
                state: 'failed' as const,
                scope: { accountId: 'account-1', machineId: 'machine-1' },
                title: 'Create session',
                createdAt: 100,
                settledAt: 120,
                cancellation: 'unsupported' as const,
                error: { errorCode: 'failed', error: 'Workspace is read-only' },
            },
            observation: 'available' as const,
            isUnavailableProjection: false,
        };
        const screen = await renderScreen(
            <ActionOperationRows
                operations={[operation]}
                presentation="inbox"
                onOpenOperation={onOpenOperation}
                onDismissOperation={onDismissOperation}
            />,
        );

        expect(screen.getTextContent()).toContain('Failed');
        expect(screen.getTextContent()).toContain('Workspace is read-only');
        expect(screen.findHostByTestId('inbox.action-operation.operation-inbox-failed')).not.toBeNull();
        // In the Inbox the row's one trailing control is its … menu; Dismiss is in it.
        await chooseDropdownMenuItem(screen, 'action-operation-dismiss.operation-inbox-failed', 'inbox.dismiss');
        expect(onDismissOperation).toHaveBeenCalledWith(operation);
        expect(onOpenOperation).not.toHaveBeenCalled();
    });
    it('drops the state column on a narrow Inbox row, as every other Inbox row does (phone row rule)', async () => {
        // QA-SHELL-1114 F11: at 320 "Failed" sat beside the title and cut it to "Instantiate deplo…". On a phone the
        // row's mark says it failed and its title keeps the line; the Inbox owner's narrow mode decides that once.
        const operation = {
            serverId: 'server-1',
            snapshot: { version: 1 as const, operationId: 'operation-inbox-narrow', revision: 2, actionId: 'session.spawn_new',
                state: 'failed' as const, scope: { accountId: 'account-1', machineId: 'machine-1' }, title: 'Create session',
                createdAt: 100, settledAt: 120, cancellation: 'unsupported' as const, error: { errorCode: 'failed', error: 'Failed' } },
            observation: 'available' as const,
            isUnavailableProjection: false,
        };
        const screen = await renderScreen(<ActionOperationRows operations={[operation]} presentation="inbox" narrow
            onOpenOperation={() => {}} onDismissOperation={() => {}} />);
        const summary = screen.findAll((node) => node.props.testID === 'inbox.action-operation.operation-inbox-narrow.summary'
            && 'trailingState' in node.props)[0];
        expect(summary).toBeDefined();
        expect(summary!.props.trailingState).toBeNull();
    });

    it('offers a restrained bulk clear only for successful recent rows', async () => {
        const onClearRecent = vi.fn();
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[{
                    serverId: 'server-1',
                    snapshot: {
                        version: 1,
                        operationId: 'operation-success',
                        revision: 2,
                        actionId: 'session.spawn_new',
                        state: 'succeeded',
                        scope: { accountId: 'account-1', machineId: 'machine-1' },
                        title: 'Create session',
                        createdAt: 100,
                        startedAt: 110,
                        settledAt: 120,
                        cancellation: 'unsupported',
                    },
                    observation: 'available',
                    isUnavailableProjection: false,
                }]}
                onOpenOperation={vi.fn()}
                onClearRecent={onClearRecent}
            />,
        );

        await screen.pressByTestIdAsync('action-operations-clear-recent');
        expect(onClearRecent).toHaveBeenCalledTimes(1);
    });

    it('moves unavailable active work to attention with Dismiss, no Stop, and status only in accessibility', async () => {
        const onOpenOperation = vi.fn();
        const onCancelOperation = vi.fn();
        const onDismissOperation = vi.fn();
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[{
                    serverId: 'server-1',
                    snapshot: {
                        version: 1,
                        operationId: 'operation-unavailable',
                        revision: 2,
                        actionId: 'session.fork',
                        state: 'running',
                        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
                        title: 'Fork session',
                        createdAt: 100,
                        startedAt: 120,
                        cancellation: 'supported',
                    },
                    observation: 'unavailable',
                    isUnavailableProjection: true,
                }]}
                onOpenOperation={onOpenOperation}
                onCancelOperation={onCancelOperation}
                onDismissOperation={onDismissOperation}
            />,
        );

        expect(screen.findByTestId('inbox.section.operations.needsAttention')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Status unavailable');
        expect(screen.findByTestId('action-operation-stop.operation-unavailable')).toBeNull();
        expect(screen.findByTestId('action-operation-dismiss.operation-unavailable')).not.toBeNull();
        expect(screen.findByTestId('inbox.action-operation.operation-unavailable')?.props.accessibilityLabel)
            .toContain('Status unavailable');

        await screen.pressByTestIdAsync('action-operation-dismiss.operation-unavailable');
        expect(onDismissOperation).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-1',
            snapshot: expect.objectContaining({ operationId: 'operation-unavailable' }),
        }));
        expect(onCancelOperation).not.toHaveBeenCalled();
        expect(onOpenOperation).not.toHaveBeenCalled();
    });

    it('keeps terminal and reconnecting status words out of visible ledger copy', async () => {
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[
                    {
                        serverId: 'server-1',
                        snapshot: {
                            version: 1,
                            operationId: 'operation-success',
                            revision: 2,
                            actionId: 'session.spawn_new',
                            state: 'succeeded',
                            scope: { accountId: 'account-1', machineId: 'machine-1' },
                            title: 'Create session',
                            createdAt: 100,
                            settledAt: 120,
                            cancellation: 'unsupported',
                        },
                        observation: 'available',
                        isUnavailableProjection: false,
                    },
                    {
                        serverId: 'server-1',
                        snapshot: {
                            version: 1,
                            operationId: 'operation-reconnecting',
                            revision: 1,
                            actionId: 'session.fork',
                            state: 'running',
                            scope: { accountId: 'account-1', machineId: 'machine-2' },
                            title: 'Fork session',
                            createdAt: 100,
                            cancellation: 'unsupported',
                        },
                        observation: 'reconnecting',
                        isUnavailableProjection: false,
                    },
                ]}
                onOpenOperation={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).not.toContain('Completed');
        expect(screen.getTextContent()).not.toContain('Reconnecting');
        expect(screen.findByTestId('inbox.action-operation.operation-success')?.props.accessibilityLabel)
            .toContain('Completed');
        expect(screen.findByTestId('inbox.action-operation.operation-reconnecting')?.props.accessibilityLabel)
            .toContain('Reconnecting');
    });

    it('shows only the source session title for a session-scoped operation', async () => {
        const machine = createMachineFixture({
            id: 'machine-1',
            metadata: { ...createMachineFixture().metadata!, displayName: 'Wrong machine fallback' },
        });
        const session = createSessionFixture({
            id: 'session-1',
            serverId: homeB,
            encryptionMode: 'plain',
            active: true,
            metadata: {
                ...createSessionFixture().metadata!,
                path: '/workspace/dev',
                summary: { text: 'Stabilize CI and Nightly Releases', updatedAt: 123 },
            },
        });
        storage.setState({ machineListByServerId: { [homeB]: [machine] },
            sessionListRowsByServerId: { [homeB]: { [session.id]: buildSessionListRenderableFromSession(session) } } });
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[{
                    serverId: homeB,
                    snapshot: {
                        version: 1,
                        operationId: 'operation-session-title',
                        revision: 2,
                        actionId: 'session.fork',
                        state: 'succeeded',
                        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
                        title: 'Fork session',
                        createdAt: 100,
                        settledAt: 120,
                        cancellation: 'unsupported',
                    },
                    observation: 'available',
                    isUnavailableProjection: false,
                }]}
                onOpenOperation={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).toContain('Stabilize CI and Nightly Releases');
        expect(screen.getTextContent()).not.toContain('Wrong machine fallback');
    });

    it('keeps same-ID Sessions on two Homes distinct and prefers only the exact address', async () => {
        const alpha = createSessionFixture({
            id: 'shared-session',
            serverId: homeA,
            encryptionMode: 'plain',
            active: true,
            metadata: { ...createSessionFixture().metadata!, summary: { text: 'Alpha Session', updatedAt: 123 } },
        });
        const beta = createSessionFixture({
            id: 'shared-session',
            serverId: homeB,
            encryptionMode: 'plain',
            active: true,
            metadata: { ...createSessionFixture().metadata!, summary: { text: 'Beta Session', updatedAt: 123 } },
        });
        storage.setState({ sessionListRowsByServerId: {
            [homeA]: { [alpha.id]: buildSessionListRenderableFromSession(alpha) },
            [homeB]: { [beta.id]: buildSessionListRenderableFromSession(beta) },
        } });
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[
                    {
                        serverId: homeB,
                        snapshot: {
                            version: 1,
                            operationId: 'operation-b',
                            revision: 1,
                            actionId: 'session.fork',
                            state: 'running',
                            scope: { accountId: 'account-b', machineId: 'machine-1', sessionId: 'shared-session' },
                            title: 'Home B operation',
                            createdAt: 200,
                            startedAt: 210,
                            cancellation: 'unsupported',
                        },
                        observation: 'available',
                        isUnavailableProjection: false,
                    },
                    {
                        serverId: homeA,
                        snapshot: {
                            version: 1,
                            operationId: 'operation-a',
                            revision: 1,
                            actionId: 'session.fork',
                            state: 'running',
                            scope: { accountId: 'account-a', machineId: 'machine-1', sessionId: 'shared-session' },
                            title: 'Home A operation',
                            createdAt: 100,
                            startedAt: 110,
                            cancellation: 'unsupported',
                        },
                        observation: 'available',
                        isUnavailableProjection: false,
                    },
                ]}
                preferredSessionAddress={{ serverId: homeA, sessionId: 'shared-session' }}
                onOpenOperation={vi.fn()}
            />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('Alpha Session');
        expect(text).toContain('Home A');
        expect(text).toContain('Beta Session');
        expect(text).toContain('Home B');
        expect(text.indexOf('Home A operation')).toBeLessThan(text.indexOf('Home B operation'));
    });
});

