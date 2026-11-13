import { describe, expect, it, vi } from 'vitest';

import type { SessionActionTarget } from './sessionActionTypes';
import { archiveSessionFamily } from './sessionArchiveFamily';

function target(sessionId: string): SessionActionTarget {
    return {
        session: { id: sessionId } as SessionActionTarget['session'],
        sessionId,
        serverId: 'home',
        isActive: false,
        isArchived: false,
        isConnected: false,
        hasStoppableTerminalHost: false,
        isPinned: false,
        isOwnedByCurrentUser: true,
        hasAdminAccess: false,
        canStop: false,
        canArchive: true,
        canRename: true,
        canResume: false,
        canDelete: true,
        canStopAndDelete: false,
        readStateAction: { kind: 'mark-unread', visible: true, targetState: 'unread' },
        attentionStandingAction: { kind: 'none', visible: false },
    };
}

describe('archiveSessionFamily', () => {
    it('stops linked child work, archives every descendant, then archives the selected parent', async () => {
        const parent = target('lead');
        const descendants = [target('researcher'), target('reviewer'), target('worker')];
        const events: string[] = [];

        const result = await archiveSessionFamily({
            parent,
            descendants,
            beforeArchiveDescendant: async (child) => {
                events.push(`stop:${child.sessionId}`);
            },
            archive: async (candidate) => {
                events.push(`archive:${candidate.sessionId}`);
            },
        });

        expect(events).toEqual([
            'stop:researcher',
            'archive:researcher',
            'stop:reviewer',
            'archive:reviewer',
            'stop:worker',
            'archive:worker',
            'archive:lead',
        ]);
        expect(result.archived.map((candidate) => candidate.sessionId)).toEqual([
            'researcher',
            'reviewer',
            'worker',
            'lead',
        ]);
        expect(result.failed).toEqual([]);
    });

    it('continues after child failures and reports the exact recoverable successes', async () => {
        const beforeArchiveDescendant = vi.fn(async (child: SessionActionTarget) => {
            if (child.sessionId === 'reviewer') throw new Error('run stop failed');
        });
        const archive = vi.fn(async (candidate: SessionActionTarget) => {
            if (candidate.sessionId === 'worker') throw new Error('archive failed');
        });

        const result = await archiveSessionFamily({
            parent: target('lead'),
            descendants: [target('reviewer'), target('worker')],
            beforeArchiveDescendant,
            archive,
        });

        expect(archive.mock.calls.map(([candidate]) => candidate.sessionId)).toEqual(['worker', 'lead']);
        expect(result.archived.map((candidate) => candidate.sessionId)).toEqual(['lead']);
        expect(result.failed.map(({ target: candidate, phase }) => [candidate.sessionId, phase])).toEqual([
            ['reviewer', 'stop-linked-run'],
            ['worker', 'archive'],
        ]);
    });
});
