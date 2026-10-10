import { describe, expect, it } from 'vitest';
import { resolveTranscriptToolVisibility } from './resolveTranscriptToolVisibility';

describe('transcript tool visibility', () => {
    it('prefers the authorized Session choice, then Bot inheritance, then the Account default', () => {
        expect(resolveTranscriptToolVisibility({ sessionOverride: true, isBot: true, accountShowToolCalls: false }).showToolCalls).toBe(true);
        expect(resolveTranscriptToolVisibility({ sessionOverride: false, isBot: false, accountShowToolCalls: true }).showToolCalls).toBe(false);
        expect(resolveTranscriptToolVisibility({ isBot: true, accountShowToolCalls: true }).showToolCalls).toBe(false);
        expect(resolveTranscriptToolVisibility({ isBot: false }).showToolCalls).toBe(true);
    });

    it('forces grouping and zero previews over contrary saved knobs while hidden', () => {
        expect(resolveTranscriptToolVisibility({ isBot: false, accountShowToolCalls: false,
            groupToolCalls: false, collapsedPreviewCount: 3 })).toEqual({
            showToolCalls: false, groupToolCalls: true, collapsedPreviewCount: 0, autoExpand: false,
        });
        expect(resolveTranscriptToolVisibility({ sessionOverride: true, isBot: true, accountShowToolCalls: false,
            groupToolCalls: false, collapsedPreviewCount: 3 })).toEqual({
            showToolCalls: true, groupToolCalls: false, collapsedPreviewCount: 3, autoExpand: true,
        });
    });
});
