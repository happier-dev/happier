import { describe, expect, it } from 'vitest';
import type { BoardItemRefV1 } from '@happier-dev/protocol';

import type { BoardCard } from './boardCards';
import { resolveBoardCardOpenTarget } from './boardCardOpenTarget';

function card(kind: BoardItemRefV1['kind'], bucket: BoardCard['status']['bucket'], availability: BoardCard['availability'] = 'ready'): BoardCard {
    return {
        key: `${kind}:x`,
        ref: { kind, qualifiedId: { serverId: 'home-a', id: 'x' } },
        picked: true,
        availability,
        title: 'x',
        status: { bucket, tone: bucket === 'needs_you' ? 'attention' : 'neutral', word: bucket },
        body: { kind: 'none' },
    };
}

describe('resolveBoardCardOpenTarget', () => {
    it('sends needs-you work to its Inbox item, never to the session or run where a card could answer it', () => {
        expect(resolveBoardCardOpenTarget(card('session', 'needs_you'), { inboxAvailable: true }))
            .toEqual({ kind: 'inbox', item: { kind: 'session', serverId: 'home-a', id: 'x' } });
        expect(resolveBoardCardOpenTarget(card('workflow_run', 'needs_you'), { inboxAvailable: true }))
            .toEqual({ kind: 'inbox', item: { kind: 'workflow_run', serverId: 'home-a', id: 'x' } });
    });

    it('opens other work where it lives', () => {
        expect(resolveBoardCardOpenTarget(card('session', 'working'), { inboxAvailable: true }))
            .toEqual({ kind: 'item', ref: { kind: 'session', qualifiedId: { serverId: 'home-a', id: 'x' } } });
        expect(resolveBoardCardOpenTarget(card('machine', 'needs_you'), { inboxAvailable: true }))
            .toEqual({ kind: 'item', ref: { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'x' } } });
    });

    it('opens nothing for an item whose Home is not connected', () => {
        expect(resolveBoardCardOpenTarget(card('session', 'offline', 'home_unavailable'), { inboxAvailable: true })).toBeNull();
    });
});
