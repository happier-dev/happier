/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installFormsCommonModuleMocks } from './formsTestHelpers';
import type { MultiTextInputHandle } from './MultiTextInput.web';
import type { WorkflowInvocationRecoveryPresentation } from '@/components/workflows/run/workflowRunDetailPresentation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installFormsCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

// Vitest's default resolver selects the native file; choose the real web owner
// exactly as Metro does, keeping the editor and every consumer's logic real.
vi.mock('@/components/ui/forms/MultiTextInput', async () => await import('./MultiTextInput.web'));

const { SessionAuthoringComposer } = await import('@/components/sessions/authoring/SessionAuthoringComposer');
const { applyDictationToComposer } = await import('@/components/sessions/agentInput/applyDictationToComposer');
const { default: MultiTextInputDemo } = await import('@/app/(app)/dev/multi-text-input');
const { WorkflowInvocationDetail } = await import('@/components/workflows/run/WorkflowInvocationDetail');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const rangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
const scrollBy = window.scrollBy;

beforeAll(() => {
    // jsdom has no layout engine. Only supply the browser geometry boundary;
    // ProseMirror selection, DOM observation and text transactions stay real.
    const rect = new DOMRect(0, 0, 1, 16);
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true,
        value: () => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null }) });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect });
    window.scrollBy = () => {};
});

afterAll(() => {
    if (rangeRects) Object.defineProperty(Range.prototype, 'getClientRects', rangeRects);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
    if (rangeBounds) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeBounds);
    else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    window.scrollBy = scrollBy;
});

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function render(element: React.ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(element));
    return container;
}

function readText(input: HTMLElement): string {
    return input instanceof HTMLTextAreaElement ? input.value : input.textContent ?? '';
}

async function typeText(input: HTMLElement, text: string) {
    await act(async () => {
        if (input instanceof HTMLTextAreaElement) {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
        } else {
            input.textContent = text;
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    });
}

async function pasteText(input: HTMLElement, text: string) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
        types: ['text/plain'], files: [], items: [], getData: (type: string) => type === 'text/plain' ? text : '',
    } });
    await act(async () => { input.dispatchEvent(event); });
    // jsdom has no browser editing default action. Emulate only an unhandled
    // native paste; an editor that handles the clipboard must insert it itself.
    if (!event.defaultPrevented) await typeText(input, readText(input) + text);
}

function expectPlain(input: HTMLElement, text: string) {
    expect(readText(input)).toBe(text);
    expect(input.querySelector('[data-composer-reference], [data-type="composerReference"], [contenteditable="false"]')).toBeNull();
    expect(container?.querySelector('[role="listbox"], [data-testid="agent-input-attachments-row"]')).toBeNull();
}

const recovery: WorkflowInvocationRecoveryPresentation = {
    canInspectExecution: false, canReattach: false, canRetrySameConversation: true, canRetryFreshAgent: false, canRetry: false,
    retryCausalInvocationIds: [], unavailableReasons: { reattach: null, retry: null, continueSameConversation: null, continueFreshAgent: null },
    canContinuePrepared: false, canRestoreWorkspace: false, canStartReviewedNewRun: false, canRunWithAnotherAgent: false,
    preparedRecovery: null, requiresUncertaintyAcknowledgement: false, waitingForStop: false,
    remainingNotStartedSiblingCount: null, workspaceUnavailable: false, workspace: null,
};

