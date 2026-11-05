import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionMessagesFixture, createTestSessionTranscriptSource, createToolCallMessageFixture, renderScreen, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { createMessageStructuredPresentationV1 } from '@happier-dev/protocol';
import { ReviewCommentsV1Schema } from '@happier-dev/protocol/messages/structured/reviewCommentsV1';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { resolveTranscriptMessageDisplayText } from '../messageDisplayText';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createTranscriptFindRowStore } from '../find/transcriptFindRowStore';
import { TranscriptFindProvider } from '../find/TranscriptFindContext';
import type { Message } from '@happier-dev/session-core/messages';
import { TranscriptRowLayoutMutationProvider, type TranscriptRowLayoutMutation } from '../measurement/TranscriptRowLayoutMutationContext';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
installDisconnectedServerSocketBoundary();
const { buildRealtimeConversationRawRecord } = await import('@/voice/transcript/VoiceTranscriptProjector');
const { projectStructuredMessageFindText, renderStructuredMessage } = await import('./StructuredMessageBlock');
const { findBuiltInStructuredMessageEntry } = await import('./descriptorRegistry');
const { renderExecutionRunStructuredMeta } = await import('@/components/sessions/runs/renderExecutionRunStructuredMeta');

describe('Structured transcript Find', () => {
    it.each(['user', 'assistant'] as const)('keeps canonical realtime %s text and Voice markers without an unavailable card', role => {
        const text = 'User said:\nHULLO PLEASE keep API and iOS';
        const normalized = normalizeRawMessage('voice-turn', null, 100, buildRealtimeConversationRawRecord({
            id: 'voice-turn', role, text,
        }));
        if (!normalized) throw new Error('Canonical Voice record must normalize');
        const message = reducer(createReducer(), [normalized]).messages[0]!;
        if (message.kind !== 'user-text' && message.kind !== 'agent-text') throw new Error('Voice turn must remain text');
        expect.soft(resolveTranscriptMessageDisplayText(message)).toMatchObject({ text, isVoiceAgentTurn: true });
        expect.soft(projectStructuredMessageFindText(message)).toBeNull();
        expect.soft(renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined })).toBeNull();
    });

    it.each(['readOnly', 'app', 'implicitApp'] as const)('names an unlabeled walkthrough recipient in the %s card and Find through the canonical Run title', async sourceKind => {
        const base = createToolCallMessageFixture();
        const run = createToolCallMessageFixture({ id: 'generator-tool', tool: { ...base.tool,
            name: 'SubAgentRun', input: { runId: 'walkthrough-run', intent: 'scm_diff_summary' },
            result: { runId: 'walkthrough-run', status: 'running' },
        } });
        const message: Message = { kind: 'user-text', id: 'question', localId: null, createdAt: 2, text: 'Why this change?',
            meta: { happier: { kind: 'participant_message.v1', payload: { recipient: { kind: 'execution_run', runId: 'walkthrough-run' } } } } };
        const messages = [run, message];
        const blocks = projectStructuredMessageFindText(message, { sessionMessages: messages });
        expect(blocks?.[0]?.text).toBe('session.participants.cardTo(label=walkthrough.eyebrow)');
        const element = renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined });
        if (sourceKind === 'readOnly') {
            const source = createTestSessionTranscriptSource({ sessionId: 's1', messages });
            const screen = await renderScreen(wrapWithSessionTranscriptSource(element!, source));
            expect(screen.getTextContent()).toContain('session.participants.cardTo(label=walkthrough.eyebrow)');
            expect(screen.getTextContent()).not.toContain('walkthrough-run');
        } else {
            const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
            const { getStorage } = await import('@/sync/domains/state/storage');
            const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
            const storage = getStorage();
            const initial = storage.getState();
            const serverId = getActiveServerSnapshot().serverId;
            const unrelated: Message[] = Array.from({ length: 1000 }, (_, index) => ({ kind: 'user-text', id: `other-${index}`, localId: null, createdAt: index + 3, text: 'Unrelated question' }));
            const all = [...messages, ...unrelated];
            const transcript = createSessionMessagesFixture({ messagesById: Object.fromEntries(all.map(row => [row.id, row])),
                messageIdsOldestFirst: all.map(row => row.id), messagesVersion: 1, subagentSourceVersion: 1, isLoaded: true });
            storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId }) }, sessionMessages: { s1: transcript } });
            let commits = 0;
            const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="s1" serverId={sourceKind === 'implicitApp' ? undefined : serverId}>
                <React.Profiler id="participant" onRender={() => { commits++; }}>{element}</React.Profiler>
            </AppSessionTranscriptSourceProvider>);
            try {
                expect(screen.getTextContent()).toContain('session.participants.cardTo(label=walkthrough.eyebrow)');
                const before = commits;
                await act(async () => storage.setState({ sessionMessages: { s1: { ...transcript, messagesVersion: 2,
                    messagesById: { ...transcript.messagesById, extra: { ...message, id: 'extra', meta: undefined } } } } }));
                expect(commits).toBe(before);
            } finally {
                await screen.unmount();
                storage.setState(initial, true);
            }
        }
    });

    it('keeps an explicit recipient label and the unknown-Run fallback without inventing a walkthrough intent', () => {
        const recipient = { kind: 'execution_run' as const, runId: 'unknown-run' };
        const message: Message = { kind: 'user-text', id: 'question', localId: null, createdAt: 1, text: 'Question',
            meta: { happier: { kind: 'participant_message.v1', payload: { recipient } } } };
        expect(projectStructuredMessageFindText(message, { sessionMessages: [] })?.[0]?.text)
            .toBe('session.participants.cardTo(label=session.participants.executionRun(runId=unknown-run))');
        const labeled: Message = { ...message, meta: { happier: { kind: 'participant_message.v1', payload: {
            recipient: { ...recipient, label: 'Saved recipient' },
        } } } };
        expect(projectStructuredMessageFindText(labeled, { sessionMessages: [] })?.[0]?.text)
            .toBe('session.participants.cardTo(label=Saved recipient)');
    });
    it('decorates actual typed-card display text rather than the envelope or hidden recipient identity', async () => {
        const message: Message = {
            kind: 'user-text', id: 'participant', localId: null, createdAt: 1,
            text: 'needle body',
            meta: { happier: { kind: 'participant_message.v1', payload: { recipient: {
                kind: 'execution_run', runId: 'hidden-run-id', label: 'Recipient', retiredRecipientField: true,
            }, retiredPayloadField: true } } },
        };
        const element = renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined });
        expect(element).not.toBeNull();
        const entry = findBuiltInStructuredMessageEntry('participant_message.v1')!;
        const payload = { recipient: { kind: 'execution_run', runId: 'hidden-run-id', label: 'Recipient' } };
        const parsed = entry.schema.safeParse(payload);
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw new Error('Participant fixture must validate');
        const blocks = entry.projectFindText!(parsed.data, { message });
        if (blocks === null) throw new Error('Participant fixture must project its visible card');
        expect(blocks.map((block) => block.text).join('\n')).toContain('needle body');
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('hidden-run-id');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([[message.id, { blocks: [{ id: 'structured-participant-body', sourceRanges: [{ start: 0, end: 6, current: true }] }] }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}>{element}</TranscriptFindProvider>);
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
    });

    it('renders and searches retained review comments while rejecting malformed known anchors', async () => {
        const comment = {
            id: 'comment-1', filePath: 'src/a.ts', source: 'file',
            anchor: { kind: 'fileLine', startLine: 1, lineHash: 'lh1:1234567890abcdef', retiredAnchorField: true },
            snapshot: { selectedLines: ['selected code'], beforeContext: [], afterContext: [], retiredSnapshotField: true },
            body: 'retained review body', createdAt: 1, retiredCommentField: true,
        };
        const payload = { sessionId: 's1', comments: [comment], retiredPayloadField: true };
        const message: Message = { kind: 'user-text', id: 'review-comments', localId: null, createdAt: 1, text: 'hidden raw body',
            meta: { happier: { kind: 'review_comments.v1', payload } } };
        expect(ReviewCommentsV1Schema.safeParse(payload).success).toBe(false);
        expect(projectStructuredMessageFindText(message)?.find((block) => block.id === 'structured-review-comment:comment-1:body')?.text)
            .toBe('retained review body');
        const element = renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined });
        const screen = await renderScreen(element!);
        expect(screen.getTextContent()).toContain('retained review body');
        expect(screen.getTextContent()).not.toContain('hidden raw body');

        const malformed: Message = { ...message, meta: { happier: { kind: 'review_comments.v1', payload: {
            ...payload, comments: [{ ...comment, anchor: { ...comment.anchor, lineHash: 'invalid' } }],
        } } } };
        expect(projectStructuredMessageFindText(malformed)?.some((block) => block.text === 'retained review body')).toBe(false);
        const unavailable = renderStructuredMessage({ message: malformed, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined });
        const unavailableScreen = await renderScreen(unavailable!);
        expect(unavailableScreen.findByTestId('structured-message-unavailable')).not.toBeNull();
    });

    it('keeps the retained continuation note presentation instead of its hidden raw message text', () => {
        const payload = { v: 1, continuation: { v: 1, deviceId: 'other-device', deviceDisplayName: 'Alice’s phone',
            conversation: { serverId: 'home', sessionId: 'conversation' } } };
        const message: Message = { kind: 'agent-text', id: 'continuation', localId: null, createdAt: 1, text: 'hidden raw continuation',
            meta: { happier: { kind: 'voice_note.v1', payload } } };
        const retained: Message = { ...message, meta: { happier: { kind: 'voice_note.v1', payload: {
            ...payload, retiredPayloadField: true, continuation: { ...payload.continuation, lease: 'retired',
                conversation: { ...payload.continuation.conversation, remoteEnd: true } },
        } } } };
        expect(projectStructuredMessageFindText(retained)).toEqual(projectStructuredMessageFindText(message));
        expect(projectStructuredMessageFindText(retained)?.[0]?.text).not.toBe('hidden raw continuation');
    });

    it.each(['review_findings.v1', 'review_findings.v2', 'review_follow_up.v1'])('renders retained Run review content for %s without accepting a malformed comment', async (kind) => {
        const runRef = { runId: 'run-1', callId: 'call-1', backendId: 'codex' };
        const finding = { id: 'finding-1', title: 'Retained finding title', severity: 'high', category: 'correctness', summary: 'Retained finding summary',
            comment: { id: 'comment-1', state: 'proposed', serverRevision: 1, retiredCommentField: true,
                workspace: { machineId: 'machine-1', path: '/repo', retiredWorkspaceField: true } } };
        const payload = kind === 'review_follow_up.v1'
            ? { parentRunRef: runRef, threadId: 'thread-1', requestMarkdown: 'Why?', answerMarkdown: 'Because.', updatedFindings: [finding], generatedAtMs: 1 }
            : { runRef, summary: 'Retained review summary', overviewMarkdown: 'Retained review overview', findings: [finding], generatedAtMs: 1 };
        const params = { meta: { kind, payload }, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false } };
        const element = renderExecutionRunStructuredMeta(params);
        expect(element).not.toBeNull();
        const source = createTestSessionTranscriptSource({ sessionId: 's1' });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(element!, source));
        expect(screen.getTextContent()).toContain('Retained finding title');

        const malformedFinding = { ...finding, comment: { ...finding.comment, workspace: { ...finding.comment.workspace, machineId: '' } } };
        const malformedPayload = kind === 'review_follow_up.v1'
            ? { ...payload, updatedFindings: [malformedFinding] }
            : { ...payload, findings: [malformedFinding] };
        expect(renderExecutionRunStructuredMeta({ ...params, meta: { kind, payload: malformedPayload } })).toBeNull();
    });

    it('preserves ordinary Markdown fallback for a valid null card descriptor', () => {
        const message: Message = { kind: 'agent-text', id: 'voice', localId: null, createdAt: 1, text: '**visible**',
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 0, role: 'assistant', voiceAgentId: 'va_1', ts: 1 } } } };
        expect(renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined })).toBeNull();
        expect(projectStructuredMessageFindText(message)).toBeNull();
    });

    it('keeps a replacing empty frozen snapshot empty rather than searching its hidden raw body', () => {
        const message: Message = { kind: 'agent-text', id: 'empty-snapshot', localId: null, createdAt: 1, text: 'hidden needle',
            structuredPresentation: createMessageStructuredPresentationV1({ owner: { pluginId: 'test.card', contributionLocalId: 'empty' }, snapshot: { kind: 'stack', children: [] } }) };
        expect(projectStructuredMessageFindText(message)).toEqual([]);
        expect(renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined })).not.toBeNull();
    });

    it('indexes and decorates a retained completion card summary instead of the legacy notification body or run identity', async () => {
        const message: Message = { kind: 'user-text', id: 'completion', localId: null, createdAt: 1, text: '<happier_execution_run_notification>hidden raw body</happier_execution_run_notification>',
            meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: { v: 1, runId: 'hidden-run', status: 'failed', finishedAtMs: 1, summary: 'prefix needle', canInspect: false } } } };
        const blocks = projectStructuredMessageFindText(message, { canNavigate: false });
        expect(blocks?.find((block) => block.id === 'structured-worker-result')?.text).toBe('prefix needle');
        expect(blocks?.map((block) => block.text).join('\n')).not.toContain('hidden');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([[message.id, { blocks: [{ id: 'structured-worker-result', sourceRanges: [{ start: 7, end: 13, current: true }] }] }]]));
        const element = renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined });
        const source = createTestSessionTranscriptSource({ sessionId: 's1' });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(<TranscriptFindProvider store={store}>{element}</TranscriptFindProvider>, source));
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
    });

    it('excludes the host inspection control even when navigation is available', () => {
        const message: Message = { kind: 'user-text', id: 'public-completion', localId: null, createdAt: 1, text: 'raw notification',
            meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: { v: 1, runId: 'run', status: 'failed', finishedAtMs: 1, summary: 'result', canInspect: true } } } };
        expect(projectStructuredMessageFindText(message, { canNavigate: true })?.some((block) => block.id === 'structured-worker-inspect')).toBe(false);
    });

    it('reveals a completion header clamp through the transcript layout owner', async () => {
        const message: Message = { kind: 'user-text', id: 'header-completion', localId: null, createdAt: 1, text: 'raw notification',
            meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: { v: 1, runId: 'run', status: 'failed', finishedAtMs: 1, summary: 'result', canInspect: false } } } };
        const store = createTranscriptFindRowStore();
        store.publish(new Map([[message.id, { blocks: [{ id: 'structured-worker-title', sourceRanges: [{ start: 0, end: 1, current: true }] }], reveal: { blockId: 'structured-worker-title', requestId: 1 } }]]));
        const mutations: TranscriptRowLayoutMutation[] = [];
        const element = renderStructuredMessage({ message, sessionId: 's1', interaction: { canSendMessages: false, canApprovePermissions: false }, onJumpToAnchor: undefined });
        const source = createTestSessionTranscriptSource({ sessionId: 's1' });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(<TranscriptRowLayoutMutationProvider value={(mutation) => mutations.push(mutation)}><TranscriptFindProvider store={store}>{element}</TranscriptFindProvider></TranscriptRowLayoutMutationProvider>, source));
        expect(screen.findAllHostsByTestId('worker-update-title')[0]?.props.numberOfLines).toBeUndefined();
        expect(mutations).toContainEqual({ reason: 'expand', sourceId: 'structured-find:structured-worker-title' });
    });
});
