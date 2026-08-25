import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstrumentStripModel } from './useInstrumentStripModel';

/** Reactive model store: pushing simulates a token_count tick reaching the strip. */
const modelStore = vi.hoisted(() => {
    const state = {
        current: { context: null, git: null, refreshContextUsage: () => {} } as InstrumentStripModel,
    };
    const listeners = new Set<() => void>();
    return {
        state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        push(next: InstrumentStripModel) {
            state.current = next;
            listeners.forEach((listener) => listener());
        },
    };
});

const motionState = vi.hoisted(() => ({
    contextGaugeStyle: 'gauge' as 'gauge' | 'text' | 'hidden',
}));

vi.mock('./useInstrumentStripModel', () => ({
    useInstrumentStripModel: () => React.useSyncExternalStore(modelStore.subscribe, () => modelStore.state.current),
}));

vi.mock('@/components/instrument', () => ({
    useMotionPreferences: () => ({
        level: 'subtle',
        contextGaugeStyle: motionState.contextGaugeStyle,
        entrance: { kind: 'crossfade', durationMs: 150 },
        reduceMotion: false,
    }),
    INSTRUMENT_DURATIONS: { entrance: 360 },
    staggerDelayForIndex: (index: number) => Math.min(index, 7) * 50,
}));

vi.mock('./ContextGaugeInstrument', () => ({
    ContextGaugeInstrument: (props: { model: { usedPct: number }; showPercentText: boolean }) =>
        React.createElement('ContextGaugeInstrument', {
            testID: 'ctx',
            'data-pct': props.model.usedPct,
            'data-percent-text': props.showPercentText,
        }),
}));
vi.mock('./QuotaRingInstrument', () => ({
    QuotaRingInstrument: (props: { showProviderGlyph: boolean }) =>
        React.createElement('QuotaRingInstrument', { testID: 'quota', 'data-glyph': props.showProviderGlyph }),
}));
vi.mock('./GitDeltaInstrument', () => ({
    GitDeltaInstrument: (props: { compact: boolean }) =>
        React.createElement('GitDeltaInstrument', { testID: 'git', 'data-compact': props.compact }),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: (props: Record<string, unknown>) => React.createElement('StatusDot', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));
vi.mock('../status/AgentInputStatusBadge', () => ({
    AgentInputStatusBadge: (props: Record<string, unknown>) => React.createElement('AgentInputStatusBadge', props),
}));
vi.mock('../components/AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: { open: boolean; content: React.ReactNode }) =>
        props.open ? React.createElement('Popover', { testID: 'overflow-popover' }, props.content as React.ReactNode) : null,
}));
vi.mock('../contextWarning', () => ({
    getContextWarning: () => ({ text: '12% left', color: '#f00' }),
}));
vi.mock('../resolveContextWarningWindowTokens', () => ({
    resolveContextWarningWindowTokens: () => 200_000,
}));
vi.mock('@/sync/domains/state/storage', () => ({ useSetting: () => false }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { SessionInstrumentStrip } from './SessionInstrumentStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTEXT_MODEL = {
    usedPct: 25, usedTokens: 50_000, windowTokens: 200_000, baselineTokens: null,
    totalProcessedTokens: null, isAutoCompactEnabled: null, categories: null,
    source: 'provider_turn' as const, stale: false,
};

function modelWith(overrides: Partial<InstrumentStripModel>): InstrumentStripModel {
    return { context: null, git: null, refreshContextUsage: () => {}, ...overrides };
}

function layout(tree: ReactTestRenderer, width: number) {
    const root = tree.root.findAll((n) => typeof n.type === 'string' && typeof n.props?.onLayout === 'function')[0];
    act(() => root!.props.onLayout({ nativeEvent: { layout: { width, height: 28 } } }));
}

describe('SessionInstrumentStrip', () => {
    let tree: ReactTestRenderer | null = null;

    beforeEach(() => {
        modelStore.state.current = modelWith({});
        motionState.contextGaugeStyle = 'gauge';
    });
    afterEach(() => {
        act(() => tree?.unmount());
        tree = null;
    });

    it('renders the context gauge when the model has context data', () => {
        modelStore.state.current = modelWith({ context: CONTEXT_MODEL });
        act(() => { tree = create(<SessionInstrumentStrip sessionId="s1" agentId={'claude' as never} />); });
        layout(tree!, 420);
        expect(tree!.root.findAll((n) => n.props?.testID === 'ctx')).toHaveLength(1);
    });

    it('renders a host trailing action even when the strip has no other status content', () => {
        act(() => {
            tree = create(
                <SessionInstrumentStrip
                    statusTrailingActions={React.createElement('HostStatusAction', { testID: 'host-status-action' })}
                />,
            );
        });

        expect(tree!.root.findAll((n) => n.props?.testID === 'host-status-action')).toHaveLength(1);
    });

    it('re-renders on usage ticks via its OWN store subscription (no parent props involved)', () => {
        // The real F-UI-11 ship-gate proof (usage tick does NOT re-render the REAL
        // AgentInput) lives in AgentInput.instrumentStripPerf.test.tsx. This case
        // pins the strip half: ticks arrive through the strip's own subscription
        // and re-render it with fresh values.
        let stripUpdates = 0;
        act(() => {
            tree = create(
                <React.Profiler id="strip" onRender={(_id, phase) => { if (phase === 'update') stripUpdates += 1; }}>
                    <SessionInstrumentStrip sessionId="s1" agentId={'claude' as never} />
                </React.Profiler>,
            );
        });

        // Simulate token ticks pushing new context values into the store.
        act(() => modelStore.push(modelWith({ context: { ...CONTEXT_MODEL, usedPct: 40 } })));
        act(() => modelStore.push(modelWith({ context: { ...CONTEXT_MODEL, usedPct: 60 } })));

        expect(stripUpdates).toBeGreaterThanOrEqual(2); // strip re-rendered on each tick
        const ctx = tree!.root.findAll((n) => n.props?.testID === 'ctx')[0];
        expect(ctx!.props['data-pct']).toBe(60);
    });

    it('shows the git instrument whenever the session is a repo, even with zero changes (T3.1 gate)', () => {
        modelStore.state.current = modelWith({
            git: {
                branch: 'main', upstream: null, ahead: 0, behind: 0,
                changedFiles: 0, linesAdded: 0, linesRemoved: 0,
                hasLineChanges: false, hasAnyChanges: false,
            },
        });
        act(() => { tree = create(<SessionInstrumentStrip sessionId="s1" agentId={'claude' as never} />); });
        layout(tree!, 420);
        expect(tree!.root.findAll((n) => n.props?.testID === 'git')).toHaveLength(1);
    });

    it('collapses instruments behind a "•••" chip below 300px but keeps permission inline', () => {
        modelStore.state.current = modelWith({ context: CONTEXT_MODEL });
        act(() => {
            tree = create(
                <SessionInstrumentStrip
                    sessionId="s1"
                    agentId={'claude' as never}
                    permission={{ label: 'plan', color: '#0f0' }}
                />,
            );
        });
        layout(tree!, 280);
        expect(tree!.root.findAll((n) => n.props?.testID === 'session-instrument-overflow-chip')).toHaveLength(1);
        // The context gauge is NOT inline (collapsed); permission label still present.
        expect(tree!.root.findAll((n) => n.props?.testID === 'ctx')).toHaveLength(0);
        const texts = tree!.root.findAll((n) => String(n.type) === 'Text');
        expect(texts.some((n) => collect(n).includes('plan'))).toBe(true);
    });

    it('renders FULL-SIZE instruments inside the overflow popover (not the compact variants)', () => {
        modelStore.state.current = modelWith({ context: CONTEXT_MODEL });
        act(() => { tree = create(<SessionInstrumentStrip sessionId="s1" agentId={'claude' as never} />); });
        layout(tree!, 280);
        const chip = tree!.root.findAll((n) => n.props?.testID === 'session-instrument-overflow-chip')[0];
        act(() => chip!.props.onPress());
        // Popover open → the gauge inside it must be the full-size variant (% text kept).
        const ctx = tree!.root.findAll((n) => n.props?.testID === 'ctx')[0];
        expect(ctx).toBeTruthy();
        expect(ctx!.props['data-percent-text']).toBe(true);
    });

    it('drops the percent text (compact) between 300 and 360px', () => {
        modelStore.state.current = modelWith({ context: CONTEXT_MODEL });
        act(() => { tree = create(<SessionInstrumentStrip sessionId="s1" agentId={'claude' as never} />); });
        layout(tree!, 340);
        const ctx = tree!.root.findAll((n) => n.props?.testID === 'ctx')[0];
        expect(ctx!.props['data-percent-text']).toBe(false);
    });

    it('honors contextGaugeStyle="hidden" (no gauge) and "text" (warning line)', () => {
        modelStore.state.current = modelWith({ context: CONTEXT_MODEL });
        motionState.contextGaugeStyle = 'hidden';
        act(() => { tree = create(<SessionInstrumentStrip sessionId="s1" agentId={'claude' as never} />); });
        layout(tree!, 420);
        expect(tree!.root.findAll((n) => n.props?.testID === 'ctx')).toHaveLength(0);
        act(() => tree!.unmount());

        motionState.contextGaugeStyle = 'text';
        act(() => { tree = create(<SessionInstrumentStrip sessionId="s1" agentId={'claude' as never} />); });
        layout(tree!, 420);
        const texts = tree!.root.findAll((n) => String(n.type) === 'Text');
        expect(texts.some((n) => collect(n).includes('12% left'))).toBe(true);
    });
});

function collect(node: { props: { children?: unknown } }): string {
    const out: string[] = [];
    const walk = (value: unknown) => {
        if (value == null) return;
        if (typeof value === 'string' || typeof value === 'number') { out.push(String(value)); return; }
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (typeof value === 'object' && 'props' in (value as object)) {
            walk((value as { props: { children?: unknown } }).props.children);
        }
    };
    walk(node.props.children);
    return out.join(' ');
}
