import { buildAgentActivityEntryId } from '@happier-dev/protocol';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { WorkflowAgentRowViewModel } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import { AGENT_ROW_MIN_HEIGHT_PX } from '@/components/sessions/agentActivity/row/agentRowMetrics';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

function agent(over: Partial<WorkflowAgentRowViewModel> = {}): WorkflowAgentRowViewModel {
    return {
        // Spelled by the protocol owner, as the real row model spells it.
        rowId: buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'wf_1', agentId: 'a1' }),
        runId: 'wf_1',
        agentId: 'a1',
        title: 'researcher',
        status: 'complete',
        ...over,
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => ({ ...accumulator, ...flattenStyle(entry) }),
            {},
        );
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

async function renderRow(over: Partial<WorkflowAgentRowViewModel> = {}) {
    const { WorkflowAgentActivityRow } = await import('./WorkflowAgentActivityRow');
    return renderScreen(
        <WorkflowAgentActivityRow agent={agent(over)} testID="agent-row" />,
    );
}

describe('WorkflowAgentActivityRow geometry', () => {
    /**
     * The regression this whole migration had to avoid: swapping a 32pt bespoke row for a settings
     * list row would grow a six-agent transcript card from ~192 to ~312px and a 24-row popover
     * panel from ~768 to ~1248px. The height is asserted against the shared constant rather than a
     * literal so the row and its hosts cannot disagree about it.
     */
    it('keeps the dense read-only row height instead of taking a touch-target list height', async () => {
        const screen = await renderRow();
        const rowProps = screen.tree.root.findAll((node) => {
            const nodeProps = node.props as Record<string, unknown> | undefined;
            return nodeProps != null && 'showChevron' in nodeProps && 'iconBoxSize' in nodeProps;
        })[0].props as Record<string, unknown>;

        expect(flattenStyle(rowProps.style).minHeight).toBe(AGENT_ROW_MIN_HEIGHT_PX.readOnly);
        act(() => screen.tree.unmount());
    });

    /**
     * The row reserves its own horizontal padding because it is a list row; the hosts already pad
     * their card and panel. Reading BOTH numbers off the rendered tree is what makes this a drift
     * guard rather than a restatement: if the item row's compact padding ever changes without
     * `ITEM_ROW_PADDING_HORIZONTAL` following it, the leading status glyph silently stops lining up
     * with the run header above it and this fails.
     */
    it('cancels its own row padding so the status column lands on the host content edge', async () => {
        const screen = await renderRow();

        const rowContainers = screen.tree.root.findAll((node) => {
            const style = flattenStyle((node.props as { style?: unknown } | undefined)?.style);
            return style.flexDirection === 'row' && typeof style.paddingHorizontal === 'number';
        });
        expect(rowContainers.length).toBeGreaterThan(0);
        const paddingHorizontal = flattenStyle(rowContainers[0].props.style).paddingHorizontal as number;

        const bleedContainers = screen.tree.root.findAll((node) => {
            const style = flattenStyle((node.props as { style?: unknown } | undefined)?.style);
            return typeof style.marginHorizontal === 'number';
        });
        expect(bleedContainers).toHaveLength(1);
        const marginHorizontal = flattenStyle(bleedContainers[0].props.style).marginHorizontal as number;

        expect(paddingHorizontal).toBeGreaterThan(0);
        expect(paddingHorizontal + marginHorizontal).toBe(0);
        act(() => screen.tree.unmount());
    });

    it('discloses the provider summary below the row rather than widening it', async () => {
        const screen = await renderRow({ summary: 'Found the leak in the reducer.' });

        const rowProps = screen.tree.root.findAll((node) => {
            const nodeProps = node.props as Record<string, unknown> | undefined;
            return nodeProps != null && 'showChevron' in nodeProps && 'iconBoxSize' in nodeProps;
        })[0].props as Record<string, unknown>;

        // The summary is never inlined into the row's own two lines.
        expect(rowProps.subtitle).toBeNull();
        expect(rowProps.detail).toBeUndefined();
        expect((rowProps.accessibilityState as Record<string, unknown>).expanded).toBe(false);
        expect(screen.tree.root.findAllByProps({ testID: 'agent-row-detail' })).toHaveLength(0);

        act(() => screen.tree.unmount());
    });
});
