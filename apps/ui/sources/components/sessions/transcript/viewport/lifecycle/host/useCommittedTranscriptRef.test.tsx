import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useCommittedTranscriptRef } from './useCommittedTranscriptRef';

type CallbackFamily = Readonly<{
    attemptEntryRestore: () => void;
    resolveJumpIndex: () => void;
    runArmedPrependContinuation: () => void;
    scheduleViewportCapture: () => void;
}>;

type CallbackRefs = {
    [K in keyof CallbackFamily]: { current: CallbackFamily[K] };
};

type HarnessProps = Readonly<{
    callbacks: CallbackFamily;
    callbackRefs: CallbackRefs;
    observeChildLayout: () => void;
    shouldSuspend?: boolean;
}>;

const neverSettles = new Promise<never>(() => {});

function ChildLayoutProbe(props: Readonly<{ observe: () => void }>) {
    React.useLayoutEffect(() => {
        props.observe();
    });
    return null;
}

function CallbackPublicationHarness(props: HarnessProps) {
    useCommittedTranscriptRef(props.callbackRefs.attemptEntryRestore, props.callbacks.attemptEntryRestore);
    useCommittedTranscriptRef(props.callbackRefs.resolveJumpIndex, props.callbacks.resolveJumpIndex);
    useCommittedTranscriptRef(
        props.callbackRefs.runArmedPrependContinuation,
        props.callbacks.runArmedPrependContinuation,
    );
    useCommittedTranscriptRef(
        props.callbackRefs.scheduleViewportCapture,
        props.callbacks.scheduleViewportCapture,
    );
    if (props.shouldSuspend === true) throw neverSettles;
    return <ChildLayoutProbe observe={props.observeChildLayout} />;
}

function renderHarness(props: HarnessProps): React.ReactElement {
    return (
        <React.Suspense fallback={null}>
            <CallbackPublicationHarness {...props} />
        </React.Suspense>
    );
}

function createCallbackFamily(label: string, calls: string[]): CallbackFamily {
    return {
        attemptEntryRestore: () => calls.push(`${label}:entry`),
        resolveJumpIndex: () => calls.push(`${label}:jump`),
        runArmedPrependContinuation: () => calls.push(`${label}:prepend`),
        scheduleViewportCapture: () => calls.push(`${label}:capture`),
    };
}

function invokeFamily(refs: CallbackRefs): void {
    refs.attemptEntryRestore.current();
    refs.resolveJumpIndex.current();
    refs.runArmedPrependContinuation.current();
    refs.scheduleViewportCapture.current();
}

describe('useCommittedTranscriptRef', () => {
    it('keeps externally callable A callbacks through abandoned B and publishes all committed B callbacks before child layout', async () => {
        const calls: string[] = [];
        const callbacksA = createCallbackFamily('a', calls);
        const callbacksB = createCallbackFamily('b', calls);
        const callbackRefs: CallbackRefs = {
            attemptEntryRestore: { current: callbacksA.attemptEntryRestore },
            resolveJumpIndex: { current: callbacksA.resolveJumpIndex },
            runArmedPrependContinuation: { current: callbacksA.runArmedPrependContinuation },
            scheduleViewportCapture: { current: callbacksA.scheduleViewportCapture },
        };
        const observeChildLayout = vi.fn(() => invokeFamily(callbackRefs));
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness({
                callbacks: callbacksA,
                callbackRefs,
                observeChildLayout,
            }), { unstable_isConcurrent: true } as unknown as renderer.TestRendererOptions);
        });
        calls.length = 0;

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderHarness({
                    callbacks: callbacksB,
                    callbackRefs,
                    observeChildLayout,
                    shouldSuspend: true,
                }));
            });
            await Promise.resolve();
        });

        invokeFamily(callbackRefs);
        expect(calls).toEqual(['a:entry', 'a:jump', 'a:prepend', 'a:capture']);
        calls.length = 0;

        await act(async () => {
            tree.update(renderHarness({
                callbacks: callbacksB,
                callbackRefs,
                observeChildLayout,
            }));
        });

        expect(calls).toEqual(['b:entry', 'b:jump', 'b:prepend', 'b:capture']);
        calls.length = 0;
        invokeFamily(callbackRefs);
        expect(calls).toEqual(['b:entry', 'b:jump', 'b:prepend', 'b:capture']);

        await act(async () => {
            tree.unmount();
        });
    });
});
