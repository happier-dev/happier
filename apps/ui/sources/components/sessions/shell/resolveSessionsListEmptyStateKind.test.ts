import { describe, expect, it } from 'vitest';

import { resolveSessionsListEmptyStateKind } from './resolveSessionsListEmptyStateKind';

describe('resolveSessionsListEmptyStateKind', () => {
    it('routes an empty External filter to the external-session guidance', () => {
        expect(resolveSessionsListEmptyStateKind('create_session', 'direct')).toBe('external');
        expect(resolveSessionsListEmptyStateKind('loading', 'direct')).toBe('external');
    });

    it('keeps All and Happier filters on the ordinary session guidance', () => {
        expect(resolveSessionsListEmptyStateKind('create_session', 'all')).toBe('create_session');
        expect(resolveSessionsListEmptyStateKind('connect_machine', 'persisted')).toBe('connect_machine');
        expect(resolveSessionsListEmptyStateKind('loading', 'all')).toBeNull();
    });
});
