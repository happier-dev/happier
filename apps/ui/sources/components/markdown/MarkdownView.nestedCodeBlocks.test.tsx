import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { MarkdownView } from './MarkdownView';
import { MarkdownCodeBlockWrapStateProvider } from './MarkdownCodeBlockWrapState';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
// The OS clipboard is the boundary; the parser, code view and copy action remain real.
vi.mock('expo-clipboard', () => clipboard);

afterEach(standardCleanup);

describe('MarkdownView nested code blocks', () => {
    it('renders list and quote code through the same independent, retained wrap controls', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = '7. First item\n\n   ```ts\n   const first = 1;\n   ```\n8. Second item\n\n   > Quoted example\n   >\n   > ```yaml\n   > description: same text\n   > ```\n\n> ```yaml\n> description: same text\n> ```';
        function Transcript({ visible, suffix = '' }: Readonly<{ visible: boolean; suffix?: string }>) {
            return <MarkdownCodeBlockWrapStateProvider>{visible ? <MarkdownView markdown={markdown + suffix} codeBlockStateKey="nested-message" /> : null}</MarkdownCodeBlockWrapStateProvider>;
        }
        const screen = await renderScreen(<Transcript visible />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' }).filter(node => typeof node.type === 'string');
        const checked = () => switches().map(node => node.props.accessibilityState.checked);
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
        expect(clipboard.setStringAsync).toHaveBeenLastCalledWith('def example():\n    return 1\n\nprint(example())');
    });

    it('also exposes wrapping for indented code blocks', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'    first line\n      indented line\n\n- Example\n\n      nested line'} />);
        expect(screen.findAllByTestId('code-wrap-lines-toggle').filter(node => typeof node.type === 'string')).toHaveLength(2);
        const copies = screen.findAllByProps({ accessibilityLabel: t('common.copy') }).filter(node => typeof node.type === 'string');
        await pressTestInstanceAsync(copies[0]!, 'copy indented code');
        expect(clipboard.setStringAsync).toHaveBeenLastCalledWith('first line\n  indented line');
    });

    it('removes opening-fence indentation without removing indentation within the code', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'- Example\n\n    ```js\n    foo()\n      extra\n    ```'} />);
        const copy = screen.findAllByProps({ accessibilityLabel: t('common.copy') }).find(node => typeof node.type === 'string');
        await pressTestInstanceAsync(copy!, 'copy indented nested fence');
        expect(clipboard.setStringAsync).toHaveBeenLastCalledWith('foo()\n  extra');
    });

    it('preserves task-list interaction when a task contains a code block', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'- [ ] Review this example\n\n  ```ts\n  const value = 1;\n  ```'} />);
        const checkbox = () => screen.findAllByProps({ accessibilityRole: 'checkbox' }).find(node => typeof node.type === 'string');
        expect(checkbox()!.props.accessibilityState.checked).toBe(false);
        expect(checkbox()!.props.accessibilityState.disabled).not.toBe(true);
        await pressTestInstanceAsync(checkbox()!, 'check task');
        expect(checkbox()!.props.accessibilityState.checked).toBe(true);
    });
});
