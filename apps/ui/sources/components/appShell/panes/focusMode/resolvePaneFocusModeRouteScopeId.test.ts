import { describe, expect, it } from 'vitest';

import { resolvePaneFocusModeRouteScopeId } from './resolvePaneFocusModeRouteScopeId';

describe('resolvePaneFocusModeRouteScopeId', () => {
    it('resolves session routes into their pane scope id', () => {
        expect(resolvePaneFocusModeRouteScopeId('/session/session-1')).toBe('session:session-1');
        expect(resolvePaneFocusModeRouteScopeId('/(app)/session/session-1/details')).toBe('session:session-1');
    });

    it('decodes encoded session ids and ignores query strings', () => {
        expect(resolvePaneFocusModeRouteScopeId('/session/session%201?tab=git')).toBe('session:session 1');
    });

    it('returns null for non-session routes', () => {
        expect(resolvePaneFocusModeRouteScopeId('/settings')).toBeNull();
        expect(resolvePaneFocusModeRouteScopeId('/')).toBeNull();
    });
});
