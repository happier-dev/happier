import { describe, expect, it } from 'vitest';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { isHostAuthoredInputMeta, readDiscussionInputOrigin, readHostDiscussionInputMeta, readHostFollowInputMeta } from './hostAuthoredInput';

describe('host input identity', () => {
    const follow = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
        original: { sourceSessionId: 'worker', sourceTurn: { id: 'turn-1', status: 'completed' } },
        event: { kind: 'finished' } });
    const meta = { happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
        happierInputRequestV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
            permission: {}, followDeliveryV1: follow } };

    it('recognizes pending Follow from the separate Home admission projection before settlement', () => {
        expect(isHostAuthoredInputMeta(meta, follow)).toBe(true);
        expect(readHostFollowInputMeta(meta, follow)).toEqual(follow);
    });

    it('does not trust a pending request or a host-looking field inside authored metadata', () => {
        expect(isHostAuthoredInputMeta({ ...meta, hostFollowInput: follow })).toBe(false);
        expect(readHostFollowInputMeta(meta)).toBeNull();
    });

    it('preserves settled host recognition without requiring the pending projection', () => {
        const { happierInputRequestV1: request, ...rest } = meta;
        const settled = { ...rest, happierInputAuthorityV1: { ...request,
            permission: { admittedPermissionCeiling: 'default' } } };
        expect(isHostAuthoredInputMeta(settled)).toBe(true);
        expect(readHostFollowInputMeta(settled)).toEqual(follow);
    });

    it('treats a host-relayed Discussion message as its author’s words, not a host notice', () => {
        const discussionAddressing = { discussionId: 'discussion-1', messageId: 'message-1', throughSeq: 1, participantSessionId: 'receiver' };
        const relayed = { happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
            happierInputAuthorityV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                permission: { admittedPermissionCeiling: 'default' }, replyIntent: { mode: 'return' }, discussionAddressing } };
        expect(isHostAuthoredInputMeta(relayed)).toBe(false);
        expect(readHostDiscussionInputMeta(relayed)).toEqual(discussionAddressing);
        // Authored metadata alone never claims a Discussion origin.
        expect(readHostDiscussionInputMeta({ discussionAddressing })).toBeNull();
    });

    describe('Discussion delivery origin', () => {
        const discussionAddressing = { discussionId: 'discussion-1', messageId: 'message-1', throughSeq: 1, participantSessionId: 'receiver' };
        const authority = { v: 1, producer: 'sessionAction', permission: { admittedPermissionCeiling: 'default' },
            replyIntent: { mode: 'return' }, discussionAddressing };

        it('names the Discussion alone when the viewer delivered it', () => {
            const selfSent = { happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
                happierInputAuthorityV1: { ...authority, caller: { kind: 'host' } } };
            expect(readDiscussionInputOrigin(selfSent)).toEqual({ discussionId: 'discussion-1', senderSessionId: null });
        });

        it('names the sending Session and the Discussion when another Session delivered it', () => {
            const agentSent = { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'action' },
                happierInputAuthorityV1: { ...authority, sourceSession: { sourceSessionId: 'sender', sourceTurnId: 'turn-1',
                    sourceInputId: 'input-1', via: 'action' }, discussionAddressing: { ...discussionAddressing, participantSessionId: 'sender' } } };
            expect(readDiscussionInputOrigin(agentSent)).toEqual({ discussionId: 'discussion-1', senderSessionId: 'sender' });
        });

        it('is absent for a Session message that carries no Discussion addressing', () => {
            const plain = { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'mcp' },
                happierInputAuthorityV1: { v: 1, producer: 'happierMcp', permission: { admittedPermissionCeiling: 'default' },
                    sourceSession: { sourceSessionId: 'sender', sourceTurnId: 'turn-1', via: 'mcp' } } };
            expect(readDiscussionInputOrigin(plain)).toBeNull();
            // Authored metadata alone never claims a Discussion origin.
            expect(readDiscussionInputOrigin({ discussionAddressing })).toBeNull();
        });
    });
});
