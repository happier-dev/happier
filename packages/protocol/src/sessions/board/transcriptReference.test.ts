import { describe, expect, it } from 'vitest';
import { isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1, isTranscriptSessionBoardItemReplyCallV1, resolveTranscriptSessionBoardItemReferenceV1 } from './transcriptReference.js';

const sourceAddress = { serverId: 'source-home', sessionId: 'parent' };
const acknowledgedReference = {
    address: sourceAddress, itemId: 'first', itemRevision: 'original-revision',
    outcome: 'created' as const, destination: null, itemDestination: 'board' as const,
};
const publishedReference = {
    v: 1 as const, itemId: 'child-copy', itemRevision: 'child-revision', sourceAddress,
    sourceItemId: 'first', sourceItemRevision: 'original-revision',
};

describe('Ask visual reply grouping', () => {
    it.each(['direct tool', 'action_execute'] as const)('uses validated creation destination for %s without defaulting updates', transport => {
        const create = { itemId: 'note', expectedItemRevision: null,
            item: { v: 1, title: 'Note', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Note' } } } } };
        const receipt = { kind: 'approval_request_created', artifactId: 'approval', actionId: 'session.board.item.upsert' };
        const isReply = (input: unknown) => isTranscriptSessionBoardItemReplyCallV1({
            toolName: transport === 'direct tool' ? 'session_board_item_upsert' : 'mcp__happier__action_execute', state: 'completed',
            input: transport === 'direct tool' ? input : { actionId: 'session.board.item.upsert', input: JSON.stringify(input) },
            result: transport === 'direct tool' ? { ok: true, result: receipt } : receipt,
        });

        expect(isReply(create)).toBe(true);
        expect(isReply({ ...create, destination: 'transcript' })).toBe(true);
        expect(isReply({ ...create, destination: 'both', placement: {} })).toBe(true);
        expect(isReply({ ...create, destination: 'board', placement: {} })).toBe(false);
        expect(isReply({ ...create, placement: {} })).toBe(false);
        const update = { ...create, expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' };
        expect(isReply(update)).toBe(false);
        expect(isReply({ ...update, destination: 'transcript' })).toBe(true);
        expect(isReply({ ...create, destination: 'transcript', item: null })).toBe(false);
    });
});

describe('cross-device transcript visual Home binding', () => {
    it('admits two profile identifiers only with the same canonical Home proof and retains the viewer address', () => {
        const address = { serverId: 'viewer-profile', sessionId: 'session' };
        const input = { itemId: 'note', expectedItemRevision: null, destination: 'transcript',
            item: { v: 1, title: 'Note', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Note' } } } } };
        const result = { v: 1, serverId: 'daemon-profile', sessionId: 'session', itemDestination: 'transcript', destination: null,
            result: { operation: 'upsert_item', itemId: 'note', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', outcome: 'created' } };
        // Profile storage is supplied by the host, never inferred from tool output or URLs.
        const scopes: Readonly<Record<string, string>> = { 'viewer-profile': 'srv_home_a', 'daemon-profile': 'srv_home_a',
            srv_home_a: 'srv_home_a', 'foreign-profile': 'srv_home_b' };
        const args = { toolName: 'session_board_item_upsert', state: 'completed', input, result, address,
            resolveServerScopeId: (id: string) => scopes[id] ?? null };
        expect(resolveTranscriptSessionBoardItemReferenceV1(args)).toMatchObject({ address, itemId: 'note' });
        expect(resolveTranscriptSessionBoardItemReferenceV1({ ...args, result: { ...result, serverId: 'srv_home_a' } }))
            .toMatchObject({ address, itemId: 'note' });
        expect(resolveTranscriptSessionBoardItemReferenceV1({ ...args, result: { ...result, serverId: 'foreign-profile' } })).toBeNull();
        expect(resolveTranscriptSessionBoardItemReferenceV1({ ...args, result: { ...result, serverId: 'unknown-profile' } })).toBeNull();
        expect(resolveTranscriptSessionBoardItemReferenceV1({ ...args, result: { ...result, sessionId: 'another-session' } })).toBeNull();
        expect(resolveTranscriptSessionBoardItemReferenceV1({ ...args, resolveServerScopeId: undefined })).toBeNull();
    });
});

describe('published transcript visual correspondence', () => {
    it('selects the exact original item and revision among copied siblings sharing a source', () => {
        const input = { acknowledgedReference, publishedReference, publishedSessionId: 'child' };
        expect(isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1(input)).toBe(true);
        expect(isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({ ...input,
            publishedReference: { ...publishedReference, sourceItemId: 'second' },
        })).toBe(false);
        expect(isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({ ...input,
            publishedReference: { ...publishedReference, sourceItemRevision: 'another-revision' },
        })).toBe(false);
    });

    it('matches an explicitly identified legacy copied acknowledgement without fabricating its revision', () => {
        expect(isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({
            acknowledgedReference: { ...acknowledgedReference, itemRevision: null },
            publishedReference: { ...publishedReference, sourceItemRevision: null },
            publishedSessionId: 'child',
        })).toBe(true);
    });

    it('retains exact direct singleton reads but never guesses the origin of a legacy child association', () => {
        const { sourceItemId: _sourceItemId, sourceItemRevision: _sourceItemRevision, ...legacy } = publishedReference;
        expect(isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({
            acknowledgedReference, publishedReference: legacy, publishedSessionId: 'child',
        })).toBe(false);
        const direct = { ...legacy, itemId: 'first', itemRevision: 'original-revision' };
        expect(isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({
            acknowledgedReference: { ...acknowledgedReference, itemDestination: 'transcript' },
            publishedReference: direct, publishedSessionId: 'parent',
        })).toBe(true);
        expect(isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({
            acknowledgedReference, publishedReference: direct, publishedSessionId: 'parent',
        })).toBe(false);
    });
});

describe('Claude ACP tool-result envelope', () => {
    it('recognizes a generic action_execute acknowledgement whose content is the JSON text itself', () => {
        // Stored shape of a real Claude `mcp__happier__action_execute` result (QA-LIVE-2, seq 55).
        const ack = JSON.stringify({ v: 1, serverId: 'srv_home', sessionId: 'session', itemDestination: 'transcript', destination: null,
            result: { operation: 'upsert_item', itemId: 'chart', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', outcome: 'created' } });
        const meta = { v: 2, protocol: 'acp', provider: 'claude', rawToolName: 'mcp__happier__action_execute', canonicalToolName: 'mcp__happier__action_execute' };
        const item = { v: 1, title: 'Chart', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Chart' } } } };
        const input = { actionId: 'session.board.item.upsert', input: { sessionId: 'session', itemId: 'chart', expectedItemRevision: null, destination: 'transcript', item },
            _mcp: { serverId: 'happier', toolId: 'action_execute' }, _happier: meta };
        const result = { content: ack, tool_use_result: [{ type: 'text', text: ack }], text: ack,
            _mcp: { serverId: 'happier', toolId: 'action_execute' }, _happier: meta, _raw: { content: ack } };
        expect(resolveTranscriptSessionBoardItemReferenceV1({
            toolName: 'mcp__happier__action_execute', state: 'completed', input, result,
            address: { serverId: 'srv_home', sessionId: 'session' }, resolveServerScopeId: (id: string) => id,
        })).toMatchObject({ itemId: 'chart', itemDestination: 'transcript' });
    });
});
