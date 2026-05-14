import { describe, expect, it } from 'vitest';

import { computeAutocompleteState } from '../useSelectionListAutocomplete';
import type { SelectionListOption } from '../_types';

function option(overrides: Partial<SelectionListOption> & { id: string; label: string }): SelectionListOption {
    return { ...overrides };
}

describe('computeAutocompleteState (Phase 2.3)', () => {
    it('returns empty ghost when focusedOption is null', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: null,
        });
        expect(result.ghostSuffix).toBe('');
        expect(result.nextInputValue).toBe('~/D');
    });

    it('returns empty ghost when focused option has no autocompleteValue', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: option({ id: 'docs', label: 'Documents' }),
        });
        expect(result.ghostSuffix).toBe('');
    });

    it('returns the suffix when autocompleteValue starts with inputValue (case-sensitive)', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
        });
        expect(result.ghostSuffix).toBe('ocuments/');
        expect(result.nextInputValue).toBe('~/Documents/');
    });

    it('is case-sensitive — different case prefix yields empty ghost', () => {
        const result = computeAutocompleteState({
            inputValue: '~/d',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
        });
        expect(result.ghostSuffix).toBe('');
    });

    it('returns empty ghost when input is empty', () => {
        const result = computeAutocompleteState({
            inputValue: '',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
        });
        expect(result.ghostSuffix).toBe('');
    });

    it('returns empty ghost when input equals autocompleteValue (nothing to suggest)', () => {
        const result = computeAutocompleteState({
            inputValue: '~/Documents/',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
        });
        expect(result.ghostSuffix).toBe('');
    });

    it('suppresses ghost when shouldSuppress predicate returns true', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
            shouldSuppress: () => true,
        });
        expect(result.ghostSuffix).toBe('');
    });

    it('does not suppress when shouldSuppress predicate returns false', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
            shouldSuppress: () => false,
        });
        expect(result.ghostSuffix).toBe('ocuments/');
    });

    it('suppresses ghost when isComposing is true (IME active)', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
            isComposing: true,
        });
        expect(result.ghostSuffix).toBe('');
    });

    it('suppresses ghost when isFocusedOptionInDynamicSection is false', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
            isFocusedOptionInDynamicSection: false,
        });
        expect(result.ghostSuffix).toBe('');
    });

    it('returns ghost when isFocusedOptionInDynamicSection is true', () => {
        const result = computeAutocompleteState({
            inputValue: '~/D',
            focusedOption: option({
                id: 'docs',
                label: 'Documents',
                autocompleteValue: '~/Documents/',
            }),
            isFocusedOptionInDynamicSection: true,
        });
        expect(result.ghostSuffix).toBe('ocuments/');
    });
});
