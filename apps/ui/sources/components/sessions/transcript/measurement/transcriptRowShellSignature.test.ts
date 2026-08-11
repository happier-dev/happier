import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import {
    buildTranscriptItemHeightSignatureKey,
    createDefaultTranscriptItemHeightCache,
} from './transcriptItemHeightCache';
import {
    buildTranscriptRowShellSignature,
    resolveTranscriptItemActiveThinkingMessageId,
    resolveTranscriptRowItemType,
    type TranscriptRowShellItem,
} from './transcriptRowShellSignature';

function messageItem(messageId: string): TranscriptRowShellItem {
    return {
        kind: 'message',
        id: messageId,
        messageId,
        createdAt: 1,
        seq: 1,
    };
}

function turnItem(turn: TranscriptTurn): TranscriptRowShellItem {
    return {
        kind: 'turn',
        id: turn.id,
        turn,
    };
}

describe('resolveTranscriptItemActiveThinkingMessageId', () => {
    it('returns the active id only for rows that contain the active thinking message', () => {
        expect(resolveTranscriptItemActiveThinkingMessageId(messageItem('thinking-1'), 'thinking-1')).toBe('thinking-1');
        expect(resolveTranscriptItemActiveThinkingMessageId(messageItem('other'), 'thinking-1')).toBeNull();
        expect(resolveTranscriptItemActiveThinkingMessageId(messageItem('thinking-1'), null)).toBeNull();
    });

    it('recognizes active thinking messages nested inside turn rows', () => {
        const turn: TranscriptTurn = {
            id: 'turn-1',
            userMessageId: 'user-1',
            content: [
                { kind: 'message', messageId: 'agent-1' },
                { kind: 'tool_calls', id: 'tools-1', toolMessageIds: ['tool-1', 'tool-2'] },
            ],
        };

        expect(resolveTranscriptItemActiveThinkingMessageId(turnItem(turn), 'agent-1')).toBe('agent-1');
        expect(resolveTranscriptItemActiveThinkingMessageId(turnItem(turn), 'user-1')).toBe('user-1');
        expect(resolveTranscriptItemActiveThinkingMessageId(turnItem(turn), 'tool-2')).toBe('tool-2');
        expect(resolveTranscriptItemActiveThinkingMessageId(turnItem(turn), 'outside')).toBeNull();
    });

    it('does not mark non-message transcript rows as thinking-active', () => {
        const item: TranscriptRowShellItem = {
            kind: 'tool-calls-group',
            id: 'group-1',
            toolMessageIds: ['tool-1'],
            createdAt: 1,
        };

        expect(resolveTranscriptItemActiveThinkingMessageId(item, 'tool-1')).toBeNull();
    });
});

describe('resolveTranscriptRowItemType is shape-only (C1 T2)', () => {
    function agentMessage(id: string, text: string, overrides: Record<string, unknown> = {}) {
        return {
            kind: 'agent-text',
            id,
            text,
            createdAt: 1,
            ...overrides,
        } as any;
    }

    function userMessage(id: string, text: string) {
        return {
            kind: 'user-text',
            id,
            text,
            createdAt: 1,
        } as any;
    }

    function resolveType(message: any, activeThinkingMessageId: string | null = null): string {
        return resolveTranscriptRowItemType({
            activeThinkingMessageId,
            getMessageById: () => message,
            item: messageItem(message.id),
        });
    }

    it('keeps the agent recycle type stable as the text grows past the long-text threshold', () => {
        const short = agentMessage('agent-1', 'a'.repeat(8));
        const long = agentMessage('agent-1', 'a'.repeat(4096));

        expect(resolveType(short)).toBe('message:agent');
        expect(resolveType(long)).toBe('message:agent');
        expect(resolveType(short)).toBe(resolveType(long));
    });

    it('keeps the user recycle type stable regardless of text length', () => {
        expect(resolveType(userMessage('user-1', 'short'))).toBe('message:user');
        expect(resolveType(userMessage('user-1', 'x'.repeat(2000)))).toBe('message:user');
    });

    it('keeps thinking as a distinct shape but never lets size flip the non-thinking agent type', () => {
        // Thinking is a genuinely distinct rendered shell shape (kept), so it has its own type.
        const thinking = agentMessage('agent-1', 'reasoning...', { isThinking: true });
        expect(resolveType(thinking, 'agent-1')).toBe('message:thinking');

        // A non-thinking agent row keeps one stable type as its text streams past the old 512 flip.
        const finalShort = agentMessage('agent-2', 'final answer');
        const finalLong = agentMessage('agent-2', 'a'.repeat(4096));
        expect(resolveType(finalShort)).toBe('message:agent');
        expect(resolveType(finalLong)).toBe('message:agent');
    });

    it('maps tool-call messages to a stable tool recycle type', () => {
        const tool = { kind: 'tool-call', id: 'tool-1', tool: { id: 'c', name: 'shell', state: 'completed' } } as any;
        expect(resolveType(tool)).toBe('message:tool');
    });
});

