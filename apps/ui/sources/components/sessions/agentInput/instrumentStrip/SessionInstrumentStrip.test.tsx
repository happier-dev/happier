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
    entrance: { kind: 'crossfade', durationMs: 150 } as { kind: 'crossfade' | 'travel'; durationMs: number },
    reduceMotion: false,
}));

vi.mock('./useInstrumentStripModel', () => ({
    useInstrumentStripModel: () => React.useSyncExternalStore(modelStore.subscribe, () => modelStore.state.current),
}));

vi.mock('@/components/instrument', () => ({
    useMotionPreferences: () => ({
        level: 'subtle',
        contextGaugeStyle: motionState.contextGaugeStyle,
        entrance: motionState.entrance,
        reduceMotion: motionState.reduceMotion,
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
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({ useSetting: () => false }));
// The Account-scope hook reads the sync runtime singleton (a boundary); the strip only needs "no bound scope".
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: () => ({ kind: 'unbound' }),
}));
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
        motionState.entrance = { kind: 'crossfade', durationMs: 150 };
        motionState.reduceMotion = false;
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

    it('reserves its row while empty unless the host collapses it, and shows content either way', () => {
        const emptyHostHeight = () => {
            const host = tree!.root.findAll((n) => typeof n.type === 'string' && typeof n.props?.onLayout === 'function')[0]!;
            const style = [host.props.style].flat(Infinity).reduce((acc: Record<string, unknown>, part) => ({ ...acc, ...(part ?? {}) }), {});
            return (style.minHeight as number | undefined) ?? 0;
        };
        act(() => { tree = create(<SessionInstrumentStrip />); });
        expect(emptyHostHeight()).toBeGreaterThan(0);

        act(() => { tree!.update(<SessionInstrumentStrip collapseWhenEmpty />); });
        expect(emptyHostHeight()).toBe(0);

        const offline = { text: 'Offline', color: '#f00', dotColor: '#f00' };
        act(() => { tree!.update(<SessionInstrumentStrip collapseWhenEmpty connectionStatus={offline} />); });
        expect(tree!.root.findAll((n) => typeof n.type === 'string' && n.props?.testID === 'agent-input-connection-status-text')).toHaveLength(1);
    });

    it('ends the guard warning line with its countdown and offers Keep running in the same row', () => {
        const keepRunning = vi.fn();
        const warning = { text: 'Stopping in', color: '#b60', dotColor: '#b60', countdownTo: Date.now() + 292_000,
            action: { label: 'Keep running', onPress: keepRunning } };
        act(() => { tree = create(<SessionInstrumentStrip connectionStatus={warning} />); });
        const line = tree!.root.findAll((n) => typeof n.type === 'string' && n.props?.testID === 'agent-input-connection-status-text')[0]!;
        const text = (node: typeof line): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
        expect(text(line)).toMatch(/^Stopping in 4:5\d$/u);
        act(() => { tree!.root.findAll((n) => n.props?.testID === 'agent-input-connection-recovery')[0]!.props.onPress(); });
        expect(keepRunning).toHaveBeenCalledTimes(1);
    });

    it('keeps a long explanation off the line: the short state stays, the detail is its tooltip and is read with it', () => {
        const restart = vi.fn();
        const status = { text: 'Provider settings changed', color: '#b60', dotColor: '#b60',
            detail: 'This session is still using the Gateway · Work configuration it started with.',
            action: { label: 'Restart session', onPress: restart } };
        act(() => { tree = create(<SessionInstrumentStrip connectionStatus={status} />); });
        const host = tree!.root.findAll((n) => n.props?.testID === 'agent-input-connection-detail'
            && n.props?.accessibilityLabel !== undefined)[0]!;
        expect(host.props.accessibilityLabel).toBe(
            'Provider settings changed. This session is still using the Gateway · Work configuration it started with.');
        expect(host.findAll((n) => typeof n.type === 'string' && n.props?.testID === 'agent-input-connection-status-text')).toHaveLength(1);
        act(() => { tree!.root.findAll((n) => n.props?.testID === 'agent-input-connection-recovery')[0]!.props.onPress(); });
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('ends the line with the primary action, then a quieter second way forward; a disabled one cannot fire', () => {
        const switchAccount = vi.fn();
        const signIn = vi.fn();
        const status = { text: 'Claude needs sign-in on Devbox', color: '#b60', dotColor: '#b60',
            action: { label: 'Use Claude (work)', onPress: switchAccount, testID: 'primary' },
            secondaryAction: { label: 'Sign in', onPress: signIn, testID: 'secondary' } };
        act(() => { tree = create(<SessionInstrumentStrip connectionStatus={status} />); });
        const links = ['primary', 'secondary'].map((id) => tree!.root.findAll((n) => n.props?.testID === id)[0]!);
        expect(links.map((n) => [n.props.testID, n.props.tone])).toEqual([['primary', 'strong'], ['secondary', 'quiet']]);
        act(() => { links[0]!.props.onPress(); links[1]!.props.onPress(); });
        expect(switchAccount).toHaveBeenCalledTimes(1);
        expect(signIn).toHaveBeenCalledTimes(1);
        act(() => { tree!.update(<SessionInstrumentStrip connectionStatus={{ ...status, secondaryAction: undefined }} />); });
        expect(tree!.root.findAll((n) => n.props?.testID === 'secondary')).toHaveLength(0);
    });

    it('keeps a line whose action is a name to one line, and lets other actions wrap the sentence', () => {
        const text = () => tree!.root.findAll((n) => n.props?.testID === 'agent-input-connection-status-text' && typeof n.type !== 'string')[0]!;
        const status = { text: 'Claude needs sign-in', color: '#b60', dotColor: '#b60',
            action: { label: 'ai1@happier.dev', onPress: vi.fn(), truncates: true } };
        act(() => { tree = create(<SessionInstrumentStrip connectionStatus={status} />); });
        expect(text().props.numberOfLines).toBe(1);
        act(() => { tree!.update(<SessionInstrumentStrip connectionStatus={{ ...status, action: { label: 'Restart', onPress: vi.fn() } }} />); });
        expect(text().props.numberOfLines).toBe(2);
    });

    it('cross-fades the line when the guard moment changes, and simply shows the first line', () => {
        const line = () => tree!.root.findAll((n) => n.props?.style === undefined ? false : n.props?.testID === undefined
            && n.findAll((c) => c.props?.testID === 'agent-input-connection-status-text').length > 0 && 'entering' in n.props)[0]!;
        act(() => { tree = create(<SessionInstrumentStrip connectionStatus={{ text: 'Stopping in', color: '#b60', dotColor: '#b60', transitionKey: 'warning' }} />); });
        expect(line().props.entering).toBeUndefined();
        act(() => { tree!.update(<SessionInstrumentStrip connectionStatus={{ text: 'Stopped to free memory', color: '#999', dotColor: '#999', transitionKey: 'stopped' }} />); });
        expect(line().props.entering).toBeDefined();
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
        expect(tree!.root.findAll((n) => (
            typeof n.type === 'string' && n.props?.testID === 'session-instrument-overflow-chip'
        ))).toHaveLength(1);
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

    it('fades a leaving instrument out with its entrance motion, and not at all under reduced motion', () => {
        const wrapper = () => tree!.root.findAll((n) => 'exiting' in (n.props ?? {})
            && n.findAll((c) => c.props?.testID === 'creating-badge').length > 0)[0]!;
        const render = () => act(() => {
            tree = create(<SessionInstrumentStrip statusBadges={[{ key: 'creating', label: 'Creating vercel-1', testID: 'creating-badge' }]} />);
        });
        motionState.entrance = { kind: 'travel', durationMs: 360 };
        render();
        // The same Reanimated layout primitive and kit duration as the entrance (a joined machine's badge settles).
        expect(wrapper().props.exiting).toBeDefined();
        act(() => tree!.unmount());
        motionState.reduceMotion = true;
        render();
        expect(wrapper().props.exiting).toBeUndefined();
    });

    it('announces a popover badge as expanded exactly while its popover is open', () => {
        act(() => {
            tree = create(
                <SessionInstrumentStrip
                    statusBadges={[
                        { key: 'work', label: 'Goal paused', testID: 'work-badge', renderPopover: ({ open }) => (open ? React.createElement('WorkPopover') : null) },
                        { key: 'plain', label: 'Note', testID: 'plain-badge' },
                    ]}
                />,
            );
        });
        const badge = (testID: string) => tree!.root.findAll((n) => n.props?.testID === testID)[0]!;
        expect(badge('work-badge').props.accessibilityState).toEqual({ expanded: false });
        // A badge that opens nothing has no expanded state to announce.
        expect(badge('plain-badge').props.accessibilityState).toBeUndefined();
        act(() => badge('work-badge').props.onPress());
        expect(badge('work-badge').props.accessibilityState).toEqual({ expanded: true });
        act(() => badge('work-badge').props.onPress());
        expect(badge('work-badge').props.accessibilityState).toEqual({ expanded: false });
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
