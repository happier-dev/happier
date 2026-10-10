import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { ActionOperationLedgerView, ActionOperationRows } from './ActionOperationLedger';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroupRowPositionProvider } from '@/components/ui/lists/ItemGroupRowPosition';

const storageFixtures = vi.hoisted(() => ({
    machines: new Map<string, Record<string, unknown>>(),
    sessions: new Map<string, Record<string, unknown>>(),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useServerScopedMachine: (serverId: string | null, machineId: string) => (
            storageFixtures.machines.get(JSON.stringify([serverId, machineId])) ?? null
        ),
        useSessionListRenderableWithServerScope: (serverId: string | null, sessionId: string) => (
            storageFixtures.sessions.get(JSON.stringify([serverId, sessionId])) ?? null
        ),
    });
});
vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => 0,
}));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getServerProfileById: (serverId: string) => ({ id: serverId, name: serverId === 'home-a' ? 'Home A' : 'Home B' }),
}));
vi.mock('@/hooks/teams/useSessionAudienceContext', () => ({
    useSessionAudienceContext: () => ({
        scopes: new Map(),
        labelsVersion: '[]',
        labelsBySessionKey: new Map(),
    }),
}));

afterEach(async () => {
    storageFixtures.machines.clear();
    storageFixtures.sessions.clear();
    await standardCleanup();
});

describe('ActionOperationLedgerView', () => {
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
                    serverId: 'server-1',
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
                error: { errorCode: 'failed', error: 'Failed' },
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
        expect(screen.findHostByTestId('inbox.action-operation.operation-inbox-failed')).not.toBeNull();
        await screen.pressByTestIdAsync('action-operation-dismiss.operation-inbox-failed');
        expect(onDismissOperation).toHaveBeenCalledWith(operation);
        expect(onOpenOperation).not.toHaveBeenCalled();
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
        storageFixtures.machines.set(JSON.stringify(['server-1', 'machine-1']), {
            id: 'machine-1',
            metadata: { displayName: 'Wrong machine fallback' },
        });
        storageFixtures.sessions.set(JSON.stringify(['server-1', 'session-1']), {
            id: 'session-1',
            encryptionMode: 'plain',
            active: true,
            metadata: {
                path: '/workspace/dev',
                summary: { text: 'Stabilize CI and Nightly Releases', updatedAt: 123 },
            },
        });
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[{
                    serverId: 'server-1',
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
        storageFixtures.sessions.set(JSON.stringify(['home-a', 'shared-session']), {
            id: 'shared-session',
            encryptionMode: 'plain',
            active: true,
            metadata: { summary: { text: 'Alpha Session', updatedAt: 123 } },
        });
        storageFixtures.sessions.set(JSON.stringify(['home-b', 'shared-session']), {
            id: 'shared-session',
            encryptionMode: 'plain',
            active: true,
            metadata: { summary: { text: 'Beta Session', updatedAt: 123 } },
        });
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[
                    {
                        serverId: 'home-b',
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
                        serverId: 'home-a',
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
                preferredSessionAddress={{ serverId: 'home-a', sessionId: 'shared-session' }}
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
