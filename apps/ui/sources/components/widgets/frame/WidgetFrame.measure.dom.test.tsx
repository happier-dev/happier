/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

import { WidgetFrame } from './WidgetFrame';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { buildWidgetFrameStyleActions } from './widgetFrameMenu';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
    ['keyboard', 'frameStyle'], ['pointer', 'frameStyle'],
    ['keyboard', 'frameStyleReset'], ['pointer', 'frameStyleReset'],
] as const)('returns focus to the mounted widget trigger after %s %s selection', async (input, actionId) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    const changed = vi.fn();
    function Harness() {
        const [override, setOverride] = React.useState<'card' | 'plain' | null>(actionId === 'frameStyleReset' ? 'plain' : null);
        return <WidgetFrame testID="capacity" frameStyle={override ?? 'card'} placement="home" title="Capacity"
            body={{ kind: 'content', children: <input data-testid="capacity-body" /> }}
            menu={<ItemRowActions title="Capacity" overflowOnly overflowTriggerTestID="capacity-options"
                actions={buildWidgetFrameStyleActions({ placement: 'home', surfaceDefault: 'card', override,
                    onSet: style => { changed(style); setOverride(style); } })} />} />;
    }
    try {
        await act(async () => root.render(<Harness />));
        const trigger = document.querySelector<HTMLElement>('[data-testid="capacity-options"]')!;
        const body = document.querySelector('[data-testid="capacity-body"]');
        trigger.focus();
        await act(async () => trigger.click());
        await vi.waitFor(() => expect(document.querySelector(`[data-testid="${actionId}"]`)).not.toBeNull());
        const option = document.querySelector<HTMLElement>(`[data-testid="${actionId}"]`)!;
        await act(async () => {
            option.focus();
            if (input === 'keyboard') {
                option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                option.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
                // jsdom does not perform a button's native Enter default action.
                expect(option.tagName).toBe('BUTTON');
                option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
            } else {
                option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
                option.click();
            }
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(changed).toHaveBeenCalledWith(actionId === 'frameStyleReset' ? null : 'plain');
        });
        expect(document.querySelector(`[data-testid="${actionId}"]`)).toBeNull();
        expect(document.querySelector('[data-testid="capacity-body"]')).toBe(body);
        expect(document.querySelector('[data-testid="capacity-options"]')).toBe(trigger);
        expect(trigger.isConnected).toBe(true);
        expect(document.activeElement).toBe(trigger);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('hands a web widget its measured room in the first commit, before any layout event can reach it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, width: 429, height: 307, top: 0, left: 0, right: 429, bottom: 307, toJSON: () => ({}),
    });
    const widths: Array<number | undefined> = [];
    function Body() {
        widths.push(useWidgetPresentation()?.geometry?.width);
        return <>laid out from its width</>;
    }
    try {
        // A jsdom page fires no layout events: only the frame's own first-commit read can tell the body its width.
        await act(async () => root.render(<WidgetFrame testID="measured" frameStyle="card" grouped placement="home" title="Capacity"
            widgetPresentation={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } }}
            body={{ kind: 'content', children: <Body /> }} />));
        expect(widths.at(-1)).toBe(429);
    } finally {
        measure.mockRestore();
        await act(async () => root.unmount());
        container.remove();
    }
});
