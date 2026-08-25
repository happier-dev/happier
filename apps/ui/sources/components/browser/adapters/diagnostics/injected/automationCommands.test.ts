// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { INJECTED_ELEMENTS_RUNTIME } from './elements';

/**
 * The injected automation runtime is a JavaScript source string, so nothing in the TypeScript build
 * can tell you whether a verb the capability matrix advertises actually has a handler. It could
 * not: the UB-1 matrix pass found `hover` and `press` advertised as available while the command
 * router fell through to `unsupported_action` for both.
 *
 * These tests evaluate the real runtime string against a real DOM and drive commands through the
 * real router, so an advertised verb that has no handler fails here.
 */

type AutomationEnvelope = Readonly<{
    kind: string;
    commandId: string;
    ok: boolean;
    errorCode?: string;
    data: Record<string, unknown>;
}>;

type AutomationHarness = Readonly<{
    run: (commandName: string, payload?: Record<string, unknown>) => AutomationEnvelope;
    selectedElementPayload: (node: Element) => Record<string, unknown>;
}>;

const CONFIG = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 3,
    collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
} as const;

/**
 * A minimal `DataTransfer`, because jsdom ships none. The runtime only needs `items.add` and a
 * `files` list, which is exactly the surface a real engine exposes to the upload path.
 */
class FakeDataTransfer {
    public readonly files: File[] = [];

    public readonly items = {
        add: (file: File): void => {
            this.files.push(file);
        },
    };
}

/**
 * jsdom's `MouseEvent` constructor rejects the window vitest hands the test realm
 * (`member view is not of type Window`), so every mouse verb the runtime dispatches would be
 * swallowed by its own best-effort try/catch and the harness would prove nothing. A real browser
 * accepts its own `window` as `view`. These shims model the browser: same constructor surface,
 * same event types, `view` carried rather than brand-checked. jsdom also ships no `DragEvent`
 * at all, so the drag path gets the same treatment plus the `dataTransfer` a real one carries.
 */
class HarnessMouseEvent extends MouseEvent {
    public constructor(type: string, init: MouseEventInit = {}) {
        const { view, ...rest } = init;
        super(type, rest);
        Object.defineProperty(this, 'view', { value: view ?? null, configurable: true });
    }
}

class HarnessDragEvent extends HarnessMouseEvent {
    public constructor(type: string, init: MouseEventInit & { dataTransfer?: unknown } = {}) {
        const { dataTransfer, ...rest } = init;
        super(type, rest);
        Object.defineProperty(this, 'dataTransfer', { value: dataTransfer ?? null, configurable: true });
    }
}

/**
 * The guard only replaces dialog entry points the page actually has — installing `window.alert`
 * where none existed would hand the page an API it never had. A real browser always has all three;
 * a bare jsdom under vitest may not, so the harness supplies them and the test then proves the
 * guard replaced them.
 */
function ensurePageDialogFunctions(): void {
    for (const kind of ['alert', 'confirm', 'prompt'] as const) {
        if (typeof window[kind] !== 'function') {
            Object.defineProperty(window, kind, {
                value: () => undefined,
                writable: true,
                configurable: true,
            });
        }
    }
}

/**
 * A constructor an engine refuses. Modelled on the real failure this harness hit: jsdom's
 * `MouseEvent` brand-check rejecting the window vitest hands the test realm. The runtime's
 * best-effort try/catch swallowed it, so a verb whose entire effect is the synthetic event
 * reported `ok: true, matched: true` while nothing was dispatched.
 */
function refusingEventConstructor(): never {
    throw new TypeError('Failed to construct event: refused by the engine');
}

type HarnessOverrides = Readonly<{
    mouseEvent?: unknown;
    dragEvent?: unknown;
}>;

