import { PLUGIN_HOST_PLACEMENT_RENDERER_IDS } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { resolvePluginHostRendererComponent } from './hostRenderers';

describe('resolvePluginHostRendererComponent', () => {
    it('Phase 1.4: resolves a component for EVERY id in the unified host-placement set', () => {
        // The protocol set unifies `descriptorPanel` + the 8 sessionSurface ids; the
        // UI dispatch table must produce a component for each — ONE dispatch table.
        for (const rendererId of PLUGIN_HOST_PLACEMENT_RENDERER_IDS) {
            expect(resolvePluginHostRendererComponent(rendererId)).toBeTypeOf('function');
        }
    });

    it('resolves the canonical descriptor panel + the 8 session-surface renderer ids', () => {
        for (const rendererId of [
            'descriptorPanel',
            'actionPanel',
            'emptyState',
            'fileReference',
            'markdownDetails',
            'previewPlaceholder',
            'resourceSummary',
            'statusTimeline',
            'terminalReference',
        ]) {
            expect(resolvePluginHostRendererComponent(rendererId)).not.toBeNull();
        }
    });

    it('fails closed for unknown / empty / non-string renderer ids', () => {
        expect(resolvePluginHostRendererComponent('settingsDescriptorPanel')).toBeNull();
        expect(resolvePluginHostRendererComponent('')).toBeNull();
        expect(resolvePluginHostRendererComponent(null)).toBeNull();
        expect(resolvePluginHostRendererComponent(undefined)).toBeNull();
    });
});
