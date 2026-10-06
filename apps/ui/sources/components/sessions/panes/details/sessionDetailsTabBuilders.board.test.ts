import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import {
    createSessionBoardDetailsTab,
    createSessionDiscussionDetailsTab,
} from './sessionDetailsTabBuilders';

describe('createSessionBoardDetailsTab', () => {
    it('uses one stable Details destination for the whole Board', () => {
        expect(createSessionBoardDetailsTab()).toEqual({
            key: 'board',
            kind: 'board',
            title: t('sessionBoard.title'),
            resource: { kind: 'board' },
        });
    });

    it('gives a selected item its own destination so opening one never replaces another', () => {
        // A single hardcoded `board` key makes the second "Open in Details" reuse
        // the first tab's destination, and the written itemId is then discarded.
        expect(createSessionBoardDetailsTab({ kind: 'item', itemId: 'note-1' })).toEqual({
            key: 'board:note-1',
            kind: 'board',
            title: t('sessionBoard.title'),
            resource: { kind: 'board', focusTarget: { kind: 'item', itemId: 'note-1' } },
        });
        expect(createSessionBoardDetailsTab({ kind: 'item', itemId: 'note-2' }).key)
            .not.toBe(createSessionBoardDetailsTab({ kind: 'item', itemId: 'note-1' }).key);
    });
});

describe('createSessionDiscussionDetailsTab', () => {
    it('keys draft and persisted discussions by the opaque exact-Home Session address', () => {
        const address = { serverId: 'https://home.example:444', sessionId: 'session:shared' } as const;

        expect(createSessionDiscussionDetailsTab({ kind: 'new', address })).toEqual({
            key: 'discussion:["https://home.example:444","session:shared"]:new',
            kind: 'discussion',
            title: t('session.collaboration.discussion.newDiscussion'),
            resource: { kind: 'discussion', target: { kind: 'new', address } },
        });
        expect(createSessionDiscussionDetailsTab({
            kind: 'discussion',
            address,
            discussionId: 'discussion:1',
            title: 'Release readiness',
        })).toEqual({
            key: 'discussion:["https://home.example:444","session:shared"]:discussion:1',
            kind: 'discussion',
            title: 'Release readiness',
            resource: {
                kind: 'discussion',
                target: {
                    kind: 'discussion',
                    address,
                    discussionId: 'discussion:1',
                },
            },
        });
    });
});
