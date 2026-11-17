import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => (key === 'hunkReview.unchangedLines' ? `${(params as { count: number }).count} unchanged lines` : key),
}));

const codeLinesViewType = Reflect.get(CodeLinesView, 'type') ?? CodeLinesView;

async function drawnLines(oldText: string, newText: string): Promise<readonly CodeLine[]> {
    const { HappierTextDiffViewer } = await import('./HappierTextDiffViewer');
    const screen = await renderScreen(<HappierTextDiffViewer mode="text" oldText={oldText} newText={newText} contextLines={3} />);
    return screen.findAllByType(codeLinesViewType)[0]!.props.lines;
}

describe('HappierTextDiffViewer hunk separators', () => {
    afterEach(() => standardCleanup());

    it('draws an edit snippet as its lines alone: no raw @@ header above them', async () => {
        const lines = await drawnLines('await db.payments.insert(event)', 'await db.payments.upsert(event)');
        expect(lines.map(line => line.kind)).toEqual(['remove', 'add']);
        expect(lines.some(line => line.renderCodeText.startsWith('@@'))).toBe(false);
    });

    it('separates distant changes with the quiet "N unchanged lines" band, as Pierre does', async () => {
        const oldText = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join('');
        const newText = oldText.replace('line 3\n', 'changed 3\n').replace('line 15\n', 'changed 15\n');
        const separators = (await drawnLines(oldText, newText)).filter(line => line.renderIsHeaderLine);
        expect(separators.map(line => [line.renderCodeText, line.renderIsSeparatorLine])).toEqual([['5 unchanged lines', true]]);
    });
});