describe('plain-text MultiTextInput web consumers', () => {
    it.each([
        ['', 'AND more'],
        ['first.', 'first. AND more'],
        ['first. ', 'first. AND more'],
        ['first.\n', 'first.\nAND more'],
    ])('inserts dictation after %j with only the needed whitespace separator', async (prefix, expected) => {
        const inputRef = React.createRef<MultiTextInputHandle>();
        const states: Array<{ text: string; selection: { start: number; end: number } }> = [];
        const onSubmit = vi.fn();
        function Authoring() {
            const [value, setValue] = React.useState(prefix);
            return <SessionAuthoringComposer ref={inputRef} composerRef={null} value={value} onChangeText={setValue}
                testID="dictation-separator" onStateChange={state => states.push(state)}
                submitBehavior="submit" onKeyPress={() => { onSubmit(); return true; }} />;
        }
        const page = await render(<Authoring />);
        const selection = { start: prefix.length, end: prefix.length };
        await act(async () => {
            applyDictationToComposer({ input: inputRef.current, state: { text: prefix, selection }, text: 'AND more' });
        });
        expect(page.querySelector<HTMLElement>('[data-testid="dictation-separator"]')).not.toBeNull();
        // The real editor's plain-text publication retains paragraph breaks;
        // DOM textContent alone omits the newline between rendered blocks.
        expect(states.at(-1)?.text).toBe(expected);
        expect(states.at(-1)?.selection).toEqual({ start: expected.length, end: expected.length });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('keeps authoring typing, literal paste, selection, dictation and submit as plain text', async () => {
        const inputRef = React.createRef<MultiTextInputHandle>();
        const states: Array<{ text: string; selection: { start: number; end: number } }> = [];
        const onSubmit = vi.fn();
        function Authoring() {
            const [value, setValue] = React.useState('');
            return <SessionAuthoringComposer ref={inputRef} composerRef={null} value={value} onChangeText={setValue}
                testID="plain-authoring" onStateChange={state => states.push(state)}
                submitBehavior="submit" onKeyPress={event => {
                    if (event.key !== 'Enter' || event.shiftKey) return false;
                    onSubmit();
                    return true;
                }} />;
        }
        const page = await render(<Authoring />);
        const input = page.querySelector<HTMLElement>('[data-testid="plain-authoring"]')!;
        await typeText(input, 'Hello');
        await pasteText(input, ' [file](happier-ref:file:src%2Fa.ts)');
        const text = 'Hello [file](happier-ref:file:src%2Fa.ts)';
        expectPlain(input, text);
        await act(async () => inputRef.current!.setSelection({ start: 0, end: 5 }));
        await act(async () => {
            applyDictationToComposer({ input: inputRef.current, state: { text, selection: { start: 0, end: 5 } }, text: 'Review' });
        });
        expectPlain(input, 'Review [file](happier-ref:file:src%2Fa.ts)');
        expect(states.at(-1)?.selection).toEqual({ start: 6, end: 6 });
        expect(inputRef.current!.getCaretRect()).toEqual({ left: expect.any(Number), top: expect.any(Number), height: expect.any(Number) });
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        expect(onSubmit).toHaveBeenCalledOnce();
    });

    it('keeps workflow continuation and replacement buffers literal and independently submittable', async () => {
        const onRetry = vi.fn();
        const onContinue = vi.fn();
        function Invocation() {
            const [replacementText, setReplacementText] = React.useState('');
            const [continuationText, setContinuationText] = React.useState('');
            return <WorkflowInvocationDetail progress={null} recovery={{ ...recovery,
                canContinuePrepared: true, preparedRecovery: { conversation: 'same_conversation', input: { kind: 'original' } },
            }} workspaceSourceLabel={null}
                continuationText={continuationText} onChangeContinuationText={setContinuationText}
                replacementText={replacementText} onChangeReplacementText={setReplacementText}
                onRetryWithReplacement={onRetry} onContinuePrepared={onContinue} testIDPrefix="plain-workflow" />;
        }
        const page = await render(<Invocation />);
        await act(async () => page.querySelector<HTMLElement>('[data-testid="plain-workflow-edit-continuation"]')!.click());
        const continuationInput = page.querySelector<HTMLElement>('[data-testid="plain-workflow-continuation-input"]')!;
        const continuationText = '[file](happier-ref:file:unbound)';
        await pasteText(continuationInput, continuationText);
        expectPlain(continuationInput, continuationText);
        await act(async () => page.querySelector<HTMLElement>('[data-testid="plain-workflow-use-replacement-input"]')!.click());
        const input = page.querySelector<HTMLElement>('[data-testid="plain-workflow-replacement-input"]')!;
        const text = '[Session](happier-ref:session:unbound)';
        await pasteText(input, text);
        expectPlain(input, text);
        await act(async () => page.querySelector<HTMLElement>('[data-testid="plain-workflow-submit-replacement"]')!.click());
        expect(onRetry).toHaveBeenCalledWith({ conversation: 'same_conversation', document: { text, references: [], attachments: [] }, input: [] });
        expectPlain(continuationInput, continuationText);
        await act(async () => page.querySelector<HTMLElement>('[data-testid="plain-workflow-continue-prepared"]')!.click());
        expect(onContinue).toHaveBeenCalledWith({ conversation: 'same_conversation', document: { text: continuationText, references: [], attachments: [] }, input: [] });
    });

    it('keeps the dev examples independent and retains Enter and Escape handling', async () => {
        const page = await render(<MultiTextInputDemo />);
        const inputs = [...page.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"]')];
        expect(inputs).toHaveLength(5);
        const text = '[x](happier-ref:file:plain)';
        await pasteText(inputs[0]!, text);
        expectPlain(inputs[0]!, text);
        expect(readText(inputs[1]!)).toContain('This is some initial text');
        await typeText(inputs[4]!, 'Send this');
        await act(async () => { inputs[4]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        expect(readText(inputs[4]!)).toBe('');
        await typeText(inputs[4]!, 'Clear this');
        await act(async () => { inputs[4]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(readText(inputs[4]!)).toBe('');
        expectPlain(inputs[0]!, text);
    });
});