function createHarness(overrides: HarnessOverrides = {}): AutomationHarness {
    ensurePageDialogFunctions();
    const source = `
        var envelopes = [];
        var config = ${JSON.stringify(CONFIG)};
        var runtime = { runtimeId: 'runtime_1' };
        var pickerNodeRefs = new WeakMap();
        var pickerSeq = 0;
        var highlightedPickerNode = null;
        var highlightedPickerOutline = '';
        var activePicker = null;
        var evalSuppressed = false;
        function postEnvelope(value) { envelopes.push(value); }
        function postEvents() {}
        function baseEvent(family, kind, data) { return { family: family, kind: kind, data: data, redaction: {} }; }
        function sanitizeUrl(value) { return value; }
        function now() { return Date.now(); }
        function isCurrentElementPickerCommand() { return false; }
        ${INJECTED_ELEMENTS_RUNTIME}
        return {
            handleAutomationCommand: handleAutomationCommand,
            selectedElementPayload: selectedElementPayload,
            envelopes: envelopes
        };
    `;

    type RuntimeInstance = Readonly<{
        handleAutomationCommand: (message: unknown) => void;
        selectedElementPayload: (node: Element) => Record<string, unknown>;
        envelopes: readonly AutomationEnvelope[];
    }>;
    type RuntimeFactory = (
        pageWindow: Window,
        pageDocument: Document,
        dataTransfer: unknown,
        dragEvent: unknown,
        mouseEvent: unknown,
    ) => RuntimeInstance;

    // eslint-disable-next-line no-new-func -- evaluating the shipped injected runtime string is the point.
    const factory = new Function(
        'window',
        'document',
        'DataTransfer',
        'DragEvent',
        'MouseEvent',
        source,
    ) as unknown as RuntimeFactory;

    const instance = factory(
        window,
        document,
        FakeDataTransfer,
        overrides.dragEvent ?? HarnessDragEvent,
        overrides.mouseEvent ?? HarnessMouseEvent,
    );

    let sequence = 0;
    return {
        run(commandName, payload = {}) {
            sequence += 1;
            const commandId = `command_${sequence}`;
            instance.handleAutomationCommand({
                v: 1,
                kind: 'browser.injectedRuntime.command',
                runtimeId: 'runtime_1',
                collectorId: CONFIG.collector.collectorId,
                nonce: CONFIG.collector.nonce,
                browserSessionId: CONFIG.browserSessionId,
                viewId: CONFIG.viewId,
                navigationGeneration: CONFIG.navigationGeneration,
                commandId,
                capabilityVersion: '1.0.0',
                module: 'automation',
                commandName,
                payload,
            });
            const envelope = instance.envelopes.find((entry) => entry.commandId === commandId);
            if (!envelope) throw new Error(`no automation result posted for ${commandName}`);
            return envelope;
        },
        selectedElementPayload: instance.selectedElementPayload,
    };
}

