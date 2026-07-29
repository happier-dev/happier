import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ComposerBannerCollapseProvider,
    useComposerBannerCollapse,
} from './ComposerBannerCollapseProvider';

type ReactActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

// Settings persistence is a real system boundary; the store below keeps write-then-read behavior
// honest so the "remember" path is exercised end to end instead of asserting on a spy.
const settingsStore = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = {
        remember: false,
        collapsedKinds: {} as Record<string, boolean>,
    };
    return {
        state,
        listeners,
        reset() {
            state.remember = false;
            state.collapsedKinds = {};
        },
        write(next: Record<string, boolean>) {
            state.collapsedKinds = next;
            for (const listener of [...listeners]) listener();
        },
    };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const React_ = await import('react');
    const subscribe = (listener: () => void) => {
        settingsStore.listeners.add(listener);
        return () => settingsStore.listeners.delete(listener);
    };
    return {
        useSetting: (key: string) => React_.useSyncExternalStore(
            subscribe,
            () => (key === 'sessionComposerRememberBannerVisibility'
                ? settingsStore.state.remember
                : undefined),
        ),
        useLocalSettingMutable: (key: string) => {
            const value = React_.useSyncExternalStore(
                subscribe,
                () => (key === 'sessionComposerCollapsedBannerKinds'
                    ? settingsStore.state.collapsedKinds
                    : undefined),
            );
            return [value, settingsStore.write];
        },
    };
});

function CollapseProbe(props: Readonly<{ surface: string }>) {
    const { collapsed, toggle } = useComposerBannerCollapse('usageLimitRecovery');
    return React.createElement('probe', {
        probeId: props.surface,
        collapsed,
        onToggle: toggle,
    });
}

function renderSurface() {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
        tree = renderer.create(
            React.createElement(ComposerBannerCollapseProvider, null,
                // Two sibling subtrees stand in for the composer action bar (badge) and the
                // transcript footer slot (banner), which are never in the same subtree.
                React.createElement('badgeTree', null, React.createElement(CollapseProbe, { surface: 'badge' })),
                React.createElement('bannerTree', null, React.createElement(CollapseProbe, { surface: 'banner' })),
            ),
        );
    });
    return tree;
}

function readCollapsed(tree: renderer.ReactTestRenderer, probeId: string): boolean {
    return tree.root.findByProps({ probeId }).props.collapsed;
}

function toggleFrom(tree: renderer.ReactTestRenderer, probeId: string): void {
    const onToggle = tree.root.findByProps({ probeId }).props.onToggle;
    act(() => { onToggle(); });
}

describe('ComposerBannerCollapseProvider', () => {
    beforeEach(() => {
        settingsStore.reset();
    });

    it('shares collapse across sibling subtrees so the badge and its banner never disagree', () => {
        const tree = renderSurface();
        expect(readCollapsed(tree, 'badge')).toBe(false);
        expect(readCollapsed(tree, 'banner')).toBe(false);

        toggleFrom(tree, 'badge');

        expect(readCollapsed(tree, 'badge')).toBe(true);
        expect(readCollapsed(tree, 'banner')).toBe(true);
    });

    it('keeps collapse out of device storage and out of the next surface while remembering is off', () => {
        const first = renderSurface();
        toggleFrom(first, 'badge');
        expect(readCollapsed(first, 'badge')).toBe(true);
        expect(settingsStore.state.collapsedKinds).toEqual({});

        const second = renderSurface();
        expect(readCollapsed(second, 'badge')).toBe(false);
    });

    it('carries collapse to another session surface while remembering is on', () => {
        settingsStore.state.remember = true;
        const first = renderSurface();

        toggleFrom(first, 'badge');
        expect(settingsStore.state.collapsedKinds).toEqual({ usageLimitRecovery: true });

        const second = renderSurface();
        expect(readCollapsed(second, 'badge')).toBe(true);

        toggleFrom(second, 'banner');
        expect(readCollapsed(first, 'badge')).toBe(false);
        expect(settingsStore.state.collapsedKinds).toEqual({});
    });

    it('ignores but preserves the stored record when remembering is off', () => {
        settingsStore.state.collapsedKinds = { usageLimitRecovery: true };

        const tree = renderSurface();

        expect(readCollapsed(tree, 'badge')).toBe(false);
        expect(settingsStore.state.collapsedKinds).toEqual({ usageLimitRecovery: true });
    });
});
