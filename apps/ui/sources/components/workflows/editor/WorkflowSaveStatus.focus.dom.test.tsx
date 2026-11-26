/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
        const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
        return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
    },
    text: async () => await vi.importActual('@/text'),
});
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

const { ModalProvider } = await import('@/modal/ModalProvider');
const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');

const draft = { draftId: 'draft', name: 'Locally edited title', version: 1 as const, defaults: {}, inputs: [], blocks: [] };
const conflict = { currentDraft: { ...draft, name: 'Different remote title' }, currentRevision: { headerVersion: 2, bodyVersion: 1 } };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

async function mountStatus(initial: React.ComponentProps<typeof WorkflowSaveStatus>['state']) {
    function Harness() {
        const [state, setState] = React.useState(initial);
        return <ModalProvider>
            <input data-testid="edited-field" defaultValue={draft.name} />
            <WorkflowSaveStatus state={state} localDraft={draft} testIDPrefix="editor" onSaveAsCopy={() => {}}
                onSave={() => setState({ kind: 'saving' })} />
        </ModalProvider>;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));
    const field = host.querySelector<HTMLInputElement>('[data-testid="edited-field"]')!;
    await act(async () => { field.focus(); field.setSelectionRange(3, 14); });
    return field;
}

async function press(testId: string) {
    const button = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => button.dispatchEvent(down));
    // jsdom does not implement the browser's default pointer focus transfer.
    if (!down.defaultPrevented) await act(async () => button.focus());
    await act(async () => button.click());
}

describe('Workflow Save and Compare focus', () => {
    it('keeps the edited field and its selection while saving with the pointer', async () => {
        const field = await mountStatus({ kind: 'unsaved' });
        await press('editor-save');
        expect(document.querySelector('[data-testid="editor-save"]')).toBeNull();
        expect(document.activeElement).toBe(field);
        expect([field.selectionStart, field.selectionEnd]).toEqual([3, 14]);
    });

    it('returns from the actual Compare card to the edited field and its selection', async () => {
        const field = await mountStatus({ kind: 'conflict', conflict });
        await press('editor-compare');
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => {
            expect(document.querySelector('[role="dialog"]')).toBeNull();
            expect(document.activeElement).toBe(field);
        });
        expect([field.selectionStart, field.selectionEnd]).toEqual([3, 14]);
    });
});
