import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastLines: any[] | null = null;

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'filesDiffFoldingEnabled') return true;
        if (key === 'filesDiffFoldingContextThreshold') return 6;
        if (key === 'filesDiffFoldingContextRadius') return 2;
        return undefined;
    },
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: () => ({
        mode: 'off',
        language: null,
        maxBytes: 1_000_000,
        maxLines: 10_000,
        maxLineLength: 10_000,
    }),
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => {
        lastLines = props.lines;
        return React.createElement('CodeLinesView', props);
    },
}));

function buildDemoUnifiedDiff(): string {
    const lines: string[] = [];
    lines.push('@@ -1,15 +1,15 @@');
    for (let i = 1; i <= 10; i++) {
        lines.push(` line${i}`);
    }
    lines.push('-line11');
    lines.push('+line11changed');
    for (let i = 12; i <= 15; i++) {
        lines.push(` line${i}`);
    }
    lines.push('');
    return lines.join('\n');
}

describe('HappierUnifiedDiffViewer (folding)', () => {
    it('collapses long context blocks when folding is enabled', async () => {
        lastLines = null;
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

        await act(async () => {
            renderer.create(
                <HappierUnifiedDiffViewer
                    mode="unified"
                    unifiedDiff={buildDemoUnifiedDiff()}
                    filePath="src/demo.ts"
                />,
            );
        });

        if (!Array.isArray(lastLines)) throw new Error('Expected CodeLinesView lines');
        const lines = lastLines as unknown as unknown[];
        const texts = lines.map((line) => (line as any).renderCodeText);
        expect(texts).toContain('line1');
        expect(texts).toContain('line2');
        expect(texts).toContain('line9');
        expect(texts).toContain('line10');
        expect(texts).not.toContain('line3');
        expect(texts).not.toContain('line8');
    });
});
