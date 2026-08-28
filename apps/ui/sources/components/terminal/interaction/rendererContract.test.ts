import { describe, expect, it } from 'vitest';

import {
    buildTerminalRendererInteractionContract,
    readRendererSelection,
    resolveRendererCommittedInput,
    shouldConsumeTerminalControlSequence,
    shouldRendererCaptureKeyboard,
} from './rendererContract';

describe('terminal renderer interaction contract', () => {
    it('builds the accessible and fail-closed xterm policy', () => {
        const contract = buildTerminalRendererInteractionContract('xterm-web');
        expect(contract.screenReaderMode).toBe(true);
        expect(contract.mouseCaptureEnabled).toBe(true);
        expect(shouldConsumeTerminalControlSequence(contract, 'osc52')).toBe(true);
        expect(shouldConsumeTerminalControlSequence(contract, 'sixel')).toBe(true);
    });

    it('routes keyboard, committed input, and selection through canonical helpers', () => {
        expect(shouldRendererCaptureKeyboard({ key: 'c', modifiers: ['meta'] })).toBe(false);
        expect(shouldRendererCaptureKeyboard({ key: 'Enter', modifiers: [] })).toBe(true);
        expect(resolveRendererCommittedInput('文')).toBe('文');
        expect(readRendererSelection({ hasSelection: () => true, getSelectionText: () => 'selected' })).toEqual({
            hasSelection: true,
            text: 'selected',
        });
    });
});
