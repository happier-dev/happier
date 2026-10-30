import { describe, expect, it } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPdfFindModel } from '@/components/ui/media/pdf/pdfFindModel';
import { createFindSurfaceRegistry } from './findSurfaceRegistry';
import { executeFindAction, registerFindActionRuntime } from './findActionRuntime';

describe('mounted ui.find Action', () => {
    it('reports refolding as unsupported on a surface without folding', async () => {
        const registry = createFindSurfaceRegistry();
        const release = registerFindActionRuntime(registry);
        const controller = createPdfFindModel({ reveal() {} });
        registry.register({ surfaceId: 'file', controller, containsFocus: () => true,
            open: controller.open, isOpen: () => controller.getSnapshot().open, isInputFocused: () => false });
        try {
            expect(await executeFindAction({ actionId: 'ui.find', input: { op: 'refold' }, context: { surface: 'agent' } }))
                .toEqual({ ok: true, result: { status: 'unavailable', reason: 'unsupportedOperation' } });
        } finally { release(); controller.close(); }
    });
    it('addresses read, navigation, stop and close to the named surface even when another surface has focus', async () => {
        const registry = createFindSurfaceRegistry();
        const release = registerFindActionRuntime(registry);
        const controller = createPdfFindModel({ reveal() {} });
        const focused = createPdfFindModel({ reveal() {} });
        try {
            // Only the pdf.js document/text extraction boundary is synthetic.
            controller.setDocument({ numPages: 1, getPage: async () => ({
                getTextContent: async () => ({ items: [{ str: 'needle needle needle' }] }),
            }) });
            focused.setDocument({ numPages: 1, getPage: async () => ({
                getTextContent: async () => ({ items: [{ str: 'other other' }] }),
            }) });
            controller.setQuery('needle');
            focused.setQuery('other');
            await Promise.all([controller.whenSettled(), focused.whenSettled()]);
            registry.register({ surfaceId: 'review', controller, containsFocus: () => false,
                open: controller.open, isOpen: () => controller.getSnapshot().open, isInputFocused: () => false });
            registry.register({ surfaceId: 'focused', controller: focused, containsFocus: () => true,
                open: focused.open, isOpen: () => focused.getSnapshot().open, isInputFocused: () => true });
            const execute = (input: unknown) => executeFindAction({ actionId: 'ui.find', input, context: { surface: 'agent' } });
            expect(await execute({ op: 'read' })).toMatchObject({ result: { current: 1, total: 2 } });
            expect(await execute({ op: 'read', target: 'review' })).toMatchObject({ result: { current: 1, total: 3 } });
            expect(await execute({ op: 'step', target: 'review', direction: 1 })).toMatchObject({ result: { current: 2, total: 3 } });
            expect(controller.status).toMatchObject({ kind: 'results', current: 2, total: 3 });
            expect(await execute({ op: 'step', target: 'review', direction: -1 })).toMatchObject({ result: { current: 1, total: 3 } });
            expect(controller.status).toMatchObject({ kind: 'results', current: 1, total: 3 });
            expect(await execute({ op: 'stop', target: 'review' })).toMatchObject({ result: { coverage: 'limited' } });
            expect(controller.status).toMatchObject({ kind: 'results', coverage: 'limited' });
            expect(await execute({ op: 'close', target: 'review' })).toMatchObject({ result: { status: 'idle' } });
            expect(controller.getSnapshot().open).toBe(false);
            expect(focused.getSnapshot()).toMatchObject({ open: true, query: 'other',
                status: { kind: 'results', current: 1, total: 2, coverage: 'complete' } });
        } finally { release(); controller.close(); focused.close(); }
    });
    it('distinguishes no mounted target from zero and controls the live model without disclosing text', async () => {
        const find = createFindSurfaceRegistry();
        const release = registerFindActionRuntime(find);
        const controller = createPdfFindModel({ reveal() {} });
        const pageText = createDeferred<{ items: Array<{ str: string }> }>();
        const pageEntered = createDeferred<void>();
        const lateText = createDeferred<{ items: Array<{ str: string }> }>();
        const latePageEntered = createDeferred<void>();
        const openingSnapshots: Array<{ open: boolean; query: string }> = [];
        controller.setQuery('private original');
        controller.close();
        controller.setDocument({ numPages: 2, getPage: async (page) => {
            if (page === 2) throw new Error('pdf_sdk_page_unavailable');
            return { getTextContent: () => { pageEntered.resolve(); return pageText.promise; } };
        } });
        const execute = (input: unknown) => executeFindAction({ actionId: 'ui.find', input, context: { surface: 'agent' } });
        try {
            await expect(execute({ op: 'read' })).resolves.toEqual({ ok: true, result: { status: 'noMountedSurface' } });
            find.register({ surfaceId: 'chat:1', controller, containsFocus: () => true,
                open: () => {
                    const { open, query } = controller.getSnapshot();
                    openingSnapshots.push({ open, query });
                    controller.open();
                }, isOpen: () => controller.getSnapshot().open, isInputFocused: () => controller.getSnapshot().open });
            await expect(execute({ op: 'set', target: 'absent', query: 'secret' })).resolves.toEqual({ ok: true, result: { status: 'noMountedSurface' } });
            expect(controller.getSnapshot()).toMatchObject({ query: 'private original', open: false });
            expect(openingSnapshots).toEqual([]);
            const pending = await execute({ op: 'set', target: 'chat:1', query: 'secret corpus query', options: { matchCase: true, regex: false } });
            await pageEntered.promise;
            expect(pending).toEqual({ ok: true, result: { status: 'searching', total: 0 } });
            expect(JSON.stringify(pending)).not.toContain('secret');
            expect(controller.getSnapshot()).toMatchObject({ query: 'secret corpus query', options: { matchCase: true, regex: false }, open: true });
            expect(openingSnapshots).toEqual([{ open: false, query: 'private original' }]);

            pageText.resolve({ items: [{ str: 'needle needle needle' }] });
            await controller.whenSettled();
            const snapshot = await execute({ op: 'read', target: 'chat:1' });
            expect(snapshot).toEqual({ ok: true, result: { status: 'results', current: null, total: 0, coverage: 'partialErrors' } });
            expect(JSON.stringify(snapshot)).not.toContain('secret');
            await expect(execute({ op: 'step', direction: 1 })).resolves.toMatchObject({ result: { current: null, total: 0 } });
            await execute({ op: 'set', query: 'needle' });
            await controller.whenSettled();
            await expect(execute({ op: 'step', direction: 1 })).resolves.toEqual({
                ok: true, result: { status: 'results', current: 2, total: 3, coverage: 'partialErrors' },
            });

            // Stop must retire an entered pdf.js extraction, not just set a fixture flag.
            controller.setDocument({ numPages: 1, getPage: async () => ({
                getTextContent: () => { latePageEntered.resolve(); return lateText.promise; },
            }) });
            await latePageEntered.promise;
            await expect(execute({ op: 'stop' })).resolves.toEqual({
                ok: true, result: { status: 'results', current: null, total: 0, coverage: 'limited' },
            });
            lateText.resolve({ items: [{ str: 'needle' }] });
            await controller.whenSettled();
            expect(controller.status).toEqual({ kind: 'results', current: null, total: 0, coverage: 'limited' });
            await expect(execute({ op: 'close' })).resolves.toEqual({ ok: true, result: { status: 'idle' } });
            expect(controller.getSnapshot().open).toBe(false);
            const cancelled = new AbortController(); cancelled.abort();
            await expect(executeFindAction({ actionId: 'ui.find', input: { op: 'set', query: 'cancelled' }, context: { signal: cancelled.signal } })).rejects.toBeDefined();
            expect(controller.getSnapshot()).toMatchObject({ query: 'needle', open: false });
        } finally {
            release();
            controller.close();
            pageText.resolve({ items: [] });
            lateText.resolve({ items: [] });
        }
        await expect(execute({ op: 'read' })).resolves.toMatchObject({ result: { status: 'noMountedSurface' } });
    });

});
