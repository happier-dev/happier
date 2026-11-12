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

it('names widget options from each frame title and updates the name without remounting its trigger', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const frames = (title: string) => <>
        {[title, 'Costs'].map((name, index) => <WidgetFrame key={index} testID={`named-frame-${index}`}
            frameStyle="card" placement="home" title={name} body={{ kind: 'content', children: 'Rows' }}
            menu={<div><ItemRowActions title="Fallback title" overflowOnly overflowTriggerTestID={`named-options-${index}`}
                overflowTriggerAccessibilityLabel="Widget options" actions={[{ id: 'rename', title: 'Rename', onPress: () => {} }]} /></div>} />)}
    </>;
    try {
        await act(async () => root.render(frames('Daily usage')));
        const trigger = container.querySelector<HTMLElement>('[data-testid="named-options-0"]')!;
        expect(trigger.getAttribute('aria-label')).toBe('Widget options: Daily usage');
        expect(container.querySelector('[data-testid="named-options-1"]')?.getAttribute('aria-label')).toBe('Widget options: Costs');
        await act(async () => root.render(frames('Daily budget')));
        expect(container.querySelector('[data-testid="named-options-0"]')).toBe(trigger);
        expect(trigger.getAttribute('aria-label')).toBe('Widget options: Daily budget');
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

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


it('gives a deferred width-dependent body its room on its only activation layout', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let active = false;
    // The OS layout boundary has width before deferred content gives the body height.
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        x: 0, y: 0, width: 330, height: active ? 240 : 0,
        top: 0, left: 0, right: 330, bottom: active ? 240 : 0, toJSON: () => ({}),
    }));
    const layouts: Array<number | undefined> = [];
    function Body() {
        const width = useWidgetPresentation()?.geometry?.width;
        React.useLayoutEffect(() => { layouts.push(width); });
        return <div style={{ height: width === 330 ? 240 : 664 }}>Width-dependent rows</div>;
    }
    const render = () => <WidgetFrame testID="deferred-room" frameStyle="card" placement="home" title="Capacity"
        bodyHeight="content"
        widgetPresentation={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } }}
        body={{ kind: 'content', children: active ? <Body /> : <div style={{ height: 0 }} /> }} />;
    try {
        await act(async () => root.render(render()));
        expect(layouts).toEqual([]);
        active = true;
        await act(async () => root.render(render()));
        expect(layouts).toEqual([330]);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});


it('retries an unavailable room when a deferred body activates with unchanged presentation', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let active = false;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        x: 0, y: 0, width: active ? 330 : 0, height: active ? 240 : 0,
        top: 0, left: 0, right: active ? 330 : 0, bottom: active ? 240 : 0, toJSON: () => ({}),
    }));
    const presentation = { size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } } as const;
    let width: number | undefined;
    function Body() {
        width = useWidgetPresentation()?.geometry?.width;
        return <>Width-dependent rows</>;
    }
    const render = () => <WidgetFrame testID="unavailable-room" frameStyle="card" placement="home" title="Capacity"
        bodyHeight="content" widgetPresentation={presentation}
        body={{ kind: 'content', children: active ? <Body /> : <div /> }} />;
    try {
        await act(async () => root.render(render()));
        active = true;
        await act(async () => root.render(render()));
        expect(width).toBe(330);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});
