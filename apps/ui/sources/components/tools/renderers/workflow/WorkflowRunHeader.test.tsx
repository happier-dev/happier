import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import type { SessionWorkflowRunStatusV1 } from '@happier-dev/protocol';

import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks();

// Capture what WorkflowRunHeader passes to the shared MeterBar (call-site contract).
vi.mock('@/components/ui/lists/MeterBar', () => ({
    MeterBar: (props: Record<string, unknown> & { caption?: React.ReactNode }) =>
        React.createElement('MeterBarMock', props, props.caption ?? null),
}));

function makeRollup(over: Partial<WorkflowPhaseRollup> = {}): WorkflowPhaseRollup {
    return {
        total: 5,
        complete: 2,
        failed: 0,
        blocked: 0,
        active: 3,
        pending: 0,
        cancelled: 0,
        unknown: 0,
        ...over,
    };
}

async function render(props: Partial<React.ComponentProps<typeof import('./WorkflowRunHeader').WorkflowRunHeader>>) {
    const { WorkflowRunHeader } = await import('./WorkflowRunHeader');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
            <WorkflowRunHeader
                title="Implement"
                status="active"
                statusLabel="Active"
                completedAgents={2}
                totalAgents={5}
                rollup={makeRollup()}
                {...props}
            />,
        );
    });
    return { tree: tree as renderer.ReactTestRenderer };
}

describe('WorkflowRunHeader', () => {
    it('passes the progress fraction as MeterBar fillFraction (grows with completion — contract-true, not inverted)', async () => {
        const { tree } = await render({ completedAgents: 2, totalAgents: 5 });
        const meter = tree.root.findByType('MeterBarMock' as unknown as React.ComponentType);
        // 2 of 5 agents complete => fill 0.4 (consumed/progress), NOT 0.6 remaining.
        expect(meter.props.fillFraction).toBeCloseTo(0.4, 5);
        act(() => tree.unmount());
    });

    it('renders no meter when there are no agents', async () => {
        const { tree } = await render({ completedAgents: 0, totalAgents: 0, rollup: makeRollup({ total: 0, active: 0, complete: 0 }) });
        expect(() => tree.root.findByType('MeterBarMock' as unknown as React.ComponentType)).toThrow();
        act(() => tree.unmount());
    });

    /**
     * Migrated from the deleted `workflowStatusIcon` glyph test. The mapping it guarded still
     * matters — a reader must tell a queued run from a done one from a failed one at 14px — but the
     * owner moved: the glyph table now lives in the shared `AgentActivityStatusSlot` and the run
     * status reaches it through the protocol adapter. These cases pin the wiring, not a second
     * table, so a header that grew its own switch would fail here.
     */
    describe('status mark (through the shared slot)', () => {
        async function glyphFor(status: SessionWorkflowRunStatusV1): Promise<string | null> {
            const { tree } = await render({ status });
            const icons = tree.root.findAll(
                (node) => typeof (node.props as { name?: unknown })?.name === 'string' && node.props.size != null,
            );
            // `graph` is the header's own workflow mark, not the status mark.
            const statusIcon = icons.find((node) => (node.props as { name: string }).name !== 'graph');
            const name = statusIcon ? (statusIcon.props as { name: string }).name : null;
            act(() => tree.unmount());
            return name;
        }

        it('keeps terminal outcomes visually distinct', async () => {
            expect(await glyphFor('complete')).toBe('check-circle');
            expect(await glyphFor('failed')).toBe('x-circle');
            expect(await glyphFor('cancelled')).toBe('stop-circle');
            // A run the CLI reconciled after its process died is a stop, not a failure, so it must
            // not paint danger.
            expect(await glyphFor('stopped')).toBe('stop-circle');
        });

        it('renders the app spinner, not a static glyph, while a run is active', async () => {
            const { tree } = await render({ status: 'active' });
            expect(tree.root.findAll((node) => node.props?.accessibilityRole === 'progressbar')).toHaveLength(1);
            act(() => tree.unmount());
        });

        it('separates a dependency block from something that needs a person', async () => {
            // A workflow block waits on a phase dependency. `warning-circle` is reserved for the one
            // status that escalates to a human, so this must not reuse it.
            expect(await glyphFor('blocked')).toBe('pause-circle');
        });
    });

    it('silences the ticking summary caption from live-region announcements', async () => {
        const { tree } = await render({ summaryLine: 'Phase 2 of 3 · 3/5 agents' });
        const announced = tree.root.findAll(
            (node) => node.props?.accessibilityLiveRegion != null && node.props.accessibilityLiveRegion !== 'none',
        );
        expect(announced).toHaveLength(0);
        act(() => tree.unmount());
    });
});
