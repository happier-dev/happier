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

    it('collapses an agent marker path onto the current daemon workspace root', () => {
        const facts = resolveLocalServiceWorkspaceFactsFromSessionMarkers([
            {
                happySessionId: 'session-sandboxed',
                cwd: '/home/coder/project',
                metadata: {
                    path: '/home/coder/project',
                    sessionWorkspaceLocationV1: {
                        v: 1,
                        machineId: 'machine-local',
                        agentPath: '/home/coder/project',
                        machinePath: '/Users/alice/project',
                    },
                },
                respawn: { directory: '/Users/alice/project' },
            },
        ], 'machine-local');

        expect(facts).toEqual([{ path: '/Users/alice/project' }]);
    });
});
