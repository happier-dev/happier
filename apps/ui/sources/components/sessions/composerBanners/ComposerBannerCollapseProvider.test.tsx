import * as React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readComposerBannerCollapse, writeComposerBannerCollapse } from '@/sync/domains/state/composerBannerUiState';

import {
    ComposerBannerCollapseProvider,
    useComposerBannerCollapse,
} from './ComposerBannerCollapseProvider';

type ReactActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = storage.getState();

function CollapseProbe(props: Readonly<{ surface: string }>) {
    const { collapsed, toggle } = useComposerBannerCollapse('usageLimitRecovery');
    return React.createElement('probe', {
        probeId: props.surface,
        collapsed,
        onToggle: toggle,
    });
}

function EphemeralCollapseProbe() {
    const { collapsed, toggle } = useComposerBannerCollapse('draftConflict', { persistence: 'ephemeral' });
    return React.createElement('probe', { probeId: 'draft-conflict', collapsed, onToggle: toggle });
}

async function renderSurface() {
    const screen = await renderScreen(
        React.createElement(ComposerBannerCollapseProvider, null,
            // Two sibling subtrees stand in for the composer action bar (badge) and the
            // transcript footer slot (banner), which are never in the same subtree.
            React.createElement('badgeTree', null, React.createElement(CollapseProbe, { surface: 'badge' })),
            React.createElement('bannerTree', null, React.createElement(CollapseProbe, { surface: 'banner' })),
        ),
    );
    return screen.tree;
}

function readCollapsed(tree: ReactTestRenderer, probeId: string): boolean {
    return tree.root.findByProps({ probeId }).props.collapsed;
}

function toggleFrom(tree: ReactTestRenderer, probeId: string): void {
    const onToggle = tree.root.findByProps({ probeId }).props.onToggle;
    act(() => { onToggle(); });
}

describe('ComposerBannerCollapseProvider', () => {
    beforeEach(() => {
        storage.setState(state => ({ settings: settingsParse({ ...state.settings,
            sessionComposerRememberBannerVisibility: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) }));
        writeComposerBannerCollapse({});
    });
    afterEach(() => { standardCleanup(); storage.setState(initialState, true); vi.restoreAllMocks(); clearPersistenceStorage(); });

    it('shares collapse across sibling subtrees so the badge and its banner never disagree', async () => {
        const tree = await renderSurface();
        expect(readCollapsed(tree, 'badge')).toBe(false);
        expect(readCollapsed(tree, 'banner')).toBe(false);

        toggleFrom(tree, 'badge');

        expect(readCollapsed(tree, 'badge')).toBe(true);
        expect(readCollapsed(tree, 'banner')).toBe(true);
    });

    it('keeps collapse out of device storage and out of the next surface while remembering is off', async () => {
        const first = await renderSurface();
        toggleFrom(first, 'badge');
        expect(readCollapsed(first, 'badge')).toBe(true);
        expect(readComposerBannerCollapse()).toEqual({});

        const second = await renderSurface();
        expect(readCollapsed(second, 'badge')).toBe(false);
    });

    it('remembers collapse across surfaces with Settings writes Off', async () => {
        storage.getState().applySettingsLocal({ sessionComposerRememberBannerVisibility: true });
        const first = await renderSurface();
        const write = vi.spyOn(getPersistenceStorage(), 'set');

        toggleFrom(first, 'badge');
        expect(write.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
        expect(readComposerBannerCollapse()).toEqual({ usageLimitRecovery: true });

        const second = await renderSurface();
        expect(readCollapsed(second, 'badge')).toBe(true);

        toggleFrom(second, 'banner');
        expect(readCollapsed(first, 'badge')).toBe(false);
        expect(readComposerBannerCollapse()).toEqual({});
    });

    it('ignores but preserves the stored record when remembering is off', async () => {
        writeComposerBannerCollapse({ usageLimitRecovery: true });

        const tree = await renderSurface();

        expect(readCollapsed(tree, 'badge')).toBe(false);
        expect(readComposerBannerCollapse()).toEqual({ usageLimitRecovery: true });
    });

    it('keeps an explicitly ephemeral conflict collapse out of remembered banner preferences', async () => {
        storage.getState().applySettingsLocal({ sessionComposerRememberBannerVisibility: true });
        const screen = await renderScreen(
            React.createElement(ComposerBannerCollapseProvider, null, React.createElement(EphemeralCollapseProbe)),
        );
        const tree = screen.tree;

        toggleFrom(tree, 'draft-conflict');

        expect(readCollapsed(tree, 'draft-conflict')).toBe(true);
        expect(readComposerBannerCollapse()).toEqual({});
    });
});
