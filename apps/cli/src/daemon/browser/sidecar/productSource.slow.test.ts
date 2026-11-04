import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_AUTOMATION_MAX_ACTION_TIMEOUT_MS, FeaturesResponseSchema, type BrowserAutomationActionRequestV1 } from '@happier-dev/protocol';

// Environment and Home response are the substituted boundaries. Chromium, CDP,
// feature decisions, routing, and purge stay real.
const environment = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/configuration', () => ({ configuration: {
    get happyHomeDir() { return environment.directory; },
    get logsDir() { return join(environment.directory, 'logs'); },
} }));

import { createProductBrowserSidecarControlAdapterFactory } from './productSource';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { createBrowserAutomationRoutes } from '../automation/routes';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { getBrowserChromiumArchiveDownloadInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/browserChromium';
import { createBrowserDaemonFeatureGate } from '../featureGate';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { resolveManagedBrowserSidecarCandidate } from './source';
import { createBrowserContextRoutes } from '../context/routes';
import { createSidecarCdpBrowserContextSource } from '../context/cdp/productSource';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createMachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';

describe('managed browser live Session execution', () => {
    it('installs the real pinned browser archive and resolves its executable', async () => {
        environment.directory = await mkdtemp(join(tmpdir(), 'happier-browser-install-'));
        try {
            const installed = await getBrowserChromiumArchiveDownloadInstallableAdapter().installOrUpgrade();
            expect(installed.ok, JSON.stringify(installed)).toBe(true);
            expect(await resolveManagedBrowserSidecarCandidate()).toMatchObject({
                available: true, provenance: { origin: 'managed_package' },
            });
        } finally {
            await rm(environment.directory, { recursive: true, force: true });
        }
    });

    it('drives a headless browser through Actions, isolates cookies, and purges after process settlement', async () => {
        const profileRoot = await mkdtemp(join(tmpdir(), 'happier-browser-live-'));
        // Exact-target QA may reuse a canonically installed managed source/profile attachment.
        // Profile/media fixtures are still isolated and purged through their real owners.
        environment.directory = process.env.HAPPIER_HOME_DIR ?? profileRoot;
        const server = createServer((_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><title>Live browser</title><input id="name"><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result"></p>');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
        const url = `http://127.0.0.1:${address.port}/`;
        const profiles = createBrowserProfileStore({ storageRootDirectory: profileRoot,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: profileRoot }) });
        let runtime: Awaited<ReturnType<ReturnType<typeof createProductBrowserSidecarControlAdapterFactory>>> | undefined;
        const browserStderr: string[] = [];
        let metadata: Record<string, unknown> = { resourcesPolicyV1: { v: 1, processes: { browserMaxConcurrent: 1 } } };
        let metadataVersion = 1;
        const resourcesPolicy = createMachineResourcesPolicyRuntime({ port: {
            read: async () => ({ status: 'ready', metadata, metadataVersion }),
            compareAndSwap: async input => {
                metadata = input.metadata;
                return { status: 'applied', metadata, metadataVersion: ++metadataVersion };
            },
        } });
        try {
            await resourcesPolicy.reload();
            const featureGate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' },
                resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                    features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
                        sidecar: { enabled: true }, diagnostics: { enabled: true }, context: { enabled: true },
                        automation: { enabled: true }, recording: { enabled: true, attachments: { enabled: true } } },
                        attachments: { uploads: { enabled: true } } },
                }) }),
            });
            await featureGate.refresh();
            // First explicit browser use exercises the real digest-verified installer if missing.
            runtime = await createProductBrowserSidecarControlAdapterFactory({ featureEnabled: featureGate.isEnabled('browser.sidecar'),
                profileStore: profiles,
                readMachineResourcesPolicy: resourcesPolicy.read,
                installManagedBrowserChromium: async params => {
                    const installed = await getBrowserChromiumArchiveDownloadInstallableAdapter().installOrUpgrade(params);
                    expect(installed.ok, JSON.stringify(installed)).toBe(true);
                    return installed;
                },
                createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({
                    ...input,
                    spawnProcess: (executable, args) => {
                        const child = spawn(executable, [...args], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
                        child.stderr?.on('data', chunk => browserStderr.push(String(chunk)));
                        child.once('error', error => browserStderr.push(`${error.name}: ${error.message}\n`));
                        child.once('exit', (code, signal) => browserStderr.push(`Browser exit: ${code ?? signal}\n`));
                        return child;
                    },
                }),
            })({ machineId: 'live_machine' });
            expect(runtime.ok, JSON.stringify(runtime)).toBe(true);
            if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed browser runtime unavailable');
            const capture = runtime.contextCapture;
            const broker = createBrowserDaemonControlBroker();
            broker.registerAdapter(runtime.adapter);
            const contextRoutes = createBrowserContextRoutes({ ownerAccountId: 'live_machine',
                source: createSidecarCdpBrowserContextSource({ contextCapture: capture, workingDirectory: profileRoot,
                    screenshotMediaStorage: 'daemon', pathAllowanceRegistry: createTransferPathAllowanceRegistry() }),
                resolveGate: view => {
                    const profile = capture.resolveProfile?.(view);
                    return { featureEnabled: featureGate.isEnabled('browser.context'),
                        policyAllowed: profile?.owner.kind === 'session' && profile.owner.id === view.browserSessionId
                            && profile.lifecycleState === 'active',
                        runtimeAvailable: Boolean(capture.resolvePageHandle(view)) };
                },
            });
            const execute = createBrowserDaemonRuntimeActionExecutor({
                context: contextRoutes,
                control: createBrowserDaemonControlRoutes({ broker }),
                automation: createBrowserAutomationRoutes({ service: createBrowserAutomationDaemonService({
                    adapter: createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({
                        adapter: runtime.adapter, contextCapture: capture, browserContext: contextRoutes,
                    }) }),
                }) }),
                featureGate,
            });
            for (const browserSessionId of ['live_session_a', 'live_session_b']) {
                const openArgs = { actionId: 'browser.view.open', context: {}, input: {
                    kind: 'openView', commandId: `open_${browserSessionId}`, browserSessionId, viewId: 'view',
                    platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url },
                } } satisfies Parameters<typeof execute>[0];
                if (browserSessionId === 'live_session_b') {
                    expect(await execute(openArgs)).toMatchObject({ status: 'failed', completion: 'known', error: { code: 'waiting_for_memory', retryable: true } });
                    expect(profiles.listProfiles()).toHaveLength(1);
                    expect(await resourcesPolicy.set({ expectedRevision: metadataVersion, patch: { processes: { browserMaxConcurrent: 2 } } }))
                        .toMatchObject({ status: 'applied' });
                }
                const opened = await execute(openArgs);
                expect(opened, `${JSON.stringify(opened)}\n${browserStderr.join('')}`).toMatchObject({ status: 'dispatched' });
            }
            const view = { browserSessionId: 'live_session_a', viewId: 'view' };
            let request = 0;
            async function action(actionKind: 'waitFor' | 'type' | 'click' | 'snapshot', payload: Record<string, unknown>) {
                return execute({ actionId: `browser.automation.${actionKind}`, context: {}, input: {
                    v: 1, ...view, automationRequestId: `live_${++request}`, actionKind,
                    navigationGeneration: capture.getNavigationState?.(view)?.navigationGeneration ?? 0,
                    requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'fixture_agent' }, payload,
                    timeoutMs: BROWSER_AUTOMATION_MAX_ACTION_TIMEOUT_MS,
                } satisfies BrowserAutomationActionRequestV1 });
            }
            expect(await action('waitFor', { selector: '#name' })).toMatchObject({ status: 'succeeded' });
            expect(await action('type', { selector: '#name', text: 'Source-driven browser' })).toMatchObject({ status: 'succeeded' });
            expect(await action('click', { selector: '#submit' })).toMatchObject({ status: 'succeeded' });
            expect(await action('snapshot', {})).toMatchObject({ status: 'succeeded', resultSummary: {
                visibleText: expect.stringContaining('Source-driven browser'),
            } });
            async function evaluate(browserSessionId: string, expression: string) {
                const handle = capture.resolvePageHandle({ browserSessionId, viewId: 'view' });
                if (!handle) throw new Error('Live browser view not bound');
                return capture.transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate',
                    params: { expression, returnByValue: true } });
            }
            await evaluate('live_session_a', 'document.cookie="isolation=session_a; path=/"');
            expect(await evaluate('live_session_a', 'document.cookie')).toMatchObject({ result: { value: 'isolation=session_a' } });
            expect(await evaluate('live_session_b', 'document.cookie')).toMatchObject({ result: { value: '' } });
            async function screenshot(invokingSessionId: string) {
                return execute({ actionId: 'browser.context.captureScreenshot', context: { defaultSessionId: invokingSessionId },
                    input: { ...view, navigationGeneration: capture.getNavigationState?.(view)?.navigationGeneration ?? 0,
                        contextId: `screenshot_${++request}` } });
            }
            expect(await screenshot('live_session_a')).toMatchObject({ kind: 'browserScreenshot', lifecycleState: 'available', media: { mediaKind: 'image' } });
            expect(await screenshot('live_session_b')).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            await evaluate('live_session_a', 'document.body.insertAdjacentHTML("beforeend", \'<input type="password" value="private">\')');
            expect(await screenshot('live_session_a')).toMatchObject({ lifecycleState: 'sensitiveFieldsPresent', redactionLevel: 'blocked' });
            const profile = profiles.listProfiles().find(candidate => candidate.owner.id === 'live_session_a');
            if (!profile) throw new Error('Live Session profile not registered');
            const profileDirectory = profiles.resolveProfileDirectory(profile.profileId);
            expect((await readdir(profileDirectory)).length).toBeGreaterThan(0);
            expect(await profiles.purgeForSessionDeleted({ sessionId: 'live_session_a' })).toEqual({
                purgedProfileIds: [profile.profileId], failedProfileIds: [],
            });
            await expect(readdir(profileDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(capture.resolvePageHandle(view)).toBeNull();
            expect(await evaluate('live_session_b', 'document.title')).toMatchObject({ result: { value: 'Live browser' } });
            expect(await resourcesPolicy.set({ expectedRevision: metadataVersion, patch: { processes: { browserMaxConcurrent: 1 } } }))
                .toMatchObject({ status: 'applied' });
            const retryArgs = { actionId: 'browser.view.open', context: {}, input: {
                kind: 'openView', commandId: 'open_live_session_c', browserSessionId: 'live_session_c', viewId: 'view',
                platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url },
            } } satisfies Parameters<typeof execute>[0];
            expect(await execute(retryArgs)).toMatchObject({ error: { code: 'waiting_for_memory' } });
            expect(await execute({ actionId: 'browser.view.close', context: {}, input: {
                kind: 'closeView', commandId: 'close_live_session_b', browserSessionId: 'live_session_b', viewId: 'view',
            } })).toMatchObject({ status: 'dispatched' });
            expect(await execute(retryArgs)).toMatchObject({ status: 'dispatched' });
            await runtime.dispose?.();
            runtime = undefined;
            expect(profiles.listProfiles()).toEqual([]);
        } finally {
            resourcesPolicy.stop();
            try { if (runtime?.ok) await runtime.dispose?.(); }
            finally {
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                await rm(profileRoot, { recursive: true, force: true });
            }
        }
    });
});
