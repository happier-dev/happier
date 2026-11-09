import { describe, expect, it } from 'vitest';

import { resolveAiSuggestionFooterState } from './AiSuggestionStatus';

describe('the AI suggestion footer reason', () => {
    it('says nothing while suggestions are on but the editor is not taking them yet', () => {
        // After a layout change the editor waits for the person to return to it; the setting is still on.
        expect(resolveAiSuggestionFooterState({ status: 'off', reason: 'off' }, { enabled: true })).toBeNull();
        expect(resolveAiSuggestionFooterState({ status: 'off', reason: 'off' }, { enabled: false })).toBe('off');
    });

    it('keeps saying why when this file is excluded or the model cannot answer', () => {
        expect(resolveAiSuggestionFooterState({ status: 'unavailable', reason: 'excluded' }, { enabled: true })).toBe('off');
        expect(resolveAiSuggestionFooterState({ status: 'unavailable', reason: 'rate_limited' }, { enabled: true })).toBe('rate_limited');
        expect(resolveAiSuggestionFooterState({ status: 'unavailable', reason: 'model_unavailable' }, { enabled: true })).toBe('model_unavailable');
        expect(resolveAiSuggestionFooterState({ status: 'idle' }, { enabled: true })).toBeNull();
    });
});
