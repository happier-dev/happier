import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit';
import { installSessionMessageCardCommonModuleMocks } from '@/components/sessions/sessionMessageCardTestHelpers';
import type { DelegateOutputV1 } from '@happier-dev/protocol';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionMessageCardCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                if (key === 'delegation.output.title') return 'Delegation output';
                if (key === 'delegation.output.deliverablesTitle') return 'Deliverables';
                return String(key);
            },
        });
    },
});

describe('DelegateOutputMessageCard (selection)', () => {
    it('decorates the actual summary and deliverable details from the row Find store', async () => {
        const { DelegateOutputMessageCard } = await import('./DelegateOutputMessageCard');
        const { StructuredFindMessageProvider } = await import('@/components/sessions/transcript/structured/structuredFindText');
        const { TranscriptFindProvider } = await import('@/components/sessions/transcript/find/TranscriptFindContext');
        const { createTranscriptFindRowStore } = await import('@/components/sessions/transcript/find/transcriptFindRowStore');
        const store = createTranscriptFindRowStore();
        const payload: DelegateOutputV1 = {
            runRef: { runId: 'run1', callId: 'call1', backendId: 'engine1' },
            generatedAtMs: 123, summary: 'needle summary',
            deliverables: [{ id: 'd1', title: 'Result', details: 'needle details' }],
        };
        const screen = await renderScreen(
            <TranscriptFindProvider store={store}>
                <StructuredFindMessageProvider messageId="delegate-message">
                    <DelegateOutputMessageCard payload={payload} />
                </StructuredFindMessageProvider>
            </TranscriptFindProvider>,
        );
        await act(() => store.publish(new Map([['delegate-message', { blocks: [
            { id: 'structured-delegate-summary', sourceRanges: [{ start: 0, end: 6, current: true }] },
            { id: 'structured-delegate-deliverable:0:details', sourceRanges: [{ start: 0, end: 6, current: false }] },
        ] }]])));
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
        expect(screen.findAllHostsByTestId('find-match-all').map((node) => node.children.join(''))).toEqual(['needle']);
        await act(() => store.clear());
        expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('needle details');
    });

    it('projects displayed deliverables for Find without hidden payload fields or overflow', async () => {
        const { DelegateOutputMessageCard, projectDelegateOutputFindText } = await import('./DelegateOutputMessageCard');
        const payload: DelegateOutputV1 = {
            runRef: { runId: 'hidden-run', callId: 'hidden-call', backendId: 'hidden-backend' },
            generatedAtMs: 123,
            summary: 'Visible summary',
            deliverables: Array.from({ length: 31 }, (_, index) => ({
                id: `hidden-deliverable-${index}`, title: `Title ${index}`, details: `Details ${index}`,
            })),
            privateMetadata: 'Hidden metadata',
        };
        const blocks = projectDelegateOutputFindText(payload);
        const texts = blocks.map((block) => block.text);
        const screen = await renderScreen(<DelegateOutputMessageCard payload={payload} />);
        for (const text of texts) expect(screen.getTextContent()).toContain(text);
        expect(texts).toContain('Delegation output');
        expect(texts).toContain('Visible summary');
        expect(texts).toContain('Deliverables');
        expect(texts).toContain('Title 29');
        expect(texts).toContain('Details 29');
        expect(texts).not.toContain('Title 30');
        expect(texts).not.toContain('Details 30');
        expect(texts.join('\n')).not.toContain('hidden-');
        expect(texts).not.toContain('Hidden metadata');
        expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
        expect(projectDelegateOutputFindText(payload, { presentation: 'page' }).map((block) => block.text)).not.toContain('Delegation output');
        expect(projectDelegateOutputFindText({ ...payload, deliverables: [] }).map((block) => block.text)).not.toContain('Deliverables');
    });

    it('renders deliverable text as selectable', async () => {
        const { DelegateOutputMessageCard } = await import('./DelegateOutputMessageCard');

        const payload: any = {
            kind: 'delegate_output.v1',
            summary: 'Summary',
            deliverables: [{ id: 'd1', title: 'Title', details: 'Details' }],
        };

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<DelegateOutputMessageCard payload={payload} />)).tree;

        const findTextNode = (text: string) => findTestInstanceByTypeContainingText(tree, 'Text', text)!;

        expect(findTextNode('Delegation output').props.selectable).toBe(true);
        expect(findTextNode('Summary').props.selectable).toBe(true);
        expect(findTextNode('Deliverables').props.selectable).toBe(true);
        expect(findTextNode('Title').props.selectable).toBe(true);
        expect(findTextNode('Details').props.selectable).toBe(true);
    });
});
