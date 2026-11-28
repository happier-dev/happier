import { describe, expect, it } from 'vitest';
import { normalizeRecognizedTranscriptText } from './normalizeRecognizedTranscriptText';

describe('normalizeRecognizedTranscriptText', () => {
    it.each([
        ['HELLO WORLD. HOW ARE YOU? FINE!', 'Hello world. How are you? Fine!'],
        ['HE BEGAN A CONFUSED COMPLAINT AGAINST THE WIZARD.', 'He began a confused complaint against the wizard.'],
        ['  Open README.md for API  ', 'Open README.md for API'],
        ['ÉCOUTEZ. ÉCRIVEZ À NOËL!', 'Écoutez. Écrivez à noël!'],
        ['"ÉCOLE! ÉTÉ."', '"École! Été."'],
        ['already lowercase', 'already lowercase'],
        ['123...', '123...'],
        ['', null],
        ['   \n  ', null],
        [null, null],
    ])('normalizes %j to %j', (input, expected) => {
        expect(normalizeRecognizedTranscriptText(input)).toBe(expected);
    });
});
