import { describe, expect, it } from 'vitest';

import { resolveLocalServiceWorkspaceFactsFromSessionMarkers } from './workspaces';

describe('resolveLocalServiceWorkspaceFactsFromSessionMarkers', () => {
    it('collects deduped absolute workspace roots from daemon-owned session marker facts', () => {
        const facts = resolveLocalServiceWorkspaceFactsFromSessionMarkers([
            { happySessionId: 'session-a', cwd: ' /repo/app ' },
            { happySessionId: 'session-b', metadata: { path: '/repo/app' } },
            { happySessionId: 'session-c', metadata: { path: '' } },
            { happySessionId: 'session-d', cwd: 'relative/path' },
        ]);

        expect(facts).toEqual([{ path: '/repo/app' }]);
    });
});
