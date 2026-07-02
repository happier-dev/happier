import { describe, expect, it } from 'vitest';

import {
    createInitialSessionListSelectionState,
    reduceSessionListSelection,
} from './sessionListSelectionReducer';

function selectedKeys(state: ReturnType<typeof createInitialSessionListSelectionState>): string[] {
    return Array.from(state.selectedKeys).sort();
}

describe('sessionListSelectionReducer', () => {
    it('replaces selection and tracks the range anchor separately from current focus', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b', 'c'],
        });

        state = reduceSessionListSelection(state, { type: 'replace', key: 'b' });

        expect(state.isSelectionMode).toBe(true);
        expect(selectedKeys(state)).toEqual(['b']);
        expect(state.anchorKey).toBe('b');
        expect(state.focusedKey).toBe('b');
        expect(state.version).toBe(1);
    });

    it('extends a range from the anchor without losing the anchor', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b', 'c', 'd'],
        });

        state = reduceSessionListSelection(state, { type: 'replace', key: 'b' });
        state = reduceSessionListSelection(state, { type: 'selectRange', targetKey: 'd' });

        expect(selectedKeys(state)).toEqual(['b', 'c', 'd']);
        expect(state.anchorKey).toBe('b');
        expect(state.focusedKey).toBe('d');
        expect(state.version).toBe(2);
    });

    it('adds a disjoint range when requested', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b', 'c', 'd', 'e'],
        });

        state = reduceSessionListSelection(state, { type: 'replace', key: 'a' });
        state = reduceSessionListSelection(state, { type: 'toggle', key: 'e' });
        state = reduceSessionListSelection(state, { type: 'selectRange', targetKey: 'd', add: true });

        expect(selectedKeys(state)).toEqual(['a', 'd', 'e']);
        expect(state.anchorKey).toBe('e');
        expect(state.focusedKey).toBe('d');
    });

    it('selects all visible eligible keys and ignores ineligible rows', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b', 'c'],
            eligibleKeys: ['a', 'c'],
        });

        state = reduceSessionListSelection(state, { type: 'selectAllVisible' });

        expect(selectedKeys(state)).toEqual(['a', 'c']);
        expect(state.anchorKey).toBe('a');
    });

    it('replaces selection from a result set and prunes ineligible keys', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b', 'c'],
            eligibleKeys: ['a', 'c'],
        });

        state = reduceSessionListSelection(state, { type: 'selectAllVisible' });
        state = reduceSessionListSelection(state, { type: 'setSelectedKeys', keys: ['b', 'c'] });

        expect(state.isSelectionMode).toBe(true);
        expect(selectedKeys(state)).toEqual(['c']);
        expect(state.anchorKey).toBe('c');
        expect(state.focusedKey).toBe('c');
    });

    it('exits selection mode when result replacement has no remaining keys', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b'],
        });

        state = reduceSessionListSelection(state, { type: 'selectAllVisible' });
        state = reduceSessionListSelection(state, { type: 'setSelectedKeys', keys: [] });

        expect(state.isSelectionMode).toBe(false);
        expect(selectedKeys(state)).toEqual([]);
        expect(state.anchorKey).toBeNull();
        expect(state.focusedKey).toBeNull();
    });

    it('exits selection mode when toggling the final selected key off', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b'],
        });

        state = reduceSessionListSelection(state, { type: 'replace', key: 'a' });
        state = reduceSessionListSelection(state, { type: 'toggle', key: 'a' });

        expect(state.isSelectionMode).toBe(false);
        expect(selectedKeys(state)).toEqual([]);
        expect(state.anchorKey).toBeNull();
        expect(state.focusedKey).toBeNull();
    });

    it('preserves selected keys hidden by collapsed groups when they remain eligible in scope', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b', 'c'],
            eligibleKeys: ['a', 'b', 'c'],
        });

        state = reduceSessionListSelection(state, { type: 'replace', key: 'a' });
        state = reduceSessionListSelection(state, { type: 'toggle', key: 'c' });
        state = reduceSessionListSelection(state, {
            type: 'setVisibleOrder',
            visibleOrderedKeys: ['b'],
            eligibleKeys: ['a', 'b', 'c'],
        });

        expect(state.isSelectionMode).toBe(true);
        expect(selectedKeys(state)).toEqual(['a', 'c']);
        expect(state.anchorKey).toBe('c');
        expect(state.focusedKey).toBeNull();
    });

    it('exits selection mode when eligibility pruning removes every selected key', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b'],
            eligibleKeys: ['a', 'b'],
        });

        state = reduceSessionListSelection(state, { type: 'replace', key: 'a' });
        state = reduceSessionListSelection(state, {
            type: 'setVisibleOrder',
            visibleOrderedKeys: ['b'],
            eligibleKeys: ['b'],
        });

        expect(state.isSelectionMode).toBe(false);
        expect(selectedKeys(state)).toEqual([]);
        expect(state.anchorKey).toBeNull();
        expect(state.focusedKey).toBeNull();
    });

    it('keeps remaining selected keys from bulk results even when their rows are currently collapsed', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['b'],
            eligibleKeys: ['a', 'b', 'c'],
        });

        state = reduceSessionListSelection(state, { type: 'setSelectedKeys', keys: ['a', 'c'] });

        expect(state.isSelectionMode).toBe(true);
        expect(selectedKeys(state)).toEqual(['a', 'c']);
        expect(state.anchorKey).toBeNull();
        expect(state.focusedKey).toBeNull();
    });

    it('does not enter selection mode when select-all has no eligible visible keys', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a'],
            eligibleKeys: [],
        });

        state = reduceSessionListSelection(state, { type: 'selectAllVisible' });

        expect(state.isSelectionMode).toBe(false);
        expect(selectedKeys(state)).toEqual([]);
        expect(state.anchorKey).toBeNull();
        expect(state.focusedKey).toBeNull();
    });

    it('clears selection when scope changes instead of relying on route changes', () => {
        let state = createInitialSessionListSelectionState({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b'],
        });

        state = reduceSessionListSelection(state, { type: 'replace', key: 'a' });
        state = reduceSessionListSelection(state, {
            type: 'resetScope',
            scopeKey: 'scope-b',
            visibleOrderedKeys: ['a', 'b'],
        });

        expect(state.scopeKey).toBe('scope-b');
        expect(state.isSelectionMode).toBe(false);
        expect(selectedKeys(state)).toEqual([]);
        expect(state.anchorKey).toBeNull();
    });
});
