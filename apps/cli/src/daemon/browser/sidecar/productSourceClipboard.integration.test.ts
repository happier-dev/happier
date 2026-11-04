import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type BrowserAutomationActionRequestV1 } from '@happier-dev/protocol';

// Only the runtime installation home is supplied by QA; Chromium/CDP and all
// product owners stay real, with isolated Session profiles and no acquisition.
const environment = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/configuration', () => ({ configuration: {
    get happyHomeDir() { return environment.directory; },
    get logsDir() { return join(environment.directory, 'logs'); },
} }));

import { createProductBrowserSidecarControlAdapterFactory } from './productSource';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { resolveManagedBrowserSidecarCandidate } from './source';

describe('managed browser live clipboard', () => {
    it.skipIf(!process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME)('routes clipboard Actions and interaction state through the installed managed browser', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-browser-clipboard-'));
        environment.directory = process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME ?? root;
        const server = createServer((_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><input id="text"><input id="secret" type="password" value="masked-canary">'
                + '<button id="question" onclick="window.answer=prompt(\'Human question\',\'guest\')">Question</button>');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Clipboard fixture did not bind');
        const profiles = createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        let runtime: Awaited<ReturnType<ReturnType<typeof createProductBrowserSidecarControlAdapterFactory>>> | undefined;
        let service: ReturnType<typeof createBrowserAutomationDaemonService> | undefined;
        try {
            // Live QA reuses an installed canonical runtime; this case never downloads or installs.
            const candidate = await resolveManagedBrowserSidecarCandidate();
            expect(candidate?.available, 'A preinstalled pinned managed browser is required').toBe(true);
            runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles })(
                { machineId: 'clipboard_machine' });
            if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed browser runtime unavailable');
            const capture = runtime.contextCapture;
            const view = { browserSessionId: 'clipboard-session', viewId: 'clipboard-view' };
            expect(await runtime.adapter.dispatchCommand({ kind: 'openView', commandId: 'clipboard-open', focus: true, ...view,
                platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: `http://127.0.0.1:${address.port}/` },
            })).toMatchObject({ status: 'dispatched' });
            const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
                transport: createControlAdapterAutomationTransport({ adapter: runtime.adapter, contextCapture: capture }),
            }) });
            service = automation;
            let requestId = 0;
            const action = (actionKind: BrowserAutomationActionRequestV1['actionKind'], payload = {}) => automation.execute({
                v: 1, ...view, automationRequestId: `clipboard:${++requestId}`, actionKind, payload,
                navigationGeneration: capture.getNavigationState?.(view)?.navigationGeneration ?? 0,
                requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'clipboard-fixture' },
                timeoutMs: 60_000,
            });
            expect(await action('waitFor', { selector: '#text' })).toMatchObject({ status: 'succeeded' });
            expect(await action('click', { selector: '#text' })).toMatchObject({ status: 'succeeded' });
            expect(await action('clipboardWrite', { text: 'clipboard-canary' })).toMatchObject({ status: 'succeeded' });
            const handle = capture.resolvePageHandle(view);
            if (!handle) throw new Error('Clipboard view is not bound');
            const evaluate = (expression: string) => capture.transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate',
                params: { expression, returnByValue: true } });
            expect(await evaluate('document.querySelector("#text").value')).toMatchObject({ result: { value: 'clipboard-canary' } });
            expect(await action('press', { key: 'a', modifiers: ['control'] })).toMatchObject({ status: 'succeeded' });
            expect(await action('clipboardRead')).toMatchObject({ status: 'succeeded',
                interactionResult: { kind: 'clipboard', text: 'clipboard-canary' }, resultSummary: {} });
            expect(await action('clipboardCut')).toMatchObject({ status: 'succeeded',
                interactionResult: { kind: 'clipboard', text: 'clipboard-canary' }, resultSummary: {} });
            expect(await evaluate('document.querySelector("#text").value')).toMatchObject({ result: { value: '' } });
            await evaluate('document.execCommand("undo")');
            expect(await evaluate('document.querySelector("#text").value')).toMatchObject({ result: { value: 'clipboard-canary' } });
            await evaluate('document.querySelector("#secret").select()');
            expect(await action('clipboardRead')).toMatchObject({ status: 'succeeded',
                interactionResult: { kind: 'clipboard', text: '' } });
            expect(await action('clipboardCut')).toMatchObject({ status: 'succeeded',
                interactionResult: { kind: 'clipboard', text: '' } });
            expect(await evaluate('document.querySelector("#secret").value')).toMatchObject({ result: { value: 'masked-canary' } });
            expect(await action('getInteractionState')).toMatchObject({ status: 'succeeded',
                resultSummary: { dialog: null, fileChooser: null, downloads: [] } });
            const timeline = JSON.stringify(service.getTimeline(view));
            expect(timeline).not.toContain('clipboard-canary');
            expect(timeline).not.toContain('masked-canary');
            const humanAction = (actionKind: BrowserAutomationActionRequestV1['actionKind'], payload = {}) => automation.execute({
                v: 1, ...view, automationRequestId: `human:${++requestId}`, actionKind, payload,
                navigationGeneration: capture.getNavigationState?.(view)?.navigationGeneration ?? 0,
                requestedBy: 'user', requesterRef: { kind: 'streamViewer', id: 'human-fixture' },
                timeoutMs: 60_000,
            });
            const click = humanAction('click', { selector: '#question' });
            let clickResult: Awaited<typeof click> | undefined;
            void click.then(result => { clickResult = result; });
            await vi.waitFor(() => expect(capture.interactions?.getState(view)?.dialog).toMatchObject({ type: 'prompt', message: 'Human question' }));
            // The exact pending-dialog reply continues this admitted click; it must not queue
            // behind the CDP dispatch that Chromium will acknowledge only after the reply.
            expect(clickResult).toBeUndefined();
            const dialog = capture.interactions?.getState(view)?.dialog;
            if (!dialog) throw new Error('Human dialog missing');
            const answer = await humanAction('answerDialog', { dialogId: dialog.dialogId, accept: true, promptText: 'human answer' });
            expect(answer, JSON.stringify(answer)).toMatchObject({ status: 'succeeded' });
            expect(await click).toMatchObject({ status: 'succeeded' });
            expect(await evaluate('window.answer')).toMatchObject({ result: { value: 'human answer' } });
            for (const privateText of ['Human question', 'human answer']) expect(JSON.stringify(service.getTimeline(view))).not.toContain(privateText);
        } finally {
            service?.dispose();
            try { if (runtime?.ok) await runtime.dispose?.(); }
            finally {
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                await rm(root, { recursive: true, force: true });
            }
        }
    });

});
