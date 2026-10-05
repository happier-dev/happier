import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionMessageCardCommonModuleMocks } from '@/components/sessions/sessionMessageCardTestHelpers';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';
import { StructuredFindMessageProvider } from '@/components/sessions/transcript/structured/structuredFindText';
import { ReviewFollowUpMessageCard } from './ReviewFollowUpMessageCard';

installSessionMessageCardCommonModuleMocks();

describe('ReviewFollowUpMessageCard Find', () => {
    it('highlights the rendered answer and updated finding without indexing run metadata', async () => {
        const store = createTranscriptFindRowStore();
        const screen = await renderScreen(<TranscriptFindProvider store={store}>
            <StructuredFindMessageProvider messageId="follow-up">
                <ReviewFollowUpMessageCard payload={{
                    parentRunRef: { runId: 'hidden-run', callId: 'hidden-call', backendId: 'codex' },
                    threadId: 'hidden-thread', findingIds: ['f1'], generatedAtMs: 1,
                    requestMarkdown: 'Why?', answerMarkdown: 'The **answer** is here.',
                    updatedFindings: [{ id: 'f1', title: 'Updated finding', summary: 'Updated summary', severity: 'high', category: 'correctness' }],
                }} />
            </StructuredFindMessageProvider>
        </TranscriptFindProvider>);
        await act(() => store.publish(new Map([['follow-up', {
            blocks: [
                { id: 'structured-review-follow-up:answer', sourceRanges: [{ start: 6, end: 12, current: true }] },
                { id: 'structured-review-follow-up:updated:f1:summary', sourceRanges: [{ start: 8, end: 15, current: false }] },
            ],
        }]])));
        expect(screen.findByTestId('find-match-current')?.props.children).toBe('answer');
        expect(screen.findByTestId('find-match-all')?.props.children).toBe('summary');
        expect(screen.getTextContent()).not.toContain('hidden-run');
    });
});
