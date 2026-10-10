import { describe, expect, it } from 'vitest';

import { createSessionSurfaceNoteDocumentV1 } from '@happier-dev/protocol/sessions/board';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { resolveTranscriptSessionBoardItemReference } from './transcriptSessionBoardItemReference';

/**
 * The discriminating step of the Agent visualization journey.
 *
 * Mounting a live Board item beside a transcript row is only honest when the row
 * actually proves that item exists on THIS Home's Session. Everything here is a
 * way that proof can be absent while the row still looks convincing: an
 * unfinished call, a failure, a deferred approval, a lookalike tool from another
 * MCP server, and the same local Session id on a different Home.
 */

const REVISION = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const ADDRESS: SessionAddress = { serverId: 'home-a', sessionId: 'session-1' };

const UPSERT_TOOL = 'mcp__happier__session_board_item_upsert';

function noteItem(title = 'Release checklist') {
    return {
        v: 1 as const,
        title,
        frame: 'card' as const,
        height: { mode: 'auto' as const, fallback: 'regular' as const },
        source: {
            kind: 'declarative' as const,
            document: createSessionSurfaceNoteDocumentV1('- ship it'),
        },
    };
}

function upsertInput(overrides: Record<string, unknown> = {}) {
    return {
        itemId: 'item-1',
        expectedItemRevision: null,
        item: noteItem(),
        placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' as const },
        ...overrides,
    };
}

function appliedResult(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        serverId: ADDRESS.serverId,
        sessionId: ADDRESS.sessionId,
        result: {
            operation: 'upsert_item',
            itemId: 'item-1',
            outcome: 'created',
            itemRevision: REVISION,
            layoutRevision: REVISION,
        },
        destination: { tabId: 'overview', width: 'wide' },
        ...overrides,
    };
}

function resolve(overrides: Partial<Parameters<typeof resolveTranscriptSessionBoardItemReference>[0]> = {}) {
    return resolveTranscriptSessionBoardItemReference({
        toolName: UPSERT_TOOL,
        state: 'completed',
        input: upsertInput(),
        result: JSON.stringify(appliedResult()),
        address: ADDRESS,
        ...overrides,
    });
}

