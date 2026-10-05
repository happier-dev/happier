import React from 'react';
import { describe, expect, it } from 'vitest';
import { createTestSessionTranscriptSource, renderScreen, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { createMessageStructuredPresentationV1 } from '@happier-dev/protocol';
import { installToolShellCommonModuleMocks } from '@/components/tools/shell/views/ToolView.testHelpers';
import { createTranscriptFindRowStore } from '../find/transcriptFindRowStore';
import { TranscriptFindProvider } from '../find/TranscriptFindContext';
import { projectStructuredMessageFindText, renderStructuredMessage } from './StructuredMessageBlock';
import type { Message } from '@happier-dev/session-core/messages';
import { findBuiltInStructuredMessageEntry } from './descriptorRegistry';
import { TranscriptRowLayoutMutationProvider, type TranscriptRowLayoutMutation } from '../measurement/TranscriptRowLayoutMutationContext';

installToolShellCommonModuleMocks();

describe('Structured transcript Find', () => {
    it('decorates actual typed-card display text rather than the envelope or hidden recipient identity', async () => {
        const message: Message = {
            kind: 'user-text', id: 'participant', localId: null, createdAt: 1,
            text: 'needle body',
            meta: { happier: { kind: 'participant_message.v1', payload: { recipient: {
                kind: 'execution_run', runId: 'hidden-run-id', label: 'Recipient',
            } } } },
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
