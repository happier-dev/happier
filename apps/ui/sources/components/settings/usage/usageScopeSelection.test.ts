import { describe, expect, it } from 'vitest';
import { toggleUsageScopeSelection } from './usageWidgetPageContext';

describe('scope filter selection (lab d2filter)', () => {
    const options = ['claude', 'codex', 'gemini'];
    it('narrows from all to the one chosen, then adds and removes others', () => {
        expect(toggleUsageScopeSelection([], 'codex', options)).toEqual(['codex']);
        expect(toggleUsageScopeSelection(['codex'], 'claude', options)).toEqual(['claude', 'codex']);
        expect(toggleUsageScopeSelection(['claude', 'codex'], 'codex', options)).toEqual(['claude']);
    });
    it('returns to all when the last choice is cleared or every option is chosen', () => {
        expect(toggleUsageScopeSelection(['claude'], 'claude', options)).toEqual([]);
        expect(toggleUsageScopeSelection(['claude', 'codex'], 'gemini', options)).toEqual([]);
    });
    it('keeps a chosen value the facts no longer list', () => {
        expect(toggleUsageScopeSelection(['retired'], 'claude', options)).toEqual(['claude', 'retired']);
    });
});
