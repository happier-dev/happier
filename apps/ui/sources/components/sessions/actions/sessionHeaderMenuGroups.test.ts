import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import {
    SESSION_ACTION_ARCHIVE_ID, SESSION_ACTION_MAKE_BOT_ID, SESSION_ACTION_MAKE_REGULAR_ID, SESSION_ACTION_RENAME_ID, SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_TALK_ID, SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID, SESSION_ACTION_WORK_OPEN_ID,
} from './sessionActionIds';
import { getSessionActionMetadata } from './sessionActionMetadata';
import { composeSessionHeaderMenu } from './sessionHeaderMenuGroups';

describe('session header menu groups', () => {
    it('reads as groups in one order — open, this session, work, finish — whatever order the producers ran in', () => {
        const items = composeSessionHeaderMenu([
            { group: 'work', item: { id: 'review.start', title: 'Start review' } },
            { group: 'finish', item: { id: 'archive', title: 'Archive session' } },
            { group: 'session', item: { id: 'rename', title: 'Rename session' } },
            { group: 'open', item: { id: 'find', title: 'Find in chat' } },
            { group: 'work', item: { id: 'plan', title: 'Start plan run' } },
        ]);
        expect(items.map((item) => item.id)).toEqual(['find', 'rename', 'review.start', 'plan', 'archive']);
        // The first group needs no label; each later one names itself, and no two groups share a label.
        const labels = items.map((item) => item.category ?? '');
        expect(labels[0]).toBe('');
        expect(labels[1]).toBe(t('session.actionMenu.groups.session'));
        expect(labels[2]).toBe(labels[3]);
        expect(new Set(labels).size).toBe(4);
    });

    it('closes the menu with every destructive operation, wherever its producer filed it', () => {
        const items = composeSessionHeaderMenu([
            { group: 'open', item: { id: 'extra.delete', title: 'Delete draft', destructive: true } },
            { group: 'open', item: { id: 'find', title: 'Find in chat' } },
        ]);
        expect(items.map((item) => item.id)).toEqual(['find', 'extra.delete']);
        expect(items[1]!.category).toBe(t('session.actionMenu.groups.finish'));
    });

    it('sets how the session behaves (bot or regular, its tool calls) apart from naming it, before the work it starts', () => {
        const items = composeSessionHeaderMenu([
            { group: 'work', item: { id: 'review.start', title: 'Start review' } },
            { group: 'behavior', item: { id: 'promote', title: 'Make this a bot' } },
            { group: 'behavior', item: { id: 'tools', title: 'Show tool calls' } },
            { group: 'session', item: { id: 'rename', title: 'Rename session' } },
            { group: 'session', item: { id: 'talk', title: 'Talk to this session' } },
        ]);
        expect(items.map((item) => item.id)).toEqual(['rename', 'talk', 'promote', 'tools', 'review.start']);
        expect(items[2]!.category).toBe(t('session.actionMenu.groups.behavior'));
        expect(items[2]!.category).toBe(items[3]!.category);
        expect(items[2]!.category).not.toBe(items[4]!.category);
        for (const id of [SESSION_ACTION_MAKE_BOT_ID, SESSION_ACTION_MAKE_REGULAR_ID, SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID]) {
            expect(getSessionActionMetadata(id)?.group).toBe('behavior');
        }
        expect(getSessionActionMetadata(SESSION_ACTION_TALK_ID)?.group).toBe('session');
    });

    it('files each session operation under the group its metadata owner names', () => {
        expect(getSessionActionMetadata(SESSION_ACTION_WORK_OPEN_ID)?.group).toBe('open');
        expect(getSessionActionMetadata(SESSION_ACTION_RENAME_ID)?.group).toBe('session');
        expect(getSessionActionMetadata(SESSION_ACTION_RESUME_ID)?.group).toBe('work');
        expect(getSessionActionMetadata(SESSION_ACTION_ARCHIVE_ID)?.group).toBe('finish');
    });
});
