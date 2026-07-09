import { describe, expect, it } from 'vitest';

import { resolveMainTranscriptListShellFrame } from './transcriptListShellCapabilities';
import { resolveTranscriptListShellEdgeSlots } from './transcriptListShellEdgeSlots';

describe('transcriptListShellEdgeSlots', () => {
    it('maps visual top and bottom to standard FlashList slots', () => {
        const visualTopNode = { id: 'top' };
        const visualBottomNode = { id: 'bottom' };

        expect(resolveTranscriptListShellEdgeSlots({
            frame: resolveMainTranscriptListShellFrame({ platformOS: 'web' }),
            visualTopNode,
            visualBottomNode,
        })).toEqual({
            listHeaderNode: visualTopNode,
            listFooterNode: visualBottomNode,
        });
    });

    it('maps visual bottom to ListHeaderComponent for inverted FlashList frames', () => {
        const visualTopNode = { id: 'top' };
        const visualBottomNode = { id: 'bottom' };

        expect(resolveTranscriptListShellEdgeSlots({
            frame: resolveMainTranscriptListShellFrame({ platformOS: 'ios' }),
            visualTopNode,
            visualBottomNode,
        })).toEqual({
            listHeaderNode: visualBottomNode,
            listFooterNode: visualTopNode,
        });
    });
});
