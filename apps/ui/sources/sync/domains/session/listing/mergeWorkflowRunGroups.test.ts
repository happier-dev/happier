import { describe, expect, it } from 'vitest';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { mergeWorkflowRunGroups, type WorkflowRunGroup } from './mergeWorkflowRunGroups';

describe('mergeWorkflowRunGroups', () => {
    it('visits groups linearly without rescanning inserted Runs', () => {
        let visits = 0;
        const sessions: SessionListIndexItem[] = Array.from({ length: 1_000 }, (_, index) => ({
            type: 'session', serverId: 'home', sessionId: `session-${index}`,
            get groupKey() { visits += 1; return 'project'; },
        }));
        const runs: WorkflowRunGroup['rows'] = Array.from({ length: 1_000 }, (_, index) => ({
            type: 'workflow_run', serverId: 'home', runId: `run-${index}`,
            get groupKey() { visits += 1; return 'project'; },
        }));
        expect(mergeWorkflowRunGroups(sessions, new Map())).toBe(sessions);
        expect(visits).toBe(0);
        const result = mergeWorkflowRunGroups(sessions, new Map<string, WorkflowRunGroup>([['project', {
            header: { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project' }, rows: runs,
        }]]));
        expect(visits).toBeLessThanOrEqual(2 * (sessions.length + runs.length));
        expect(result).toHaveLength(sessions.length + runs.length);
        for (let index = 0; index < result.length; index += 1) {
            expect(result[index]).toBe(index < sessions.length ? sessions[index] : runs[index - sessions.length]);
        }
    });

    it('inserts after the final occurrence and fills empty existing headers without moving any source item', () => {
        const items: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'First', groupKey: 'a' },
            { type: 'session', sessionId: 'first', serverId: 'home', groupKey: 'a' },
            { type: 'header', headerKind: 'project', title: 'Empty', groupKey: 'empty' },
            { type: 'header', headerKind: 'project', title: 'Last', groupKey: 'a' },
            { type: 'session', sessionId: 'last', serverId: 'home', groupKey: 'a' },
            { type: 'session', sessionId: 'ungrouped', serverId: 'home' },
        ];
        const groups = new Map<string, WorkflowRunGroup>(['a', 'empty', 'new'].map((groupKey): [string, WorkflowRunGroup] => [groupKey, {
            header: { type: 'header', headerKind: 'project', title: groupKey, groupKey },
            rows: [{ type: 'workflow_run', runId: groupKey, serverId: 'home', groupKey }],
        }]));
        const result = mergeWorkflowRunGroups(items, groups);
        expect(result).toEqual([
            items[0], items[1], items[2], groups.get('empty')!.rows[0],
            items[3], items[4], groups.get('a')!.rows[0], items[5],
            groups.get('new')!.header, groups.get('new')!.rows[0],
        ]);
        expect(result.filter(item => item.type !== 'workflow_run' && item !== groups.get('new')!.header))
            .toEqual(items);
    });
});
