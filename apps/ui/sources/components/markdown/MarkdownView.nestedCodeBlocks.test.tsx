import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { MarkdownView } from './MarkdownView';
import { MarkdownCodeBlockWrapStateProvider } from './MarkdownCodeBlockWrapState';

const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The browser clipboard is the boundary; parser, code view and copy owner remain real.
beforeEach(() => {
    clipboard.writeText.mockClear();
    vi.stubGlobal('navigator', { clipboard });
});

afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

describe('MarkdownView nested code blocks', () => {
    it('renders and copies token labels in code while keeping Find offsets on their labels', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '```md\nRead [Auth](happier-ref:session:s1) after\n```';
        const start = markdown.indexOf('Auth');
        const screen = await renderScreen(<MarkdownView markdown={markdown} findSourceRanges={[{ start, end: start + 4, current: true }]} />);
        expect(screen.getTextContent()).not.toContain('happier-ref:');
        expect(screen.findAllHostsByTestId('find-match-current').map(node => node.children.join('')).join('')).toBe('Auth');
        const copy = screen.findAllByProps({ accessibilityLabel: t('common.copy') }).find(node => typeof node.type === 'string');
        await pressTestInstanceAsync(copy!, 'copy reference code label');
        expect(clipboard.writeText).toHaveBeenLastCalledWith('Read Auth after');
    });

    it('keeps code Find marks after custom options in the same special segment', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '<options>\n<option>choose</option>\n</options>\n```ts\nneedle\n```';
        const start = markdown.indexOf('needle');
        const screen = await renderScreen(<MarkdownView markdown={markdown} findSourceRanges={[{ start, end: start + 6, current: true }]} />);
        expect(screen.findAllHostsByTestId('find-match-current').map(node => node.children.join('')).join('')).toBe('needle');
    });

    it('highlights every occurrence in top-level indented code after indentation is removed', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '    first needle\n    second needle';
        const ranges = [...markdown.matchAll(/needle/g)].map(match => ({ start: match.index, end: match.index + 6, current: true }));
        const screen = await renderScreen(<MarkdownView markdown={markdown} findSourceRanges={ranges} />);
        expect(screen.findAllHostsByTestId('find-match-current').map(node => node.children.join('')).join('')).toBe('needleneedle');
    });

    it('keeps quote prose and indented code Find marks mapped to their displayed leaves', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '> **needle**\n> second needle\n>\n>   ```ts\n>   needle\n>     needle\n>   ```';
        const ranges = [...markdown.matchAll(/needle/g)].map(match => ({ start: match.index, end: match.index + 6, current: true }));
        const screen = await renderScreen(<MarkdownView markdown={markdown} findActive findSourceRanges={ranges} />);
        expect(screen.findAllHostsByTestId('find-match-current').map(node => node.children.join('')).join('')).toBe('needle'.repeat(4));
        expect(screen.findAllByTestId('code-wrap-lines-toggle').filter(node => typeof node.type === 'string')).toHaveLength(1);
    });

    it('keeps nested prose and code Find marks in the same code blocks with their wrap controls', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '- **Review needle**\n\n    ```ts\n    const needle = 1;\n    ```';
        const ranges = [...markdown.matchAll(/needle/g)].map(match => ({ start: match.index, end: match.index + 6, current: true }));
        const screen = await renderScreen(<MarkdownView markdown={markdown} findActive findSourceRanges={ranges} />);
        expect(screen.findAllHostsByTestId('find-match-current').map(node => node.children.join('')).join('')).toBe('needleneedle');
        expect(screen.findAllByTestId('code-wrap-lines-toggle').filter(node => typeof node.type === 'string')).toHaveLength(1);
    });

    it('renders list and quote code through the same independent, retained wrap controls', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '7. First item\n\n   ```ts\n   const first = 1;\n   ```\n8. Second item\n\n   > Quoted example\n   >\n   > ```yaml\n   > description: same text\n   > ```\n\n> ```yaml\n> description: same text\n> ```';
        function Transcript({ visible, suffix = '' }: Readonly<{ visible: boolean; suffix?: string }>) {
            return <MarkdownCodeBlockWrapStateProvider>{visible ? <MarkdownView markdown={markdown + suffix} codeBlockStateKey="nested-message" /> : null}</MarkdownCodeBlockWrapStateProvider>;
        }
        const screen = await renderScreen(<Transcript visible />);
        const switches = () => screen.findAllByProps({ role: 'switch' }).filter(node => typeof node.type === 'string');
        const checked = () => switches().map(node => node.props['aria-checked']);
        expect(checked()).toEqual([false, false, false]);
        expect(screen.getTextContent()).toContain('const first = 1;');
        expect(screen.getTextContent()).toContain('7.');
        expect(screen.getTextContent()).toContain('8.');
        await pressTestInstanceAsync(switches()[1]!, 'wrap nested quoted code');
        expect(checked()).toEqual([false, true, false]);
        await screen.update(<Transcript visible suffix={'\n\nMore streamed text.'} />);
        expect(checked()).toEqual([false, true, false]);
        await screen.update(<Transcript visible={false} />);
        await screen.update(<Transcript visible />);
        expect(checked()).toEqual([false, true, false]);
    });

    it('keeps code indentation and blank lines while removing only container markers', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '- Example\n\n  > ~~~python\n  > def example():\n  >     return 1\n  >\n  > print(example())\n  > ~~~';
        const screen = await renderScreen(<MarkdownView markdown={markdown} />);
        expect(screen.findAllByTestId('code-wrap-lines-toggle').filter(node => typeof node.type === 'string')).toHaveLength(1);
        const copy = screen.findAllByProps({ accessibilityLabel: t('common.copy') }).find(node => typeof node.type === 'string');
        expect(copy).toBeDefined();
        await pressTestInstanceAsync(copy!, 'copy nested code');
        expect(clipboard.writeText).toHaveBeenLastCalledWith('def example():\n    return 1\n\nprint(example())');
    });

    it('also exposes wrapping for indented code blocks', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'    first line\n      indented line\n\n- Example\n\n      nested line'} />);
        expect(screen.findAllByTestId('code-wrap-lines-toggle').filter(node => typeof node.type === 'string')).toHaveLength(2);
        const copies = screen.findAllByProps({ accessibilityLabel: t('common.copy') }).filter(node => typeof node.type === 'string');
        await pressTestInstanceAsync(copies[0]!, 'copy indented code');
        expect(clipboard.writeText).toHaveBeenLastCalledWith('first line\n  indented line');
    });

    it('removes opening-fence indentation without removing indentation within the code', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'- Example\n\n    ```js\n    foo()\n      extra\n    ```'} />);
        const copy = screen.findAllByProps({ accessibilityLabel: t('common.copy') }).find(node => typeof node.type === 'string');
        await pressTestInstanceAsync(copy!, 'copy indented nested fence');
        expect(clipboard.writeText).toHaveBeenLastCalledWith('foo()\n  extra');
    });

    it('preserves task-list interaction when a task contains a code block', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'- [ ] Review this example\n\n  ```ts\n  const value = 1;\n  ```'} />);
        const checkbox = () => screen.findAllByProps({ role: 'checkbox' }).find(node => typeof node.type === 'string');
        expect(checkbox()!.props['aria-checked']).toBe(false);
        expect(checkbox()!.props['aria-disabled']).not.toBe(true);
        await pressTestInstanceAsync(checkbox()!, 'check task');
        expect(checkbox()!.props['aria-checked']).toBe(true);
    });
});
