import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { AgentActivityRowActionId } from '../agentActivityRowEntry';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const modalRef = vi.hoisted(() => ({ confirmed: true, calls: [] as unknown[][] }));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: unknown[]) => {
            modalRef.calls.push(args);
            return Promise.resolve(modalRef.confirmed);
        },
        alert: () => {},
    },
}));

type MenuAction = Readonly<{
    id: string;
    title: string;
    destructive?: boolean;
    onPress?: () => void;
}>;

async function renderOverflow(
    actions: readonly AgentActivityRowActionId[],
    onAction = vi.fn(),
) {
    const { AgentActivityRowOverflow } = await import('./AgentActivityRowOverflow');
    const screen = await renderScreen(
        <AgentActivityRowOverflow
            entryId="entry-1"
            title="Audit the reducer"
            actions={actions}
            onAction={onAction}
            testID="overflow"
        />,
    );
    return { screen, onAction };
}

function readMenu(screen: Awaited<ReturnType<typeof renderScreen>>): MenuAction[] | null {
    const matches = screen.tree.root.findAll((node) => {
        const nodeProps = node.props as Record<string, unknown> | undefined;
        return nodeProps != null && 'compactThreshold' in nodeProps && 'actions' in nodeProps;
    });
    if (matches.length === 0) return null;
    return matches[0].props.actions as MenuAction[];
}

/**
 * The row's only action affordance, and the one place a destructive agent action can be guarded.
 * A host that had to remember the confirmation itself would eventually not, and there are three
 * prospective hosts.
 */
describe('AgentActivityRowOverflow', () => {
    beforeEach(() => {
        modalRef.confirmed = true;
        modalRef.calls = [];
    });

    it('renders nothing at all when the entry declares no actions', async () => {
        const { screen } = await renderOverflow([]);

        // Defect A9 in miniature: an ellipsis that opens an empty sheet is a dead control.
        expect(screen.tree.toJSON()).toBeNull();
        await screen.unmount();
    });

    it('always presents a menu, never inline icons, however wide the window is', async () => {
        const { screen } = await renderOverflow(['open_full']);

        const rowActions = screen.tree.root.find((node) => {
            const nodeProps = node.props as Record<string, unknown> | undefined;
            return nodeProps != null && 'compactThreshold' in nodeProps && 'actions' in nodeProps;
        });
        expect(rowActions.props.compactThreshold).toBe(Number.POSITIVE_INFINITY);
        expect(rowActions.props.compactActionIds).toEqual([]);

        await screen.unmount();
    });

    it('reaches the 44pt touch target without a 44pt glyph', async () => {
        const { screen } = await renderOverflow(['open_full']);

        const trigger = screen.tree.root.find((node) => {
            const nodeProps = node.props as Record<string, unknown> | undefined;
            return nodeProps?.testID === 'overflow' && nodeProps?.hitSlop != null;
        });
        // 28pt box + 8pt slop on every side. The four icon buttons this replaces were 30x30 with
        // no slop at all.
        expect(trigger.props.size).toBe('sm');
        expect(trigger.props.hitSlop).toBe(8);

        await screen.unmount();
    });

    it('runs a recoverable action immediately, with danger styling but no dialog', async () => {
        const { screen, onAction } = await renderOverflow(['stop']);

        const stop = readMenu(screen)?.find((action) => action.id === 'stop');
        expect(stop?.destructive).toBe(true);
        stop?.onPress?.();
        await act(async () => { await Promise.resolve(); });

        // Stopping a run is the user's own stop and is recoverable by launching again.
        expect(modalRef.calls).toHaveLength(0);
        expect(onAction).toHaveBeenCalledWith('entry-1', 'stop');

        await screen.unmount();
    });

    it('confirms a delete before firing it', async () => {
        modalRef.confirmed = true;
        const { screen, onAction } = await renderOverflow(['delete']);

        readMenu(screen)?.find((action) => action.id === 'delete')?.onPress?.();
        expect(onAction).not.toHaveBeenCalled();
        await act(async () => { await Promise.resolve(); });

        expect(modalRef.calls).toHaveLength(1);
        expect(String(modalRef.calls[0][1])).toContain('Audit the reducer');
        expect(onAction).toHaveBeenCalledWith('entry-1', 'delete');

        await screen.unmount();
    });

    it('does not delete when the confirmation is declined', async () => {
        modalRef.confirmed = false;
        const { screen, onAction } = await renderOverflow(['delete']);

        readMenu(screen)?.find((action) => action.id === 'delete')?.onPress?.();
        await act(async () => { await Promise.resolve(); });

        expect(modalRef.calls).toHaveLength(1);
        expect(onAction).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('labels every action, so no menu row renders a raw id', async () => {
        const { screen } = await renderOverflow(['open_full', 'open_advanced', 'send', 'stop', 'delete']);

        const menu = readMenu(screen) ?? [];
        expect(menu).toHaveLength(5);
        for (const action of menu) {
            expect(action.title.trim().length).toBeGreaterThan(0);
            expect(action.title).not.toBe(action.id);
        }
        expect(new Set(menu.map((action) => action.title)).size).toBe(menu.length);

        await screen.unmount();
    });
});
