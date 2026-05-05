import { describe, expect, it } from 'vitest';

import { resolvePaneFocusModeRouteScopeId } from './resolvePaneFocusModeRouteScopeId';

describe('resolvePaneFocusModeRouteScopeId', () => {
    it('resolves session routes into their pane scope id', () => {
        expect(resolvePaneFocusModeRouteScopeId('/session/session-1')).toBe('session:session-1');
        expect(resolvePaneFocusModeRouteScopeId('/(app)/session/session-1/details')).toBe('session:session-1');
    });

    it('resolves project routes into their pane scope id', () => {
        expect(resolvePaneFocusModeRouteScopeId('/projects/workspace-1')).toBe('project:workspace-1');
        expect(resolvePaneFocusModeRouteScopeId('/(app)/projects/workspace-1/git')).toBe('project:workspace-1');
    });

    it('decodes encoded scope ids and ignores query strings', () => {
        expect(resolvePaneFocusModeRouteScopeId('/session/session%201?tab=git')).toBe('session:session 1');
        expect(resolvePaneFocusModeRouteScopeId('/projects/workspace%201#files')).toBe('project:workspace 1');
    });

    it('returns null for routes without pane focus ownership', () => {
        expect(resolvePaneFocusModeRouteScopeId('/settings')).toBeNull();
        expect(resolvePaneFocusModeRouteScopeId('/')).toBeNull();
    });
});
