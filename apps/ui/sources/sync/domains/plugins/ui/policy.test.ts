import { describe, expect, it } from 'vitest';

import {
    canRenderPluginUiProjectionEntry,
    hasDeferredPluginUiPolicy,
} from './policy';

describe('plugin UI projection policy', () => {
    it('fails closed for missing projection entries', () => {
        expect(canRenderPluginUiProjectionEntry(null)).toBe(false);
        expect(canRenderPluginUiProjectionEntry(undefined)).toBe(false);
    });

    it('flags entries that declare host-evaluated policy fields', () => {
        expect(hasDeferredPluginUiPolicy({
            id: 'surfacePlacement:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            placement: 'session.rightSidebarTab',
            compatibility: { platforms: ['web'] },
        })).toBe(true);
        expect(hasDeferredPluginUiPolicy({
            id: 'surfacePlacement:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            placement: 'session.rightSidebarTab',
        })).toBe(false);
    });

    it('renders entries without declared policy', () => {
        expect(canRenderPluginUiProjectionEntry({
            id: 'surfacePlacement:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            placement: 'session.rightSidebarTab',
        })).toBe(true);
    });

    it('EVALUATES declared compatibility instead of hiding it', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            placement: 'session.rightSidebarTab',
            compatibility: { platforms: ['web'] },
        };
        // Compatible platform: rendered (the old accept-and-hide returned false here).
        expect(canRenderPluginUiProjectionEntry(entry, { platform: 'web' })).toBe(true);
        // Incompatible platform: not rendered.
        expect(canRenderPluginUiProjectionEntry(entry, { platform: 'ios' })).toBe(false);
    });

    it('EVALUATES declared featureGate (fail-closed without a resolver)', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:review-tab',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            placement: 'session.rightSidebarTab',
            featureGate: 'plugins.ui.hostedWeb',
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
        // No feature resolver supplied → fail-closed.
        expect(canRenderPluginUiProjectionEntry(entry)).toBe(false);
        // Feature enabled → rendered.
        expect(
            canRenderPluginUiProjectionEntry(entry, { isFeatureEnabled: (id) => id === 'plugins.ui.hostedWeb' }),
        ).toBe(true);
    });

    it('treats a declared enabled predicate as visible-but-disabled, not hidden', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:review-tab',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            placement: 'session.rightSidebarTab',
            enabled: { operand: 'feature.enabled', value: 'acme.cap' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
        // Even when the enabled predicate fails, the entry stays VISIBLE.
        expect(canRenderPluginUiProjectionEntry(entry, { isFeatureEnabled: () => false })).toBe(true);
    });
});
