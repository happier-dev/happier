// @vitest-environment jsdom
import { act } from 'react';
import { jsxDEV } from 'react/jsx-dev-runtime';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { INJECTED_ELEMENTS_RUNTIME } from '@happier-dev/peer-mediation/browser/collector/elements';
import { BrowserDiagnosticsElementPickerResultV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import { React19FixtureSource } from '@/dev/testkit/fixtures/browserPickedElement';

function React19FixtureApp() {
    return jsxDEV(React19FixtureSource, {}, undefined, false);
}

function createPicker() {
    const results: unknown[] = [];
    // eslint-disable-next-line no-new-func -- evaluate the shipped runtime and its real event handlers.
    const factory = new Function('window', 'document', 'postEnvelope', `
        var config = {
            browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 3,
            collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' }
        };
        var pickerNodeRefs = new WeakMap();
        var pickerSeq = 0;
        var highlightedPickerNode = null;
        var highlightedPickerOutline = '';
        var activePicker = null;
        function postEvents() {}
        function baseEvent() { return { redaction: {} }; }
        ${INJECTED_ELEMENTS_RUNTIME}
        return {
            start: function () {
                startElementPicker({ pickerRequestId: 'pick_source', diagnosticsInteractionEnabled: true });
            },
            stop: teardownElementPicker
        };
    `) as (pageWindow: Window, pageDocument: Document, postEnvelope: (value: { result: unknown }) => void) => {
        start: () => void;
        stop: () => void;
    };
    return { ...factory(window, document, (envelope) => results.push(envelope.result)), results };
}

describe('picked React element source', () => {
    it('carries the real React 19 selected JSX callsite rather than its mounting parent', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const picker = createPicker();
        try {
            await act(async () => root.render(jsxDEV(React19FixtureApp, {}, undefined, false)));
            const node = container.querySelector('#picked-source');
            expect(node).not.toBeNull();
            const fiberKey = Object.keys(node!).find((key) => key.startsWith('__reactFiber$'));
            expect(fiberKey).toBeDefined();
            const fiber = (node as unknown as Record<string, unknown>)[fiberKey!] as {
                _debugStack?: Error;
                _debugSource?: unknown;
            };
            // This is a producer fixture: React creates the metadata; the test never attaches it.
            expect(fiber._debugSource).toBeUndefined();
            expect(fiber._debugStack?.stack).toContain('React19FixtureSource');

            picker.start();
            node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

            const result = BrowserDiagnosticsElementPickerResultV1Schema.parse(picker.results[0]);
            expect(result).toMatchObject({ status: 'selected', componentName: 'React19FixtureSource' });
            expect(result.sourceLocation).toMatchObject({
                file: expect.stringMatching(/\/browserPickedElement\.ts$/),
                line: expect.any(Number),
                column: expect.any(Number),
            });
        } finally {
            picker.stop();
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it.each([
        {
            name: 'V8 Windows paths',
            stack: 'Error: react-stack-top-frame\n    at jsxDEV (C:\\repo\\node_modules\\react.js:343:11)\n    at StackFixture (C:\\repo\\src\\Button.tsx:42:7)',
            sourceLocation: { file: 'C:\\repo\\src\\Button.tsx', line: 42, column: 7 },
        },
        {
            name: 'Firefox and Safari owner stacks',
            stack: 'jsxDEV@http://localhost/react.js:343:11\nStackFixture@http://localhost/src/Button.tsx:42:7',
            sourceLocation: { file: 'http://localhost/src/Button.tsx', line: 42, column: 7 },
        },
        {
            name: 'unavailable React owner stacks',
            stack: 'Error: react-stack-top-frame\n    at UnknownOwner (http://localhost/react.js:300:11)\n    at Object.react_stack_bottom_frame (http://localhost/react.js:312:9)',
            sourceLocation: undefined,
        },
    ])('reads $name only when selected and omits unavailable locations', ({ stack, sourceLocation }) => {
        const node = document.createElement('button');
        document.body.append(node);
        let stackReads = 0;
        // Constructed engine-format vectors complement the real React producer fixture above.
        Object.defineProperty(node, '__reactFiber$stack_fixture', {
            enumerable: true,
            value: {
                type: function StackFixture() {},
                _debugStack: { get stack() { stackReads += 1; return stack; } },
            },
        });
        const picker = createPicker();
        try {
            picker.start();
            node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            expect(stackReads).toBe(0);
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            const result = BrowserDiagnosticsElementPickerResultV1Schema.parse(picker.results[0]);
            expect(result.componentName).toBe('StackFixture');
            expect(result.sourceLocation).toEqual(sourceLocation);
            expect(stackReads).toBe(1);
        } finally {
            picker.stop();
            node.remove();
        }
    });
});
