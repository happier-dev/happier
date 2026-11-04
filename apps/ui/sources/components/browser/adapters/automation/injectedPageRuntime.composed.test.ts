// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import { createBrowserRuntimeActionExecutor } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { buildInjectedBrowserDiagnosticsScript, buildInjectedBrowserDiagnosticsEvalCommandScript,
    buildInjectedBrowserDiagnosticsGetPropertiesCommandScript, parseInjectedBrowserDiagnosticsMessage } from '../diagnostics/injectedPage';
import { createInjectedPageAutomationOwner } from './injectedPageRuntime';

const identity = { browserSessionId: 'browser', viewId: 'view', navigationGeneration: 0,
    collectorId: 'collector', nonce: 'nonce', capabilityVersion: '1.0.0' } as const;
type RuntimeWindow = Window & {
    ReactNativeWebView: { postMessage(raw: string): void };
    __happierBrowserRuntime?: { teardown(): void };
};
const runtimeWindow = window as unknown as RuntimeWindow;

function mountCollector() {
    const listeners = new Set<(raw: string) => void>();
    const messages: string[] = [];
    runtimeWindow.ReactNativeWebView = { postMessage: raw => { messages.push(raw); for (const listener of listeners) listener(raw); } };
    // The installed source runs against the DOM/platform boundary; no internal collector logic is mocked.
    new Function(buildInjectedBrowserDiagnosticsScript({ ...identity, version: identity.capabilityVersion }))();
    const service = createBrowserAutomationControlService({ nowMs: Date.now });
    const owner = createInjectedPageAutomationOwner({ ...identity, ownerId: 'mounted', adapterKind: 'localPreview',
        supportedActions: ['queryElements', 'setValue', 'type', 'waitFor', 'upload'], nowMs: Date.now,
        transport: { sendCommand: (_command, script) => { new Function(script)(); },
            subscribeToResults: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } } });
    service.registerOwner(owner);
    const execute = createBrowserRuntimeActionExecutor({ automation: { controlService: service } });
    let seq = 0;
    return {
        service,
        messages,
        run(actionKind: 'queryElements' | 'setValue' | 'type' | 'waitFor' | 'upload', payload: Record<string, unknown>, timeoutMs = 10_000) {
            seq += 1;
            return execute({ actionId: `browser.automation.${actionKind}`, input: { v: 1,
                browserSessionId: identity.browserSessionId, viewId: identity.viewId, navigationGeneration: identity.navigationGeneration,
                automationRequestId: `request_${seq}`, requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session' },
                actionKind, timeoutMs, payload }, context: { surface: 'agent', authority: 'account_automation' } });
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no canvas/WebGL capability; the collector's platform probe should report that.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    document.body.innerHTML = '<input id="field" class="field" aria-label="Title" value="before">';
});
afterEach(() => { runtimeWindow.__happierBrowserRuntime?.teardown(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mounted browser Action to installed collector', () => {
    it('keeps eval pending beyond former deadlines until a nonce-bound cancel and ignores late completion', async () => {
        const host = mountCollector();
        let complete!: (value: unknown) => void;
        vi.stubGlobal('__longEval', new Promise(resolve => { complete = resolve; }));
        const request = { v: 1 as const, evalRequestId: 'long_eval', viewId: identity.viewId, navigationGeneration: 0,
            tier: 'injectedPage' as const, expression: '__longEval' + ' '.repeat(5_000),
            objectGroupId: 'group', diagnosticsInteractionEnabled: true as const };
        const send = (command: typeof request & { action?: 'cancel' }) => new Function(
            buildInjectedBrowserDiagnosticsEvalCommandScript({ ...identity, version: '1.0.0', request: command }))();
        send(request);
        await vi.advanceTimersByTimeAsync(60_001);
        const results = () => host.messages.map(raw => parseInjectedBrowserDiagnosticsMessage(raw, identity))
            .filter(message => message.ok && 'evalResult' in message && message.evalResult?.evalRequestId === request.evalRequestId);
        expect(results()).toHaveLength(0);
        send({ ...request, action: 'cancel' });
        expect(results()).toMatchObject([{ evalResult: { status: 'cancelled' } }]);
        complete({ late: true });
        await Promise.resolve();
        expect(results()).toHaveLength(1);
    });

    it('returns full eval values and expands every retained property through the diagnostics reader', () => {
        const host = mountCollector();
        const longValue = 'x'.repeat(70_000);
        vi.stubGlobal('__fx80Value', longValue);
        const request = { v: 1 as const, evalRequestId: 'eval', viewId: identity.viewId, navigationGeneration: 0,
            tier: 'injectedPage' as const, expression: '__fx80Value',
            objectGroupId: 'group', diagnosticsInteractionEnabled: true as const };
        new Function(buildInjectedBrowserDiagnosticsEvalCommandScript({ ...identity, version: '1.0.0', request }))();
        const scalar = parseInjectedBrowserDiagnosticsMessage(host.messages.at(-1)!, identity);
        expect(scalar).toMatchObject({ ok: true });
        if (!scalar.ok || !('evalResult' in scalar)) throw new Error('Expected scalar result');
        expect(scalar.evalResult?.result?.value).toHaveLength(longValue.length);
        vi.stubGlobal('__fx80Value', Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`property_${i}`, longValue])));
        new Function(buildInjectedBrowserDiagnosticsEvalCommandScript({ ...identity, version: '1.0.0', request }))();
        const object = parseInjectedBrowserDiagnosticsMessage(host.messages.at(-1)!, identity);
        expect(object).toMatchObject({ ok: true, evalResult: { result: { previewTruncated: false } } });
        if (!object.ok || !('evalResult' in object) || !object.evalResult?.result?.objectId) throw new Error('Expected object reference');
        new Function(buildInjectedBrowserDiagnosticsGetPropertiesCommandScript({ ...identity, version: '1.0.0', request: {
            v: 1, propertyRequestId: 'properties', viewId: identity.viewId, navigationGeneration: 0, tier: 'injectedPage',
            objectId: object.evalResult.result.objectId, objectGroupId: 'group', diagnosticsInteractionEnabled: true,
        } }))();
        const expanded = parseInjectedBrowserDiagnosticsMessage(host.messages.at(-1)!, identity);
        if (!expanded.ok || !('propertiesResult' in expanded) || !expanded.propertiesResult) throw new Error('Expected expanded properties');
        expect(expanded.propertiesResult.properties).toHaveLength(101);
        expect(expanded.propertiesResult.properties[100]?.value.value).toHaveLength(longValue.length);
    });

    it.each([
        { selector: 'input[aria-label="Title"]' },
        { locator: '.field' },
        { selector: 'role=textbox[name="Title"]' },
        { locator: { kind: 'css', value: '#field' } },
        { locator: { selector: '#field' } },
        { locator: { kind: 'role', role: 'textbox', name: 'Title' } },
    ])('uses the canonical locator grammar for %j', async payload => {
        const host = mountCollector();
        expect(await host.run('queryElements', payload)).toMatchObject({ status: 'succeeded', resultSummary: { elementCount: 1 } });
    });

    it('never interprets a setValue value as its selector', async () => {
        const host = mountCollector();
        expect(await host.run('setValue', { selector: '#field', value: 'after' })).toMatchObject({ status: 'succeeded' });
        expect(document.querySelector<HTMLInputElement>('#field')!.value).toBe('after');
    });

    it('replaces setValue content even with append requested, while type still appends', async () => {
        const host = mountCollector();
        const locator = { kind: 'css', value: '#field' };
        expect(await host.run('setValue', { locator, value: 'after', append: true })).toMatchObject({ status: 'succeeded' });
        const field = document.querySelector<HTMLInputElement>('#field')!;
        expect(field.value).toBe('after');
        expect(await host.run('type', { locator, text: '!' })).toMatchObject({ status: 'succeeded' });
        expect(field.value).toBe('after!');
    });

    it('waits beyond two seconds within the containing Action budget', async () => {
        const host = mountCollector();
        const result = host.run('waitFor', { selector: '#later', timeoutMs: 1 });
        await vi.advanceTimersByTimeAsync(3_000);
        document.body.insertAdjacentHTML('beforeend', '<button id="later">Ready</button>');
        await vi.advanceTimersByTimeAsync(100);
        expect(await result).toMatchObject({ status: 'succeeded' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['cancel', 'expiry'] as const)('retires the collector wait on outer %s', async mode => {
        const host = mountCollector();
        const result = host.run('waitFor', { selector: '#never' }, 5_000);
        await vi.advanceTimersByTimeAsync(200);
        if (mode === 'cancel') host.service.cancelActiveAction(identity);
        else await vi.advanceTimersByTimeAsync(4_800);
        expect(await result).toMatchObject({ status: mode === 'cancel' ? 'canceled' : 'timed_out' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('attaches every file and refuses invalid descriptors without replacing the current selection', async () => {
        // jsdom has File but no DataTransfer. Model that platform boundary and its FileList assignment.
        class TestDataTransfer {
            files: File[] = [];
            items = { add: (file: File) => { this.files.push(file); } };
        }
        vi.stubGlobal('DataTransfer', TestDataTransfer);
        document.body.innerHTML = '<input id="files" type="file" multiple>';
        const field = document.querySelector<HTMLInputElement>('#files')!;
        Object.defineProperty(field, 'files', { writable: true, value: [] });
        const host = mountCollector();
        const files = Array.from({ length: 11 }, (_, index) => ({ name: `${index}.txt`, text: String(index) }));
        expect(await host.run('upload', { selector: '#files', files })).toMatchObject({ status: 'succeeded', resultSummary: { fileCount: 11 } });
        expect(Array.from(field.files ?? [], file => file.name)).toEqual(files.map(file => file.name));
        const previous = field.files;
        expect(await host.run('upload', { selector: '#files', files: [files[0], null] })).toMatchObject({ status: 'unsupported' });
        expect(field.files).toBe(previous);
    });

    it('reports a platform file-assignment refusal', async () => {
        vi.stubGlobal('DataTransfer', class { files: File[] = []; items = { add: (file: File) => this.files.push(file) }; });
        document.body.innerHTML = '<input id="files" type="file" multiple>';
        const host = mountCollector();
        // The native jsdom FileList setter refuses this unsupported platform assignment.
        expect(await host.run('upload', { selector: '#files', files: [{ name: 'a.txt', text: 'a' }] })).toMatchObject({ status: 'failed', errorCode: 'runtime_unavailable' });
    });
});
