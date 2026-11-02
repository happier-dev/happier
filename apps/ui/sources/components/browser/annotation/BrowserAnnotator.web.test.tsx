/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });
// The platform resolver's choice under Vitest, which doesn't pick `.web` files. The web canvas's own graph
// reaches this module again (through the keyboard owner and MediaStage), so the factory must not await it:
// it hands out a component that renders the web canvas once the test has loaded it.
const webCanvas = vi.hoisted(() => ({ Canvas: null as null | React.ComponentType<{ annotator: ImageAnnotator }> }));
vi.mock('@/components/ui/media/annotation/AnnotatorCanvas', () => ({
    AnnotatorCanvas: (props: { annotator: ImageAnnotator }) => (webCanvas.Canvas ? <webCanvas.Canvas {...props} /> : null),
}));
webCanvas.Canvas = (await import('@/components/ui/media/annotation/AnnotatorCanvas.web')).AnnotatorCanvas;

const { BrowserAnnotatorBar, BrowserAnnotatorMount, BrowserAnnotatorStage, useBrowserAnnotatorStageControl } = await import('./BrowserAnnotator');
import type { BrowserAnnotatorSession } from './BrowserAnnotator';
import type { ImageAnnotator } from '@/components/ui/media/annotation';

const source = { uri: 'data:image/png;base64,AA', width: 800, height: 600, scale: 2 };
const blank: ImageMarksDocumentV1 = { v: 1, image: { width: 800, height: 600, scale: 2 }, marks: [] };
const marked: ImageMarksDocumentV1 = { ...blank, marks: [{ id: 'e', kind: 'element', rect: { x: 10, y: 10, width: 40, height: 40 }, label: 'TotalRow', color: 'red' }] };

function Host(props: Readonly<{ session: BrowserAnnotatorSession }>) {
    const [annotator, setAnnotator] = React.useState<ImageAnnotator | null>(null);
    const control = useBrowserAnnotatorStageControl({ annotator, session: props.session });
    return (
        <>
            <BrowserAnnotatorMount session={props.session} onAnnotator={setAnnotator} />
            {annotator ? <BrowserAnnotatorBar annotator={annotator} phone={false} onClose={control.close} attach={control.attach} escapeScope={control.escapeScope} /> : null}
            {annotator ? <BrowserAnnotatorStage annotator={annotator} session={props.session} phone={false} control={control} /> : null}
        </>
    );
}

function mount(overrides: Partial<BrowserAnnotatorSession> = {}) {
    const calls: string[] = [];
    const session: BrowserAnnotatorSession = {
        source,
        document: blank,
        comment: '',
        pageLabel: 'Fieldnote — Checkout',
        onDocumentChange: () => calls.push('document'),
        onCommentChange: async (comment) => { calls.push(`comment:${comment}`); return { ok: true }; },
        onAttach: async () => { calls.push('attach'); return { ok: true }; },
        onCancel: () => calls.push('cancel'),
        ...overrides,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<Host session={session} />));
    return { container, root, calls };
}

const byTestId = (container: Element, id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const press = (node: HTMLElement | null) => act(async () => { node?.click(); await Promise.resolve(); });

describe('BrowserAnnotator', () => {
    afterEach(() => { document.body.replaceChildren(); });

    it('offers Element only with a page to ask, and lands the comment before one attach', async () => {
        const plain = mount();
        expect(byTestId(plain.container, 'annotator-tool-element')).toBeNull();
        const asked = mount({ element: { activate: () => () => {}, hover: () => {}, pick: async () => null } });
        expect(byTestId(asked.container, 'annotator-tool-element')?.getAttribute('aria-checked')).toBe('true');
        await press(byTestId(plain.container, 'browser-annotator-attach'));
        expect(plain.calls).toEqual(['attach']);
    });

    it('leaves at once when nothing would be lost and asks first when marks would', async () => {
        const clean = mount();
        await press(byTestId(clean.container, 'browser-annotator-close'));
        expect(clean.calls).toEqual(['cancel']);
        const dirty = mount({ document: marked });
        await press(byTestId(dirty.container, 'browser-annotator-close'));
        expect(dirty.calls).toEqual([]);
        expect(byTestId(dirty.container, 'browser-annotator-keep')).not.toBeNull();
        await press(byTestId(dirty.container, 'browser-annotator-keep'));
        expect(byTestId(dirty.container, 'browser-annotator-keep')).toBeNull();
        await press(byTestId(dirty.container, 'browser-annotator-close'));
        await press(byTestId(dirty.container, 'browser-annotator-discard'));
        expect(dirty.calls).toEqual(['cancel']);
    });
});