describe('buildTranscriptRowShellSignature', () => {
    function toolMessage(id: string, input: unknown = { value: id }) {
        return {
            kind: 'tool-call',
            id,
            localId: null,
            createdAt: 1,
            tool: {
                id: `call:${id}`,
                name: 'shell',
                state: 'completed',
                input,
            },
            children: [],
        } as any;
    }

    function buildSignature(params: Readonly<{
        item: TranscriptRowShellItem;
        messagesById: Readonly<Record<string, any>>;
        expandedToolCallsAnchorMessageIds?: ReadonlySet<string>;
        revisionsById?: Readonly<Record<string, number>>;
        activeThinkingMessageId?: string | null;
        latestCommittedActivityKey?: string | null;
        sessionActive?: boolean;
    }>) {
        return buildTranscriptRowShellSignature({
            activeThinkingMessageId: params.activeThinkingMessageId ?? null,
            expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds ?? new Set(),
            forkMessageMetadataById: null,
            getMessageById: (messageId) => params.messagesById[messageId] ?? null,
            getMessageRevisionById: (messageId) => params.revisionsById?.[messageId] ?? null,
            groupingMode: 'turns',
            item: params.item,
            latestCommittedActivityKey: params.latestCommittedActivityKey ?? null,
            // No `action-draft` row in this file, so the resolver is never called.
            resolveActionDraftFieldOptions: () => [],
            resolveThinkingExpanded: () => false,
            sessionActive: params.sessionActive ?? false,
            widthBucket: 'w:400',
            fontScaleKey: 'fs:1',
        });
    }

    it('keeps collapsed large tool groups stable when hidden completed tool details change', () => {
        const toolMessageIds = Array.from({ length: 20 }, (_, index) => `tool-${index + 1}`);
        const item: TranscriptRowShellItem = {
            kind: 'tool-calls-group',
            id: 'tools:large',
            toolMessageIds,
            createdAt: 1,
        };
        const messagesById = Object.fromEntries(toolMessageIds.map((id) => [id, toolMessage(id)]));
        const changedHiddenMessagesById = {
            ...messagesById,
            'tool-1': toolMessage('tool-1', { value: 'hidden changed' }),
        };

        const before = buildSignature({ item, messagesById });
        const after = buildSignature({ item, messagesById: changedHiddenMessagesById });

        expect(after.structuralKey).toBe(before.structuralKey);
        expect(after.expansionKey).toBe(before.expansionKey);
    });

    it('invalidates collapsed large tool groups when visible preview tool details change', () => {
        const toolMessageIds = Array.from({ length: 20 }, (_, index) => `tool-${index + 1}`);
        const item: TranscriptRowShellItem = {
            kind: 'tool-calls-group',
            id: 'tools:large',
            toolMessageIds,
            createdAt: 1,
        };
        const messagesById = Object.fromEntries(toolMessageIds.map((id) => [id, toolMessage(id)]));
        const changedPreviewMessagesById = {
            ...messagesById,
            'tool-20': toolMessage('tool-20', { value: 'preview changed' }),
        };

        const before = buildSignature({ item, messagesById });
        const after = buildSignature({ item, messagesById: changedPreviewMessagesById });

        expect(after.structuralKey).not.toBe(before.structuralKey);
    });

    it('keeps collapsed large tool groups stable inside turn rows when hidden completed tool details change', () => {
        const toolMessageIds = Array.from({ length: 20 }, (_, index) => `tool-${index + 1}`);
        const item: TranscriptRowShellItem = {
            kind: 'turn',
            id: 'turn:tools',
            turn: {
                id: 'turn:tools',
                userMessageId: null,
                content: [{
                    kind: 'tool_calls',
                    id: 'tools:large',
                    toolMessageIds,
                }],
            },
        };
        const messagesById = Object.fromEntries(toolMessageIds.map((id) => [id, toolMessage(id)]));
        const changedHiddenMessagesById = {
            ...messagesById,
            'tool-1': toolMessage('tool-1', { value: 'hidden changed' }),
        };

        const before = buildSignature({ item, messagesById });
        const after = buildSignature({ item, messagesById: changedHiddenMessagesById });

        expect(after.structuralKey).toBe(before.structuralKey);
        expect(after.expansionKey).toBe(before.expansionKey);
    });

    describe('tool-group unit rows (N2c per-unit height caching)', () => {
        const toolMessageIds = ['tool-1', 'tool-2', 'tool-3'];
        const groupId = 'toolCalls:turn:x:tool-1';

        function runningToolMessage(id: string) {
            return {
                kind: 'tool-call',
                id,
                localId: null,
                createdAt: 1,
                tool: {
                    id: `call:${id}`,
                    name: 'shell',
                    state: 'running',
                    input: { value: id },
                },
                children: [],
            } as any;
        }

        function headerItem(overrides?: Partial<{ expanded: boolean; hiddenCount: number; toolMessageIds: string[] }>): TranscriptRowShellItem {
            return {
                kind: 'tool-group-header',
                id: `${groupId}#header`,
                groupId,
                toolMessageIds: overrides?.toolMessageIds ?? toolMessageIds,
                expanded: overrides?.expanded ?? false,
                hiddenCount: overrides?.hiddenCount ?? 1,
                createdAt: 1,
            };
        }

        function toolUnitItem(toolMessageId: string, expanded = false): TranscriptRowShellItem {
            return {
                kind: 'tool-group-tool',
                id: `${groupId}#tool:${toolMessageId}`,
                groupId,
                toolMessageId,
                toolMessageIds,
                expanded,
                createdAt: 1,
                seq: null,
            };
        }

        const messagesById = Object.fromEntries(toolMessageIds.map((id) => [id, toolMessage(id)]));

        it('resolves a dedicated row type per unit kind', () => {
            const getMessageById = (messageId: string) => messagesById[messageId] ?? null;
            const resolveType = (item: TranscriptRowShellItem) => resolveTranscriptRowItemType({
                activeThinkingMessageId: null,
                getMessageById,
                item,
            });

            expect(resolveType(headerItem())).toBe('tool-group-header');
            expect(resolveType({
                kind: 'tool-group-expand',
                id: `${groupId}#expand`,
                groupId,
                toolMessageIds,
                hiddenCount: 1,
                createdAt: 1,
            })).toBe('tool-group-expand');
            expect(resolveType(toolUnitItem('tool-2'))).toBe('tool-group-tool');
            expect(resolveType({
                kind: 'tool-group-footer',
                id: `${groupId}#footer`,
                groupId,
                toolMessageIds,
                expanded: false,
                createdAt: 1,
            })).toBe('tool-group-footer');
        });

        it('keeps the header signature stable when tool message details change without a status flip', () => {
            const changed = {
                ...messagesById,
                'tool-2': toolMessage('tool-2', { value: 'changed details' }),
            };

            const before = buildSignature({ item: headerItem(), messagesById });
            const after = buildSignature({ item: headerItem(), messagesById: changed });

            expect(after.structuralKey).toBe(before.structuralKey);
            expect(after.expansionKey).toBe(before.expansionKey);
            expect(after.rowState).toBe('stable');
        });

        it('invalidates the header signature on count and status-summary changes', () => {
            const base = buildSignature({ item: headerItem(), messagesById });

            const grown = buildSignature({
                item: headerItem({ toolMessageIds: [...toolMessageIds, 'tool-4'] }),
                messagesById: { ...messagesById, 'tool-4': toolMessage('tool-4') },
            });
            expect(grown.structuralKey).not.toBe(base.structuralKey);

            const running = buildSignature({
                item: headerItem(),
                messagesById: { ...messagesById, 'tool-2': runningToolMessage('tool-2') },
            });
            expect(running.structuralKey).not.toBe(base.structuralKey);
        });

        /**
         * F-P1. The header's only expansion-dependent output is a 16px chevron inside a
         * `flexDirection: 'row'` container whose row height is set by the 13px title text, plus the
         * `Pressable`'s enabled state — neither is height-bearing. `estimateTranscriptRowHeightFromCache`
         * holds the corroborating live measurement (2026-07-29, all three chrome variants x 7 tool
         * shapes: "expansion ... never changed a unit row's painted height"), which is why its
         * per-variant header constant has no expanded/collapsed split. Keeping expansion in the size
         * version therefore only discarded the header's measured height on every tap.
         */
        it('keeps the measured height of the header row across an expand/collapse tap', () => {
            const collapsed = buildSignature({ item: headerItem({ expanded: false, hiddenCount: 1 }), messagesById });
            const expanded = buildSignature({ item: headerItem({ expanded: true, hiddenCount: 0 }), messagesById });

            expect(buildTranscriptItemHeightSignatureKey(expanded))
                .toBe(buildTranscriptItemHeightSignatureKey(collapsed));

            const cache = createDefaultTranscriptItemHeightCache();
            expect(cache.set(collapsed, { heightPx: 33 })).toBe(true);
            expect(cache.get(expanded)?.heightPx).toBe(33);
        });

        it('keys the expand unit on its hidden count only', () => {
            const expandItem = (hiddenCount: number): TranscriptRowShellItem => ({
                kind: 'tool-group-expand',
                id: `${groupId}#expand`,
                groupId,
                toolMessageIds,
                hiddenCount,
                createdAt: 1,
            });

            const base = buildSignature({ item: expandItem(2), messagesById });
            const sameCountChangedMessages = buildSignature({
                item: expandItem(2),
                messagesById: { ...messagesById, 'tool-1': toolMessage('tool-1', { value: 'changed' }) },
            });
            const grownCount = buildSignature({ item: expandItem(3), messagesById });

            expect(sameCountChangedMessages.structuralKey).toBe(base.structuralKey);
            expect(grownCount.structuralKey).not.toBe(base.structuralKey);
        });

        it('keys a tool unit on its OWN message revision, ignoring siblings', () => {
            const base = buildSignature({ item: toolUnitItem('tool-2'), messagesById });

            const siblingChanged = buildSignature({
                item: toolUnitItem('tool-2'),
                messagesById: { ...messagesById, 'tool-1': toolMessage('tool-1', { value: 'sibling changed' }) },
            });
            expect(siblingChanged.structuralKey).toBe(base.structuralKey);

            const ownChanged = buildSignature({
                item: toolUnitItem('tool-2'),
                messagesById: { ...messagesById, 'tool-2': toolMessage('tool-2', { value: 'own changed' }) },
            });
            expect(ownChanged.structuralKey).not.toBe(base.structuralKey);
        });

        /**
         * F-P1. `ChatListInternal` wires Legend's vendored `getItemSizeVersion` to
         * `buildTranscriptItemHeightSignatureKey(buildTranscriptRowShellSignature(item))`, and the
         * vendored `validateItemSizeVersion` DELETES both `sizesKnown` and `sizes` for every row whose
         * version moved. So any expansion fact in a `tool-group-tool` signature makes one
         * expand/collapse tap throw away the MEASURED height of every tool row in the group and
         * re-place them from the estimate.
         *
         * A grouped tool row paints identical content expanded and collapsed unless its renderer
         * actually swaps on group expansion — which happens only for subagent rows
         * (`ToolTimelineRow` <-> `MessageView`, plus the collapsed-preview sidechain eager-load).
         * The renderer module stays the single decision-maker; this signature consumes its answer.
         */
        describe('group expansion is part of the size version ONLY when it can change what the row paints (F-P1)', () => {
            function subAgentToolMessage(id: string) {
                return {
                    kind: 'tool-call',
                    id,
                    localId: null,
                    createdAt: 1,
                    tool: {
                        id: `call:${id}`,
                        name: 'SubAgentRun',
                        state: 'completed',
                        input: { sidechainId: `sidechain:${id}` },
                    },
                    children: [],
                } as any;
            }

            it('keeps the measured height of a plain tool row across an expand/collapse tap', () => {
                const collapsed = buildSignature({ item: toolUnitItem('tool-2', false), messagesById });
                const expanded = buildSignature({ item: toolUnitItem('tool-2', true), messagesById });

                // Legend compares exactly this key; an equal key means `sizesKnown`/`sizes` survive.
                expect(buildTranscriptItemHeightSignatureKey(expanded))
                    .toBe(buildTranscriptItemHeightSignatureKey(collapsed));

                // ...and the measurement cache keyed on the same signature still resolves the height.
                const cache = createDefaultTranscriptItemHeightCache();
                expect(cache.set(collapsed, { heightPx: 137 })).toBe(true);
                expect(cache.get(expanded)?.heightPx).toBe(137);
            });

            it('still invalidates a subagent tool row, whose renderer swaps on group expansion', () => {
                const subAgentMessagesById = { ...messagesById, 'tool-2': subAgentToolMessage('tool-2') };
                const collapsed = buildSignature({ item: toolUnitItem('tool-2', false), messagesById: subAgentMessagesById });
                const expanded = buildSignature({ item: toolUnitItem('tool-2', true), messagesById: subAgentMessagesById });

                expect(buildTranscriptItemHeightSignatureKey(expanded))
                    .not.toBe(buildTranscriptItemHeightSignatureKey(collapsed));

                const cache = createDefaultTranscriptItemHeightCache();
                expect(cache.set(collapsed, { heightPx: 137 })).toBe(true);
                expect(cache.get(expanded)).toBeUndefined();
            });

            it('keeps own-revision invalidation intact for a plain tool row that is expanded', () => {
                const expanded = buildSignature({ item: toolUnitItem('tool-2', true), messagesById });
                const expandedOwnChanged = buildSignature({
                    item: toolUnitItem('tool-2', true),
                    messagesById: { ...messagesById, 'tool-2': toolMessage('tool-2', { value: 'own changed' }) },
                });

                expect(buildTranscriptItemHeightSignatureKey(expandedOwnChanged))
                    .not.toBe(buildTranscriptItemHeightSignatureKey(expanded));
            });
        });

        it('derives the tool unit row state from its own message progress', () => {
            const stable = buildSignature({ item: toolUnitItem('tool-2'), messagesById });
            expect(stable.rowState).toBe('stable');

            const running = buildSignature({
                item: toolUnitItem('tool-2'),
                messagesById: { ...messagesById, 'tool-2': runningToolMessage('tool-2') },
            });
            expect(running.rowState).toBe('tool-progress');

            const siblingRunning = buildSignature({
                item: toolUnitItem('tool-2'),
                messagesById: { ...messagesById, 'tool-1': runningToolMessage('tool-1') },
            });
            expect(siblingRunning.rowState).toBe('stable');
        });

        it('keeps the footer signature stable across message and expansion churn', () => {
            const footerItem = (expanded: boolean): TranscriptRowShellItem => ({
                kind: 'tool-group-footer',
                id: `${groupId}#footer`,
                groupId,
                toolMessageIds,
                expanded,
                createdAt: 1,
            });

            const base = buildSignature({ item: footerItem(false), messagesById });
            const churned = buildSignature({
                item: footerItem(true),
                messagesById: { ...messagesById, 'tool-2': runningToolMessage('tool-2') },
            });

            expect(churned.structuralKey).toBe(base.structuralKey);
            expect(churned.rowState).toBe('stable');
        });
    });

    describe('revision-keyed message structural keys (R1)', () => {
        function giantAgentMessage(id: string, byteCount: number) {
            return {
                kind: 'agent-text',
                id,
                text: 'x'.repeat(byteCount),
                createdAt: 1,
            } as any;
        }

        it('never serializes message content when a revision is available', () => {
            const message = giantAgentMessage('agent-big', 512 * 1024);
            const signature = buildSignature({
                item: messageItem('agent-big'),
                messagesById: { 'agent-big': message },
                revisionsById: { 'agent-big': 7 },
            });

            expect(signature.structuralKey.length).toBeLessThan(256);
            expect(signature.structuralKey).not.toContain('xxxx');
        });

        it('invalidates exactly when the revision bumps and stays stable when it does not', () => {
            const message = giantAgentMessage('agent-1', 64);
            const stableA = buildSignature({
                item: messageItem('agent-1'),
                messagesById: { 'agent-1': message },
                revisionsById: { 'agent-1': 3 },
            });
            // New object identity, same revision: identical signature (store bumps the
            // revision on every message write, so an unchanged revision means unchanged content).
            const stableB = buildSignature({
                item: messageItem('agent-1'),
                messagesById: { 'agent-1': giantAgentMessage('agent-1', 64) },
                revisionsById: { 'agent-1': 3 },
            });
            const bumped = buildSignature({
                item: messageItem('agent-1'),
                messagesById: { 'agent-1': message },
                revisionsById: { 'agent-1': 4 },
            });

            expect(stableB.structuralKey).toBe(stableA.structuralKey);
            expect(bumped.structuralKey).not.toBe(stableA.structuralKey);
        });

        it('falls back to content-based invalidation when no revision exists', () => {
            const before = buildSignature({
                item: messageItem('legacy-1'),
                messagesById: { 'legacy-1': giantAgentMessage('legacy-1', 8) },
            });
            const after = buildSignature({
                item: messageItem('legacy-1'),
                messagesById: { 'legacy-1': giantAgentMessage('legacy-1', 16) },
            });

            expect(after.structuralKey).not.toBe(before.structuralKey);
        });

        it('keys turn rows on member revisions without serializing member content', () => {
            const item: TranscriptRowShellItem = {
                kind: 'turn',
                id: 'turn-rev',
                turn: {
                    id: 'turn-rev',
                    userMessageId: 'user-1',
                    content: [{ kind: 'message', messageId: 'agent-big' }],
                },
            };
            const messagesById = {
                'user-1': giantAgentMessage('user-1', 32),
                'agent-big': giantAgentMessage('agent-big', 512 * 1024),
            };

            const before = buildSignature({
                item,
                messagesById,
                revisionsById: { 'user-1': 1, 'agent-big': 5 },
            });
            const unchanged = buildSignature({
                item,
                messagesById,
                revisionsById: { 'user-1': 1, 'agent-big': 5 },
            });
            const bumped = buildSignature({
                item,
                messagesById,
                revisionsById: { 'user-1': 1, 'agent-big': 6 },
            });

            expect(before.structuralKey.length).toBeLessThan(1024);
            expect(before.structuralKey).not.toContain('xxxx');
            expect(unchanged.structuralKey).toBe(before.structuralKey);
            expect(bumped.structuralKey).not.toBe(before.structuralKey);
        });

        it('keys tool-group-tool units on their own revision without serializing content', () => {
            const item: TranscriptRowShellItem = {
                kind: 'tool-group-tool',
                id: 'group#tool:tool-big',
                groupId: 'group',
                toolMessageId: 'tool-big',
                toolMessageIds: ['tool-big'],
                expanded: false,
                createdAt: 1,
                seq: null,
            };
            const messagesById = { 'tool-big': toolMessage('tool-big', { blob: 'x'.repeat(256 * 1024) }) };

            const before = buildSignature({ item, messagesById, revisionsById: { 'tool-big': 2 } });
            const bumped = buildSignature({ item, messagesById, revisionsById: { 'tool-big': 3 } });

            expect(before.structuralKey.length).toBeLessThan(256);
            expect(before.structuralKey).not.toContain('xxxx');
            expect(bumped.structuralKey).not.toBe(before.structuralKey);
        });
    });

    /**
     * E-3 M3. `rowState: 'thinking'` is a GROWING classification: the measurement reconciler holds a
     * monotonic height floor for growing rows and never releases it on a content change (that is what
     * keeps a genuinely growing row from being under-reserved mid-frame). Assigning `'thinking'` from
     * `message.isThinking === true` alone made the classification PERMANENT — every historical thinking
     * block in the transcript stayed growing-classified forever and therefore stranded its tallest
     * historical height as an inert-but-self-fulfilling `minHeight`. Liveness, not the message flag,
     * decides whether a thinking block is still growing.
     */
    describe('thinking rowState is a LIVE classification, never a permanent one (E-3 M3)', () => {
        function thinkingMessage(id: string) {
            return {
                kind: 'agent-text',
                id,
                text: 'reasoning...',
                createdAt: 1,
                isThinking: true,
            } as any;
        }

        function thinkingTurnItem(agentMessageId: string): TranscriptRowShellItem {
            return {
                kind: 'turn',
                id: `turn:${agentMessageId}`,
                turn: {
                    id: `turn:${agentMessageId}`,
                    userMessageId: 'user-1',
                    content: [{ kind: 'message', messageId: agentMessageId }],
                },
            };
        }

        it('classifies a settled historical thinking block as stable so its floor is shrink-capable', () => {
            const signature = buildSignature({
                item: messageItem('thinking-1'),
                messagesById: { 'thinking-1': thinkingMessage('thinking-1') },
                activeThinkingMessageId: null,
                sessionActive: false,
            });

            expect(signature.rowState).toBe('stable');
        });

        it('classifies a settled thinking block as stable even while the session is still active', () => {
            const signature = buildSignature({
                item: messageItem('thinking-1'),
                messagesById: {
                    'thinking-1': thinkingMessage('thinking-1'),
                    'agent-2': { kind: 'agent-text', id: 'agent-2', text: 'answer', createdAt: 2 } as any,
                },
                activeThinkingMessageId: null,
                latestCommittedActivityKey: 'agent-2',
                sessionActive: true,
            });

            expect(signature.rowState).toBe('stable');
        });

        it('does not strand a settled thinking block nested in a turn row', () => {
            const signature = buildSignature({
                item: thinkingTurnItem('thinking-1'),
                messagesById: {
                    'user-1': { kind: 'user-text', id: 'user-1', text: 'hi', createdAt: 1 } as any,
                    'thinking-1': thinkingMessage('thinking-1'),
                },
                activeThinkingMessageId: null,
                sessionActive: false,
            });

            expect(signature.rowState).toBe('stable');
        });

        it('keeps the ACTIVE thinking block growing-classified', () => {
            const signature = buildSignature({
                item: messageItem('thinking-1'),
                messagesById: { 'thinking-1': thinkingMessage('thinking-1') },
                activeThinkingMessageId: 'thinking-1',
                sessionActive: true,
            });

            expect(signature.rowState).toBe('thinking');
        });

        it('keeps the latest committed thinking block growing while the session is active', () => {
            const signature = buildSignature({
                item: messageItem('thinking-1'),
                messagesById: { 'thinking-1': thinkingMessage('thinking-1') },
                activeThinkingMessageId: null,
                latestCommittedActivityKey: 'thinking-1',
                sessionActive: true,
            });

            expect(signature.rowState).toBe('thinking');
        });

        it('keeps a growing thinking turn row growing-classified', () => {
            const signature = buildSignature({
                item: thinkingTurnItem('thinking-1'),
                messagesById: {
                    'user-1': { kind: 'user-text', id: 'user-1', text: 'hi', createdAt: 1 } as any,
                    'thinking-1': thinkingMessage('thinking-1'),
                },
                activeThinkingMessageId: 'thinking-1',
                sessionActive: true,
            });

            expect(signature.rowState).toBe('thinking');
        });

        it('never lets the settle flip the recycle type (C1 T2 shape stability)', () => {
            // rowState settles; the rendered SHELL SHAPE does not. A recycle-type flip would remount
            // the cell into a different pool — the exact failure C1 T2 exists to prevent.
            const message = thinkingMessage('thinking-1');
            const live = resolveTranscriptRowItemType({
                activeThinkingMessageId: 'thinking-1',
                getMessageById: () => message,
                item: messageItem('thinking-1'),
            });
            const settled = resolveTranscriptRowItemType({
                activeThinkingMessageId: null,
                getMessageById: () => message,
                item: messageItem('thinking-1'),
            });

            expect(live).toBe('message:thinking');
            expect(settled).toBe('message:thinking');
        });
    });
});
