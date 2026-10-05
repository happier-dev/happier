import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { createMessageStructuredPresentationV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from '@/components/tools/shell/views/ToolView.testHelpers';
import { createTranscriptFindRowStore } from '../find/transcriptFindRowStore';
import { TranscriptFindProvider } from '../find/TranscriptFindContext';
import { DeclarativeStructuredMessageRenderer } from './DeclarativeStructuredMessageRenderer';
import { StructuredFindMessageProvider } from './structuredFindText';

installToolShellCommonModuleMocks();

describe('frozen declarative Find decoration', () => {
    it('decorates repeated visible slots including shared list and metadata leaves and current Markdown', async () => {
        const root = createMessageStructuredPresentationV1({
            owner: { pluginId: 'acme.preview', contributionLocalId: 'card' },
            snapshot: {
                kind: 'group', title: 'needle heading', description: 'needle description', children: [
                    { kind: 'section', title: 'needle section', footer: 'needle footer', children: [
                        { kind: 'item', title: 'needle title', subtitle: 'needle subtitle', detail: 'needle detail' },
                    ] },
                    { kind: 'metadata', title: 'needle metadata', entries: [{ label: 'needle label', value: 'needle value' }] },
                    { kind: 'state', state: 'empty', title: 'needle state', description: 'needle reason' },
                    { kind: 'status', label: 'needle status', value: 'needle result' },
                    { kind: 'text', text: 'needle body' },
                    { kind: 'action', action: 'open', label: 'needle action' },
                    { kind: 'markdown', text: '**needle** [caption](https://hidden-target.invalid)' },
                ],
            },
        }).snapshot;
        const fields = [
            ['root', 'title'], ['root', 'description'],
            ['root.children[0]', 'title'], ['root.children[0]', 'footer'],
            ['root.children[0].children[0]', 'title'], ['root.children[0].children[0]', 'subtitle'], ['root.children[0].children[0]', 'detail'],
            ['root.children[1]', 'title'], ['root.children[1]', 'entries[0].label'], ['root.children[1]', 'entries[0].value'],
            ['root.children[2]', 'title'], ['root.children[2]', 'description'],
            ['root.children[3]', 'label'], ['root.children[3]', 'value'],
            ['root.children[4]', 'text'], ['root.children[5]', 'label'],
        ];
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['frozen', { blocks: [
            ...fields.map(([path, field]) => ({ id: `structured-declarative:${path}:${field}`, sourceRanges: [{ start: 0, end: 6, current: false }] })),
            { id: 'structured-declarative:root.children[6]:text', sourceRanges: [{ start: 2, end: 8, current: true }] },
        ] }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}>
            <StructuredFindMessageProvider messageId="frozen">
                <DeclarativeStructuredMessageRenderer root={root} showUnavailableActions />
            </StructuredFindMessageProvider>
        </TranscriptFindProvider>);
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
        expect(screen.findAllHostsByTestId('find-match-all').map((node) => node.children.join(''))).toEqual(fields.map(() => 'needle'));
        const action = screen.findByTestId('plugin-declarative-action:acme.preview/open');
        if (!action) throw new Error('Expected the frozen unavailable action');
        expect(action.props.disabled).toBe(true);
    });
});
