// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout, type WebLayoutMeasurement, type WebLayoutRect } from '@/dev/testkit/render/measureWebLayout';

/** The editor's save/readout line as a browser lays it out (DESIGN-9 N51). */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

const ISSUES = '2 things to fix before this can run';

/** `ready`: the quiet readout; `issues`: the readout that leads to the first issue. */
async function measureLine(width: number, readout: 'ready' | 'issues', inHeader = false): Promise<WebLayoutMeasurement> {
    const { WorkflowSaveStatus, WorkflowStatusReadout } = await import('./WorkflowSaveStatus');
    const { Text } = await import('@/components/ui/text/Text');
    const { createWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowEditorDraft');
    const { HappierPageHeader } = await import('@happier-dev/plugin-ui/presentation');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const draft = createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Release', blocks: [] });
    await act(async () => {
        const status = React.createElement(WorkflowSaveStatus, {
            state: { kind: 'unsaved' },
            localDraft: draft,
            onSave: () => {},
            onSaveAsCopy: () => {},
            readout: readout === 'ready'
                ? React.createElement(Text, { testID: 'readout' }, 'Ready')
                : React.createElement(WorkflowStatusReadout, { testID: 'readout', text: ISSUES, onPress: () => {} }),
            testIDPrefix: 'editor',
        });
        root!.render(inHeader
            ? <View style={{ width }}><HappierPageHeader title="Workflow" actionsLayout="inline"
                actions={<View style={{ width: 220, height: 32 }} />}
                status={status} testID="header" /><View testID="document" style={{ height: 20 }} /></View>
            : React.createElement(View, { style: { width, alignItems: 'flex-end' } }, status));
    });
    return measureWebLayout(host, { viewport: { width: Math.max(width, 400), height: 400 }, texts: ['·', 'Save', 'Ready', ISSUES],
        ...(inHeader && process.env.HAPPIER_TEST_WEB_LAYOUT_ARTIFACT_DIR ? {
            screenshotPath: `${process.env.HAPPIER_TEST_WEB_LAYOUT_ARTIFACT_DIR}/header-${width}-${readout}.png`,
        } : {}),
        settle: replay => act(replay) });
}

function sameLine(a: WebLayoutRect, b: WebLayoutRect): boolean {
    return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= 3;
}

describe('the save/readout line, as a browser lays it out', () => {
    it.each(['ready', 'issues'] as const)('spaces every "·" the same on both sides, whatever surrounds it (%s)', async (readout) => {
        const layout = await measureLine(600, readout);
        const status = layout.rect('editor-save-status-text');
        const save = layout.textRects('Save')[0]!;
        const value = layout.textRects(readout === 'ready' ? 'Ready' : ISSUES)[0]!;
        const dots = layout.textRects('·');
        expect(dots).toHaveLength(2);
        const gaps = [
            dots[0]!.left - status.right,
            save.left - dots[0]!.right,
            dots[1]!.left - save.right,
            value.left - dots[1]!.right,
        ];
        for (const gap of gaps) expect(Math.abs(gap - gaps[0]!)).toBeLessThanOrEqual(1);
    });

    it('never leaves an orphan separator at either end of a wrapped line', async () => {
        const layout = await measureLine(220, 'issues');
        const words = [
            layout.rect('editor-save-status-text'),
            layout.textRects('Save')[0]!,
            layout.textRects(ISSUES)[0]!,
        ];
        expect(layout.rect('editor-save-status').height).toBeGreaterThan(words[0]!.height);
        for (const dot of layout.textRects('·')) {
            expect(words.some((word) => sameLine(word, dot) && word.right <= dot.left + 1)).toBe(true);
            expect(words.some((word) => sameLine(word, dot) && word.left >= dot.right - 1)).toBe(true);
        }
    });

    it.each([390, 600])('keeps the document and title in place when the header readout wraps to two lines (%spx)', async width => {
        const quiet = await measureLine(width, 'ready', true);
        await act(async () => root?.unmount());
        root = null;
        host?.remove();
        const wrapped = await measureLine(width, 'issues', true);
        expect(wrapped.rect('editor-save-status').height).toBeGreaterThan(quiet.rect('editor-save-status').height);
        expect(wrapped.rect('document').top).toBe(quiet.rect('document').top);
        expect(wrapped.rect('header-title-row').top).toBe(quiet.rect('header-title-row').top);
        console.info(`Header ${width}px: document y=${quiet.rect('document').top} → ${wrapped.rect('document').top}, status height=${quiet.rect('editor-save-status').height} → ${wrapped.rect('editor-save-status').height}`);
    });
});
