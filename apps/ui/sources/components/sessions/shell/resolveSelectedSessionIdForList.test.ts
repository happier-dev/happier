import { describe, expect, it } from 'vitest';

import { resolveSelectedSessionIdForList } from './resolveSelectedSessionIdForList';

describe('resolveSelectedSessionIdForList', () => {
    it('returns null when row selection is disabled or the pathname is not a session route', () => {
        expect(resolveSelectedSessionIdForList({ selectable: false, pathname: '/session/abc' })).toBeNull();
        expect(resolveSelectedSessionIdForList({ selectable: true, pathname: '/settings/profile' })).toBeNull();
    });

    it('extracts and decodes the session id from a session pathname', () => {
        expect(resolveSelectedSessionIdForList({
            selectable: true,
            pathname: '/session/folder%2Fsession-id/info',
        })).toBe('folder/session-id');
    });
});