describe('resolveTranscriptSessionBoardItemReference', () => {
    it('references the exact item a completed Board upsert acknowledged', () => {
        expect(resolve()).toEqual({
            address: ADDRESS,
            itemId: 'item-1',
            itemRevision: REVISION,
            itemDestination: 'board',
            outcome: 'created',
            destination: { tabId: 'overview', width: 'wide' },
        });
    });

    it('accepts the executor envelope and the MCP content envelope the same way', () => {
        expect(resolve({ result: { ok: true, result: appliedResult() } })?.itemId).toBe('item-1');
        expect(resolve({
            result: { content: [{ type: 'text', text: JSON.stringify(appliedResult()) }] },
        })?.itemId).toBe('item-1');
        expect(resolve({
            result: { content: [{ type: 'text', text: 'ignored' }], structuredContent: appliedResult() },
        })?.itemId).toBe('item-1');
    });

    it('recognizes the first-party generic executor but never a foreign executor', () => {
        const input = { actionId: 'session.board.item.upsert', input: upsertInput() };
        const result = { ok: true, result: appliedResult() };
        expect(resolve({ toolName: 'mcp__happier__action_execute', input, result })?.itemId).toBe('item-1');
        expect(resolve({ toolName: 'mcp__acme__action_execute', input, result })).toBeNull();
    });

    it('uses preserved operands and acknowledgements from normalized tools, never truncated raw previews', () => {
        const meta = { v: 2, protocol: 'acp', provider: 'fixture', rawToolName: UPSERT_TOOL, canonicalToolName: UPSERT_TOOL };
        expect(resolve({
            input: { ...upsertInput(), _happier: meta, _raw: { itemId: 'wrong' }, _mcp: {}, _acp: {}, locations: [] },
            result: { value: JSON.stringify(appliedResult()), _happier: meta, _raw: '{truncated' },
        })?.itemId).toBe('item-1');
        expect(resolve({ input: { _happier: meta, _raw: upsertInput() } })).toBeNull();
    });

    it('accepts the direct Agent tool name and rejects a foreign server with the same trailing name', () => {
        expect(resolve({ toolName: 'session_board_item_upsert' })?.itemId).toBe('item-1');
        expect(resolve({ toolName: 'mcp__acme__session_board_item_upsert' })).toBeNull();
    });

    it('never references an item for another Home holding the same local Session id', () => {
        expect(resolve({ address: { serverId: 'home-b', sessionId: 'session-1' } })).toBeNull();
        expect(resolve({
            result: JSON.stringify(appliedResult({ serverId: 'home-b' })),
        })).toBeNull();
        expect(resolve({
            result: JSON.stringify(appliedResult({ sessionId: 'session-2' })),
        })).toBeNull();
    });

    it('requires an exact Home; a bare Session id is never enough', () => {
        expect(resolve({ address: null })).toBeNull();
    });

    it('ignores a call that has not truthfully committed an item', () => {
        expect(resolve({ state: 'running' })).toBeNull();
        expect(resolve({ state: 'error' })).toBeNull();
        expect(resolve({ result: null })).toBeNull();
        expect(resolve({ result: 'Created the board item for you.' })).toBeNull();
        expect(resolve({ result: '{"result":{"operation":"upsert_item"' })).toBeNull();
    });

    it('ignores typed failures, conflicts and ambiguous outcomes', () => {
        for (const errorCode of [
            'session_board_forbidden',
            'session_board_revision_conflict',
            'outcome_unknown',
            'feature_disabled',
        ]) {
            expect(resolve({ result: { ok: false, errorCode, error: errorCode } })).toBeNull();
        }
    });

    it('ignores a deferred approval continuation', () => {
        expect(resolve({
            result: {
                ok: true,
                result: {
                    kind: 'approval_request_created',
                    artifactId: 'artifact-1',
                    actionId: 'session.board.item.upsert',
                },
            },
        })).toBeNull();
    });

    it('ignores a result that does not acknowledge the invoked request', () => {
        expect(resolve({
            result: JSON.stringify(appliedResult({
                result: {
                    operation: 'upsert_item',
                    itemId: 'other-item',
                    outcome: 'created',
                    itemRevision: REVISION,
                    layoutRevision: REVISION,
                },
            })),
        })).toBeNull();
        // Creation was requested; an `updated` outcome contradicts the operand.
        expect(resolve({
            result: JSON.stringify(appliedResult({
                result: {
                    operation: 'upsert_item',
                    itemId: 'item-1',
                    outcome: 'updated',
                    itemRevision: REVISION,
                    layoutRevision: REVISION,
                },
            })),
        })).toBeNull();
    });

    it('mounts nothing for the Board intents that name no item', () => {
        expect(resolve({
            toolName: 'mcp__happier__session_board_layout_update',
            input: { expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } },
            result: JSON.stringify({
                v: 1,
                serverId: ADDRESS.serverId,
                sessionId: ADDRESS.sessionId,
                result: { operation: 'update_layout', outcome: 'created', layoutRevision: REVISION },
                destination: null,
            }),
        })).toBeNull();
        expect(resolve({
            toolName: 'mcp__happier__session_board_item_remove',
            input: { itemId: 'item-1', expectedItemRevision: REVISION, expectedLayoutRevision: REVISION },
            result: JSON.stringify({
                v: 1,
                serverId: ADDRESS.serverId,
                sessionId: ADDRESS.sessionId,
                result: { operation: 'remove_item', itemId: 'item-1', outcome: 'removed', layoutRevision: REVISION },
                destination: null,
            }),
        })).toBeNull();
        expect(resolve({ toolName: 'mcp__happier__session_board_get', input: {}, result: '{}' })).toBeNull();
    });

    it('mounts nothing for an unrelated tool call', () => {
        expect(resolve({ toolName: 'Read', input: { file_path: '/a' }, result: 'ok' })).toBeNull();
        expect(resolve({ toolName: 'mcp__happier__session_message_send' })).toBeNull();
    });

    it('reports an update without placement as a reference with no destination', () => {
        expect(resolve({
            input: upsertInput({ expectedItemRevision: REVISION, placement: undefined }),
            result: JSON.stringify(appliedResult({
                result: {
                    operation: 'upsert_item',
                    itemId: 'item-1',
                    outcome: 'updated',
                    itemRevision: REVISION,
                },
                destination: null,
            })),
        })).toEqual({
            address: ADDRESS,
            itemId: 'item-1',
            itemRevision: REVISION,
            itemDestination: 'board',
            outcome: 'updated',
            destination: null,
        });
    });
});
