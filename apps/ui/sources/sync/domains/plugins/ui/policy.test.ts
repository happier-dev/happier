import { describe, expect, it } from 'vitest';

import {
    canRenderPluginUiProjectionEntry,
} from './policy';

describe('plugin UI projection policy', () => {
    it('fails closed for missing projection entries', () => {
        expect(canRenderPluginUiProjectionEntry(null)).toBe(false);
        expect(canRenderPluginUiProjectionEntry(undefined)).toBe(false);
    });

    it('renders entries without declared policy', () => {
        expect(canRenderPluginUiProjectionEntry({
            id: 'surfacePlacement:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
        })).toBe(true);
    });

    it('EVALUATES declared compatibility instead of hiding it', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
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
            enabled: { operand: 'feature.enabled', value: 'acme.cap' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
        // Even when the enabled predicate fails, the entry stays VISIBLE.
        expect(canRenderPluginUiProjectionEntry(entry, { isFeatureEnabled: () => false })).toBe(true);
    });
});
