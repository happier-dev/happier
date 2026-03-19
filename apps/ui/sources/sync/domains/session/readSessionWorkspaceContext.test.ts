import { describe, expect, it } from 'vitest';

import { readSessionWorkspaceContext } from './readSessionWorkspaceContext';

describe('readSessionWorkspaceContext', () => {
    it('reads the session workspace path from metadata without surfacing legacy workspace identifiers', () => {
        const context = readSessionWorkspaceContext({
            sessions: {
                s1: {
                    metadata: {
                        path: '/repo/.worktrees/feature-auth',
                        workspaceId: 'ws_payments',
                        workspaceLocationId: 'loc_local',
                        workspaceCheckoutId: 'checkout_feature_auth',
                    },
                },
            },
        } as any, 's1');

        expect(context).toEqual({
            workspacePath: '/repo/.worktrees/feature-auth',
            projectPath: null,
            projectMachineId: null,
        });
    });

    it('falls back to project path and machine when session metadata path is unavailable', () => {
        const context = readSessionWorkspaceContext({
            sessions: {
                s1: {
                    metadata: {
                        path: null,
                        workspaceId: null,
                    },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 's1'
                ? { key: { machineId: 'machine-a', path: '/repo' } }
                : null,
        } as any, 's1');

        expect(context).toEqual({
            workspacePath: '/repo',
            projectPath: '/repo',
            projectMachineId: 'machine-a',
        });
    });

    it('ignores legacy workspace identifiers when resolving the workspace path', () => {
        const context = readSessionWorkspaceContext({
            sessions: {
                s1: {
                    metadata: {
                        path: '/repo',
                        workspaceId: ' ',
                        workspaceLocationId: '',
                        workspaceCheckoutId: '   ',
                    },
                },
            },
        } as any, 's1');

        expect(context).toEqual({
            workspacePath: '/repo',
            projectPath: null,
            projectMachineId: null,
        });
    });
});
