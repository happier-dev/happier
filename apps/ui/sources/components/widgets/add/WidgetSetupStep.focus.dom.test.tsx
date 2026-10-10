/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { resolveWidgetBindingsV1 } from '@happier-dev/protocol/widgets';
import type { WidgetSetup } from './widgetSetupModel';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

import { WidgetSetupStep } from './WidgetSetupStep';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['typing', 'arrival'] as const)('preserves the %s intent from the setup command through menu mount, rerender and late choices', async intent => {
    const search = document.createElement('input');
    const container = document.createElement('div');
    document.body.append(search, container);
    const root = createRoot(container);
    const commandRef = React.createRef<(() => void) | null>();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    const fields = [{ field: { path: 'session', title: 'Session', widget: 'select' as const, required: true },
        // An ambiguous surface offer cannot supply a default or a single Follow row.
        follow: { slot: 'session', label: 'Sessions', values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } }];
    const initial = { bindings: {} };
    const setup: WidgetSetup = {
        title: 'Session summary', submitLabel: 'Add', initial, fields,
        resolve: draft => resolveWidgetBindingsV1({ instance: { v: 1, id: 'preview',
            definition: { kind: 'builtin', id: 'session-summary' }, bindings: draft.bindings },
            fields: fields.map(entry => entry.field), context: {}, viewerValues: {}, validateValue: () => ({ status: 'valid' }) }),
        submit: async () => ({ ok: true }),
    };
    function InputAfterCommandCommit({ requested }: { requested: boolean }) {
        React.useLayoutEffect(() => {
            if (!requested || intent !== 'typing') return;
            search.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
            search.value = 'Session summaryx';
            search.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }));
        }, [requested]);
        return null;
    }
    const render = (requested: boolean, ready: boolean) => <>
        <WidgetSetupStep setup={ready ? { ...setup, fields: fields.map(entry => ({ ...entry, field: {
            ...entry.field, options: Array.from({ length: 6 }, (_, index) => ({ value: `session-${index}`, label: `Session ${index}` })),
        } })) } : { ...setup }} phone={false} commandRef={commandRef} onDone={() => {}} testID="setup" />
        <InputAfterCommandCommit requested={requested} />
    </>;
    try {
        await act(async () => root.render(render(false, false)));
        search.focus();
        expect(commandRef.current).toBeTypeOf('function');
        await act(async () => { commandRef.current!(); root.render(render(true, false)); });
        expect(document.querySelector('[data-testid="setup.field.session.option.0"]')).toBeNull();
        await act(async () => root.render(render(true, false)));
        await act(async () => root.render(render(true, true)));
        const first = document.querySelector('[data-testid="setup.field.session.option.0"]');
        expect(first).not.toBeNull();
        expect(document.activeElement).toBe(intent === 'typing' ? search : first);
        if (intent === 'typing') expect(search.value).toBe('Session summaryx');
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        search.remove(); container.remove();
    }
});
