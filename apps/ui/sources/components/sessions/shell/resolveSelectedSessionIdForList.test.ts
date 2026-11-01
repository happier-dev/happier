import { describe, expect, it } from 'vitest';

import { resolveSelectedSessionIdForList } from '@/sync/domains/session/listing/resolveSelectedSessionIdForList';

describe('resolveSelectedSessionIdForList', () => {
    it('extracts and decodes the session id from a session pathname', () => {
        const pathname = '/session/folder%2Fsession-id/info';

        const first = resolveSelectedSessionIdForList({
            selectable: true,
            pathname,
        });
        expect(first).toBe('folder/session-id');
    });

    it('returns null when row selection is disabled or the pathname is not a session route', () => {
        expect(resolveSelectedSessionIdForList({ selectable: false, pathname: '/session/abc' })).toBeNull();
        expect(resolveSelectedSessionIdForList({ selectable: true, pathname: '/settings/profile' })).toBeNull();
    });

    it('prefers the focused split-session id over the route pathname when provided', () => {
        expect(resolveSelectedSessionIdForList({
            selectable: true,
            pathname: '/session/route-session/info',
            focusedSessionId: 'focused-session',
        } as never)).toBe('focused-session');
    });
});
