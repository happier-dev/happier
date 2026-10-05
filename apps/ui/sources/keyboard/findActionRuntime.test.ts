import { describe, expect, it } from 'vitest';
import type { FindController, FindStatus } from '@happier-dev/plugin-ui/presentation';
import { createFindSurfaceRegistry } from './findSurfaceRegistry';
import { executeFindAction, registerFindActionRuntime } from './findActionRuntime';

describe('mounted ui.find Action', () => {
    it('distinguishes no mounted target from zero and controls the live model without disclosing text', async () => {
        const find = createFindSurfaceRegistry();
        const release = registerFindActionRuntime(find);
        let query = 'private original';
        let options = { matchCase: false, regex: false };
        let current: number | null = null;
        let open = false;
        let originCaptured = false;
        let stopped = false;
        const controller: FindController = {
            get query() { return query; }, get options() { return options; },
            get status(): FindStatus { return { kind: 'results', current, total: 0, coverage: 'partialErrors' }; },
            capabilities: { regex: true, stop: true },
            // The real surface model admits query updates by opening itself.
            setQuery(value) { query = value; open = true; }, setOptions(value) { options = value; },
            step(direction) { current = (current ?? 0) + direction; }, stop() { stopped = true; }, close() { open = false; },
        };
        const execute = (input: unknown) => executeFindAction({ actionId: 'ui.find', input, context: { surface: 'agent' } });
        try {
            await expect(execute({ op: 'read' })).resolves.toEqual({ ok: true, result: { status: 'noMountedSurface' } });
            find.register({ surfaceId: 'chat:1', controller, containsFocus: () => true,
                open: () => { if (!open) originCaptured = true; open = true; }, isOpen: () => open, isInputFocused: () => open });
            await expect(execute({ op: 'set', target: 'absent', query: 'secret' })).resolves.toEqual({ ok: true, result: { status: 'noMountedSurface' } });
            expect(query).toBe('private original');
            const snapshot = await execute({ op: 'set', target: 'chat:1', query: 'secret corpus query', options: { matchCase: true, regex: false } });
            expect(snapshot).toEqual({ ok: true, result: { status: 'results', current: null, total: 0, coverage: 'partialErrors' } });
            expect(JSON.stringify(snapshot)).not.toContain('secret');
            expect(query).toBe('secret corpus query'); expect(options.matchCase).toBe(true); expect(open).toBe(true);
            expect(originCaptured).toBe(true);
            await expect(execute({ op: 'step', direction: 1 })).resolves.toMatchObject({ result: { current: 1 } });
            await execute({ op: 'stop' }); expect(stopped).toBe(true);
            await execute({ op: 'close' }); expect(open).toBe(false);
            const cancelled = new AbortController(); cancelled.abort();
            await expect(executeFindAction({ actionId: 'ui.find', input: { op: 'set', query: 'cancelled' }, context: { signal: cancelled.signal } })).rejects.toBeDefined();
            expect(query).toBe('secret corpus query');
        } finally { release(); }
        await expect(execute({ op: 'read' })).resolves.toMatchObject({ result: { status: 'noMountedSurface' } });
    });

});
