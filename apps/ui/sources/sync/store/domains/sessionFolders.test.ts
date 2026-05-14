import { describe, expect, it } from 'vitest';

import { createSessionFoldersDomain, type SessionFoldersDomain } from './sessionFolders';

describe('createSessionFoldersDomain', () => {
    it('applies assignments by stable server-scoped session key', () => {
        let state: SessionFoldersDomain;
        const get = () => state;
        const set = (updater: Partial<SessionFoldersDomain> | ((current: SessionFoldersDomain) => Partial<SessionFoldersDomain>)) => {
            state = {
                ...state,
                ...(typeof updater === 'function' ? updater(state) : updater),
            };
        };

        state = createSessionFoldersDomain<SessionFoldersDomain>({ get, set });
        state.applySessionFolderAssignments('server-a', [
            { sessionId: 's1', folderId: 'folder-a' },
            { sessionId: 's2', folderId: null },
        ]);

        expect(state.sessionFolderAssignmentsBySessionKey).toEqual({
            'server-a:s1': 'folder-a',
            'server-a:s2': null,
        });
    });

    it('supports optimistic assignment rollback', () => {
        let state: SessionFoldersDomain;
        const get = () => state;
        const set = (updater: Partial<SessionFoldersDomain> | ((current: SessionFoldersDomain) => Partial<SessionFoldersDomain>)) => {
            state = {
                ...state,
                ...(typeof updater === 'function' ? updater(state) : updater),
            };
        };

        state = createSessionFoldersDomain<SessionFoldersDomain>({ get, set });
        state.applySessionFolderAssignments('server-a', [{ sessionId: 's1', folderId: 'folder-a' }]);

        const previous = state.setSessionFolderAssignmentOptimistic('server-a', 's1', 'folder-b');
        expect(previous).toBe('folder-a');
        expect(state.sessionFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-b');

        state.rollbackSessionFolderAssignment('server-a', 's1', previous);
        expect(state.sessionFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-a');
    });
});