describe('injected automation command router', () => {
    it('performs a hover, a focus and a key press rather than reporting unsupported_action', () => {
        document.body.innerHTML = '<button id="go">Go</button><input id="field" />';
        const harness = createHarness();
        const button = document.querySelector('#go') as HTMLButtonElement;
        const field = document.querySelector('#field') as HTMLInputElement;

        const hovered: string[] = [];
        button.addEventListener('mouseover', () => hovered.push('mouseover'));
        const keys: string[] = [];
        field.addEventListener('keydown', (event) => keys.push((event as KeyboardEvent).key));

        // Each of these was advertised `available: true` while falling through to the router's
        // default branch, so an agent got `unsupported_action` for a verb the host promised.
        expect(harness.run('hover', { locator: { kind: 'css', value: '#go' } }))
            .toMatchObject({ ok: true });
        expect(hovered).toEqual(['mouseover']);

        expect(harness.run('focus', { locator: { kind: 'css', value: '#field' } }))
            .toMatchObject({ ok: true });
        expect(document.activeElement).toBe(field);

        expect(harness.run('press', { locator: { kind: 'css', value: '#field' }, key: 'Enter' }))
            .toMatchObject({ ok: true });
        expect(keys).toEqual(['Enter']);
    });

    it('reports selector_not_found rather than a false success when the locator misses', () => {
        document.body.innerHTML = '<div id="present"></div>';
        const harness = createHarness();

        expect(harness.run('hover', { locator: { kind: 'css', value: '#absent' } }))
            .toMatchObject({ ok: false, errorCode: 'selector_not_found' });
        expect(harness.run('upload', { locator: { kind: 'css', value: '#absent' } }))
            .toMatchObject({ ok: false, errorCode: 'selector_not_found' });
    });

    it('attaches payload-supplied files to a file input (UB-2 upload)', () => {
        document.body.innerHTML = '<input type="file" id="attach" />';
        const harness = createHarness();
        const input = document.querySelector('#attach') as HTMLInputElement;
        // A real browser lets `input.files` be assigned from a DataTransfer; jsdom exposes it
        // getter-only, so make it settable to model the engine the runtime actually targets.
        let assignedFiles: readonly File[] = [];
        Object.defineProperty(input, 'files', {
            get: () => assignedFiles,
            set: (value: readonly File[]) => { assignedFiles = value; },
            configurable: true,
        });
        let changed = 0;
        input.addEventListener('change', () => { changed += 1; });

        const result = harness.run('upload', {
            locator: { kind: 'css', value: '#attach' },
            files: [{ name: 'report.csv', mimeType: 'text/csv', text: 'a,b\n1,2\n' }],
        });

        expect(result).toMatchObject({ ok: true, data: { matched: true, fileCount: 1 } });
        expect(input.files?.[0]?.name).toBe('report.csv');
        expect(changed).toBe(1);
    });

    it('refuses to upload to a non-file input instead of silently doing nothing', () => {
        document.body.innerHTML = '<input type="text" id="text" />';
        const harness = createHarness();

        expect(harness.run('upload', {
            locator: { kind: 'css', value: '#text' },
            files: [{ name: 'a.txt', text: 'x' }],
        })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });

    it('drives the HTML5 drag sequence from a source onto a drop target (UB-2 drag)', () => {
        document.body.innerHTML = '<div id="card">Card</div><div id="column">Column</div>';
        const harness = createHarness();
        const observed: string[] = [];
        for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
            document.addEventListener(type, (event) => observed.push(`${type}:${(event.target as Element).id}`));
        }

        const result = harness.run('drag', {
            from: { kind: 'css', value: '#card' },
            to: { kind: 'css', value: '#column' },
        });

        expect(result).toMatchObject({ ok: true, data: { matched: true } });
        expect(observed).toEqual([
            'dragstart:card',
            'dragenter:column',
            'dragover:column',
            'drop:column',
            'dragend:card',
        ]);
    });

    it('auto-dismisses a JavaScript dialog and reports it on the action result (UB-5)', () => {
        document.body.innerHTML = '<button id="ask">Ask</button>';
        const harness = createHarness();
        const button = document.querySelector('#ask') as HTMLButtonElement;
        let confirmAnswer: boolean | null = null;
        let sawStub = false;
        const pageConfirm = window.confirm;
        button.addEventListener('click', () => {
            sawStub = window.confirm !== pageConfirm;
            confirmAnswer = window.confirm('Delete everything?');
        });

        const result = harness.run('click', { locator: { kind: 'css', value: '#ask' } });

        // Before this the modal blocked the page thread and the action timed out with no reason.
        expect(result).toMatchObject({
            ok: true,
            data: { javascriptDialogs: { count: 1, kinds: ['confirm'], handling: 'dismissed' } },
        });
        expect(sawStub).toBe(true);
        expect(confirmAnswer).toBe(false);
    });

    it('restores the page dialog functions once the command returns', () => {
        document.body.innerHTML = '<button id="quiet">Quiet</button>';
        const original = window.confirm;
        const harness = createHarness();

        harness.run('click', { locator: { kind: 'css', value: '#quiet' } });

        // The guard is scoped to one command: a page-driven dialog outside an automation action
        // must behave normally rather than being silently swallowed forever.
        expect(window.confirm).toBe(original);
    });

    it('omits the dialog summary when the action raised none', () => {
        document.body.innerHTML = '<button id="plain">Plain</button>';
        const harness = createHarness();

        const result = harness.run('click', { locator: { kind: 'css', value: '#plain' } });

        expect(result.ok).toBe(true);
        expect(result.data.javascriptDialogs).toBeUndefined();
    });

    it('reports runtime_unavailable rather than a phantom success when the engine refuses the synthetic event', () => {
        document.body.innerHTML = '<button id="go">Go</button><div id="card"></div><div id="column"></div>';
        const harness = createHarness({
            mouseEvent: refusingEventConstructor,
            dragEvent: refusingEventConstructor,
        });
        const observed: string[] = [];
        for (const type of ['click', 'mouseover', 'drop']) {
            document.addEventListener(type, () => observed.push(type));
        }

        // `ok: true, matched: true` here is the defect: the agent is told a click landed when no
        // event was ever dispatched. Every verb whose whole effect IS the synthetic event has to
        // fail closed instead.
        expect(harness.run('click', { locator: { kind: 'css', value: '#go' } }))
            .toMatchObject({ ok: false, errorCode: 'runtime_unavailable' });
        expect(harness.run('hover', { locator: { kind: 'css', value: '#go' } }))
            .toMatchObject({ ok: false, errorCode: 'runtime_unavailable' });
        expect(harness.run('drag', {
            from: { kind: 'css', value: '#card' },
            to: { kind: 'css', value: '#column' },
        })).toMatchObject({ ok: false, errorCode: 'runtime_unavailable' });

        // Nothing reached the page, which is exactly why none of the three may report success.
        expect(observed).toEqual([]);
    });

    it('reports runtime_unavailable when a typed value cannot notify the page', () => {
        document.body.innerHTML = '<input id="field" />';
        const harness = createHarness();
        const field = document.querySelector('#field') as HTMLInputElement;
        // A page whose input node refuses dispatch: the value assignment still lands, but a
        // framework-controlled field never learns about it, so "typed successfully" is a lie.
        Object.defineProperty(field, 'dispatchEvent', {
            value: () => { throw new TypeError('dispatch refused'); },
            configurable: true,
        });

        expect(harness.run('type', { locator: { kind: 'css', value: '#field' }, text: 'hello' }))
            .toMatchObject({ ok: false, errorCode: 'runtime_unavailable' });
    });

    it('still reports unsupported_action for a verb the runtime genuinely does not implement', () => {
        document.body.innerHTML = '<div id="x"></div>';
        const harness = createHarness();

        expect(harness.run('teleport', {})).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        // Policy-blocked verbs stay distinguishable from never-implemented ones.
        expect(harness.run('evaluate', {})).toMatchObject({ ok: false, errorCode: 'blocked_by_policy' });
    });

    it('carries the component name and source location a picked element resolves to (UB-7)', () => {
        document.body.innerHTML = '<div id="target">Target</div>';
        const harness = createHarness();
        const node = document.querySelector('#target') as HTMLElement;
        // Shape the host framework exposes on the DOM node in a dev build.
        (node as unknown as Record<string, unknown>).__reactFiber$abc = {
            type: { displayName: 'ServiceRow' },
            _debugSource: { fileName: '/src/components/ServiceRow.tsx', lineNumber: 42, columnNumber: 7 },
            return: null,
        };

        expect(harness.selectedElementPayload(node)).toMatchObject({
            componentName: 'ServiceRow',
            sourceLocation: { file: '/src/components/ServiceRow.tsx', line: 42, column: 7 },
        });
    });

    it('omits component context entirely when the page exposes none', () => {
        document.body.innerHTML = '<div id="plain">Plain</div>';
        const harness = createHarness();
        const payload = harness.selectedElementPayload(document.querySelector('#plain') as HTMLElement);

        expect(payload.componentName).toBeUndefined();
        expect(payload.sourceLocation).toBeUndefined();
        expect(payload.selectorPath).toBeTypeOf('string');
    });
});
