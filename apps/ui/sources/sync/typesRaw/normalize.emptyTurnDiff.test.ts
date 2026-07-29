import { describe, expect, it } from 'vitest';

import {
    createRawMessageNormalizationSequenceState,
    normalizeRawMessage,
    normalizeRawMessageInSequence,
    normalizeRawMessages,
    type RawMessageNormalizationInput,
} from './normalize';

function createEmptyTurnDiffInput() {
    return {
        files: [],
        _happier: {
            sessionChangeScope: 'turn',
            workspaceMutationSignal: 'turn-change-set',
            turnId: 'turn-1',
            sessionId: 'session-1',
            provider: 'codex',
            rawToolName: 'RepositoryCheckpointDiff',
            canonicalToolName: 'Diff',
            source: 'scm_checkpoint',
            confidence: 'exact',
            turnStatus: 'completed',
            seqRange: {
                startSeqInclusive: 1,
                endSeqInclusive: 1,
            },
        },
    };
}

describe('normalizeRawMessage empty canonical turn diff tools', () => {
    it('drops Codex-shaped empty canonical turn diff tool calls', () => {
        const normalized = normalizeRawMessage(
            'message-1',
            null,
            1_700,
            {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        callId: 'diff-1',
                        name: 'Diff',
                        input: createEmptyTurnDiffInput(),
                        id: 'tool-call-1',
                    },
                    provider: 'codex',
                },
            },
        );

        expect(normalized).toBeNull();
    });

    it('drops ACP-shaped empty canonical turn diff tool calls after JSON input parsing', () => {
        const normalized = normalizeRawMessage(
            'message-2',
            null,
            1_701,
            {
                role: 'agent',
                content: {
                    type: 'acp',
                    data: {
                        type: 'tool-call',
                        callId: 'diff-2',
                        name: 'Diff',
                        input: JSON.stringify(createEmptyTurnDiffInput()),
                        id: 'tool-call-2',
                    },
                    agentId: 'codex',
                },
            },
        );

        expect(normalized).toBeNull();
    });

    it('preserves canonical turn diff tool calls with file evidence', () => {
        const input = {
            ...createEmptyTurnDiffInput(),
            files: [{
                file_path: 'src/app.ts',
                change_kind: 'modified',
                unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
            }],
        };

        const normalized = normalizeRawMessage(
            'message-3',
            null,
            1_702,
            {
                role: 'agent',
                content: {
                    type: 'acp',
                    data: {
                        type: 'tool-call',
                        callId: 'diff-3',
                        name: 'Diff',
                        input,
                        id: 'tool-call-3',
                    },
                    agentId: 'codex',
                },
            },
        );

        expect(normalized?.role).toBe('agent');
        expect(normalized?.content).toEqual([
            expect.objectContaining({
                type: 'tool-call',
                id: 'diff-3',
                name: 'Diff',
            }),
        ]);
    });

    it('drops standalone empty canonical v2 turn diff results without a preceding tool call', () => {
        const standaloneResult = {
            status: 'completed',
            files: [],
            _happier: {
                canonicalToolName: 'Diff',
            },
        };

        const normalized = normalizeRawMessages([{
            id: 'message-standalone-result',
            localId: null,
            createdAt: 1_703,
            raw: {
                role: 'agent',
                content: {
                    type: 'acp',
                    data: {
                        type: 'tool-result',
                        callId: 'standalone-empty-diff',
                        output: JSON.stringify(standaloneResult),
                        id: 'tool-result-standalone-empty-diff',
                    },
                    agentId: 'codex',
                },
            },
        }]);

        expect(normalized).toEqual([]);
    });

    it('drops legacy Codex-shaped empty canonical turn diff call/result pairs', () => {
        const messages = [
            {
                id: 'message-codex-call',
                localId: null,
                createdAt: 1_703,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId: 'diff-codex-empty',
                            name: 'Diff',
                            input: createEmptyTurnDiffInput(),
                            id: 'tool-call-codex',
                        },
                        provider: 'codex',
                    },
                },
            },
            {
                id: 'message-codex-result',
                localId: null,
                createdAt: 1_704,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'diff-codex-empty',
                            output: { status: 'completed', files: [] },
                            id: 'tool-result-codex',
                        },
                        provider: 'codex',
                    },
                },
            },
        ] satisfies readonly RawMessageNormalizationInput[];

        expect(normalizeRawMessages(messages)).toEqual([]);
    });

    it('drops legacy ACP-shaped empty canonical turn diff call/result pairs', () => {
        const messages = [
            {
                id: 'message-acp-call',
                localId: null,
                createdAt: 1_705,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        data: {
                            type: 'tool-call',
                            callId: 'diff-acp-empty',
                            name: 'Diff',
                            input: JSON.stringify(createEmptyTurnDiffInput()),
                            id: 'tool-call-acp',
                        },
                        agentId: 'codex',
                    },
                },
            },
            {
                id: 'message-acp-result',
                localId: null,
                createdAt: 1_706,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        data: {
                            type: 'tool-result',
                            callId: 'diff-acp-empty',
                            output: JSON.stringify({ status: 'completed', files: [] }),
                            id: 'tool-result-acp',
                        },
                        agentId: 'codex',
                    },
                },
            },
        ] satisfies readonly RawMessageNormalizationInput[];

        expect(normalizeRawMessages(messages)).toEqual([]);
    });

    it('prunes suppressed empty canonical turn diff call ids after filtering their empty result', () => {
        const state = createRawMessageNormalizationSequenceState();

        expect(normalizeRawMessageInSequence({
            id: 'message-state-call',
            localId: null,
            createdAt: 1_706,
            raw: {
                role: 'agent',
                content: {
                    type: 'acp',
                    data: {
                        type: 'tool-call',
                        callId: 'diff-state-empty',
                        name: 'Diff',
                        input: JSON.stringify(createEmptyTurnDiffInput()),
                        id: 'tool-call-state-empty',
                    },
                    agentId: 'codex',
                },
            },
        }, state)).toBeNull();

        expect(state.suppressedEmptyCanonicalTurnDiffCallIds.has('diff-state-empty')).toBe(true);

        expect(normalizeRawMessageInSequence({
            id: 'message-state-result',
            localId: null,
            createdAt: 1_707,
            raw: {
                role: 'agent',
                content: {
                    type: 'acp',
                    data: {
                        type: 'tool-result',
                        callId: 'diff-state-empty',
                        output: JSON.stringify({ status: 'completed', files: [] }),
                        id: 'tool-result-state-empty',
                    },
                    agentId: 'codex',
                },
            },
        }, state)).toBeNull();

        expect(state.suppressedEmptyCanonicalTurnDiffCallIds.has('diff-state-empty')).toBe(false);
    });

    it('bounds suppressed empty canonical turn diff call ids while preserving newest suppression entries', () => {
        const state = createRawMessageNormalizationSequenceState();

        for (let index = 0; index < 300; index += 1) {
            const callId = `diff-state-bounded-${index}`;
            expect(normalizeRawMessageInSequence({
                id: `message-bounded-call-${index}`,
                localId: null,
                createdAt: 1_800 + index,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId,
                            name: 'Diff',
                            input: createEmptyTurnDiffInput(),
                            id: `tool-call-bounded-${index}`,
                        },
                        provider: 'codex',
                    },
                },
            }, state)).toBeNull();
        }

        expect(state.suppressedEmptyCanonicalTurnDiffCallIds.size).toBeLessThanOrEqual(256);
        expect(state.suppressedEmptyCanonicalTurnDiffCallIds.has('diff-state-bounded-0')).toBe(false);
        expect(state.suppressedEmptyCanonicalTurnDiffCallIds.has('diff-state-bounded-299')).toBe(true);
    });

    it('preserves canonical turn diff call/result pairs with file evidence', () => {
        const input = {
            ...createEmptyTurnDiffInput(),
            files: [{
                file_path: 'src/app.ts',
                change_kind: 'modified',
                unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
            }],
        };
        const messages = [
            {
                id: 'message-evidence-call',
                localId: null,
                createdAt: 1_707,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        data: {
                            type: 'tool-call',
                            callId: 'diff-evidence',
                            name: 'Diff',
                            input,
                            id: 'tool-call-evidence',
                        },
                        agentId: 'codex',
                    },
                },
            },
            {
                id: 'message-evidence-result',
                localId: null,
                createdAt: 1_708,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        data: {
                            type: 'tool-result',
                            callId: 'diff-evidence',
                            output: { status: 'completed' },
                            id: 'tool-result-evidence',
                        },
                        agentId: 'codex',
                    },
                },
            },
        ] satisfies readonly RawMessageNormalizationInput[];

        const normalized = normalizeRawMessages(messages);

        expect(normalized).toHaveLength(2);
        expect(normalized[0]?.content).toEqual([
            expect.objectContaining({
                type: 'tool-call',
                id: 'diff-evidence',
                name: 'Diff',
            }),
        ]);
        expect(normalized[1]?.content).toEqual([
            expect.objectContaining({
                type: 'tool-result',
                tool_use_id: 'diff-evidence',
            }),
        ]);
    });

    it('preserves legacy canonical turn diff results with file evidence even when the empty call is dropped', () => {
        const result = {
            ...createEmptyTurnDiffInput(),
            files: [{
                file_path: 'src/result.ts',
                change_kind: 'modified',
                unified_diff: 'diff --git a/src/result.ts b/src/result.ts\n--- a/src/result.ts\n+++ b/src/result.ts\n@@ -1 +1 @@\n-before\n+after\n',
            }],
        };
        const messages = [
            {
                id: 'message-result-evidence-call',
                localId: null,
                createdAt: 1_709,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        data: {
                            type: 'tool-call',
                            callId: 'diff-result-evidence',
                            name: 'Diff',
                            input: JSON.stringify(createEmptyTurnDiffInput()),
                            id: 'tool-call-result-evidence',
                        },
                        agentId: 'codex',
                    },
                },
            },
            {
                id: 'message-result-evidence-result',
                localId: null,
                createdAt: 1_710,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        data: {
                            type: 'tool-result',
                            callId: 'diff-result-evidence',
                            output: JSON.stringify(result),
                            id: 'tool-result-result-evidence',
                        },
                        agentId: 'codex',
                    },
                },
            },
        ] satisfies readonly RawMessageNormalizationInput[];

        const normalized = normalizeRawMessages(messages);

        expect(normalized).toHaveLength(1);
        expect(normalized[0]?.content).toEqual([
            expect.objectContaining({
                type: 'tool-result',
                tool_use_id: 'diff-result-evidence',
            }),
        ]);
    });

    it('preserves canonical turn diff results with file evidence even when result metadata is absent', () => {
        const messages = [
            {
                id: 'message-result-unmarked-evidence-call',
                localId: null,
                createdAt: 1_711,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId: 'diff-result-unmarked-evidence',
                            name: 'Diff',
                            input: createEmptyTurnDiffInput(),
                            id: 'tool-call-unmarked-result-evidence',
                        },
                        provider: 'codex',
                    },
                },
            },
            {
                id: 'message-result-unmarked-evidence-result',
                localId: null,
                createdAt: 1_712,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'diff-result-unmarked-evidence',
                            output: {
                                files: [{
                                    file_path: 'src/unmarked-result.ts',
                                    unified_diff: 'diff --git a/src/unmarked-result.ts b/src/unmarked-result.ts\n--- a/src/unmarked-result.ts\n+++ b/src/unmarked-result.ts\n@@ -1 +1 @@\n-before\n+after\n',
                                }],
                            },
                            id: 'tool-result-unmarked-result-evidence',
                        },
                        provider: 'codex',
                    },
                },
            },
        ] satisfies readonly RawMessageNormalizationInput[];

        const normalized = normalizeRawMessages(messages);

        expect(normalized).toHaveLength(1);
        expect(normalized[0]?.content).toEqual([
            expect.objectContaining({
                type: 'tool-result',
                tool_use_id: 'diff-result-unmarked-evidence',
            }),
        ]);
    });
});
