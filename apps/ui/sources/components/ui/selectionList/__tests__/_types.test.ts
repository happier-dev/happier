import { describe, expect, it } from 'vitest';

import {
    SELECTION_LIST_STATUS_VARIANTS,
    type SelectionListAccessory,
    type SelectionListDynamicSection,
    type SelectionListInputBehavior,
    type SelectionListKeyboardHint,
    type SelectionListOption,
    type SelectionListProps,
    type SelectionListSection,
    type SelectionListSectionDescriptor,
    type SelectionListStatusVariant,
    type SelectionListStep,
} from '../_types';

describe('selectionList/_types', () => {
    it('represents an option with the documented shape', () => {
        const onSelect = () => {};
        const option: SelectionListOption = {
            id: 'use-current-dir',
            label: 'Use current directory',
            subtitle: 'Skips creating a worktree',
            onSelect,
        };
        expect(option.id).toBe('use-current-dir');
        expect(option.label).toBe('Use current directory');
        expect(option.subtitle).toBe('Skips creating a worktree');
        expect(option.onSelect).toBe(onSelect);
    });

    it('represents a static section descriptor with kind tag', () => {
        const section: SelectionListSection = {
            id: 'quick-actions',
            title: 'QUICK ACTIONS',
            options: [
                { id: 'opt', label: 'Opt' },
            ],
        };
        const descriptor: SelectionListSectionDescriptor = {
            kind: 'static',
            ...section,
        };
        expect(descriptor.kind).toBe('static');
        // Discriminated union: TS narrows to static branch via `kind`.
        if (descriptor.kind === 'static') {
            expect(descriptor.options[0].id).toBe('opt');
        }
    });

    it('represents a step with sections in visual order', () => {
        const step: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search worktrees',
            sections: [
                {
                    kind: 'static',
                    id: 'quick',
                    title: 'QUICK ACTIONS',
                    options: [{ id: 'use', label: 'Use current directory' }],
                },
            ],
            footerHints: [{ id: 'enter', label: '↵', description: 'Select' }],
        };
        expect(step.sections).toHaveLength(1);
        expect(step.footerHints).toHaveLength(1);
    });

    it('exposes the documented status variants as a runtime const tuple matching the union', () => {
        const variants: ReadonlyArray<SelectionListStatusVariant> = SELECTION_LIST_STATUS_VARIANTS;
        expect(variants).toEqual(['clean', 'dirty', 'stale', 'info', 'neutral']);
    });

    it('treats a keyboard hint as id + label + optional description', () => {
        const hint: SelectionListKeyboardHint = { id: 'enter', label: '↵' };
        expect(hint.description).toBeUndefined();
        const withDescription: SelectionListKeyboardHint = { id: 'enter', label: '↵', description: 'select' };
        expect(withDescription.description).toBe('select');
    });

    it('accepts a React node as accessory', () => {
        const accessory: SelectionListAccessory = null;
        expect(accessory).toBeNull();
    });

    it('represents an option with an autocompleteValue (Phase 2.1)', () => {
        const option: SelectionListOption = {
            id: 'docs',
            label: 'Documents',
            autocompleteValue: '~/Documents/',
        };
        expect(option.autocompleteValue).toBe('~/Documents/');
    });

    it('represents a dynamic section descriptor in the discriminated union (Phase 2.1)', () => {
        const dynamic: SelectionListDynamicSection = {
            id: 'in-this-folder',
            title: 'IN THIS FOLDER',
            resolve: async () => ({ options: [] }),
            debounceMs: 100,
            loadingSkeletonRows: 4,
            visibleWhen: (input) => input.startsWith('/'),
            seedFromInput: (input) => input,
        };
        const descriptor: SelectionListSectionDescriptor = { kind: 'dynamic', ...dynamic };
        if (descriptor.kind === 'dynamic') {
            expect(descriptor.id).toBe('in-this-folder');
            expect(descriptor.debounceMs).toBe(100);
            expect(descriptor.loadingSkeletonRows).toBe(4);
        } else {
            throw new Error('expected dynamic branch');
        }
    });

    it('exposes a SelectionListInputBehavior shape with all functions optional (Phase 2.1)', () => {
        const empty: SelectionListInputBehavior = {};
        expect(empty).toBeDefined();
        const full: SelectionListInputBehavior = {
            getFilterQueryFromInput: (input) => input,
            getDynamicSectionSeed: (input) => input,
            onBackspaceAtEnd: (input) => (input.length > 0 ? input.slice(0, -1) : null),
            shouldSuppressAutocomplete: () => false,
        };
        expect(full.getFilterQueryFromInput?.('abc')).toBe('abc');
        expect(full.onBackspaceAtEnd?.('x')).toBe('');
        expect(full.onBackspaceAtEnd?.('')).toBeNull();
    });

    it('accepts inputMode, inputBehavior, inputPrefix, inputSuffix on SelectionListProps (Phase 2.1)', () => {
        const props: SelectionListProps = {
            rootStep: {
                id: 'r',
                sections: [],
            },
            onSelect: () => {},
            onRequestClose: () => {},
            inputMode: 'value',
            inputBehavior: { getFilterQueryFromInput: (s) => s },
            inputPrefix: null,
            inputSuffix: null,
            inputValue: '~/',
            onChangeInputValue: () => {},
            onCommitInputValue: () => {},
        };
        expect(props.inputMode).toBe('value');
    });
});
