import { describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { createLocalServiceActionConfirmationNonceV1, FeaturesResponseSchema, type LocalServiceActionRequestV1 } from '@happier-dev/protocol';
import { buildPluginHostedWebStaticAssetPreviewId } from '@happier-dev/protocol/plugins/ui';

import { createLocalServicesDaemonRuntime } from './runtime';
import {
    listLocalServicePreviewResources,
    registerLocalServicePreview,
    unregisterLocalServicePreview,
} from './preview/registry';
import type { NormalizedLocalServiceInventorySnapshot } from './inventory/scanner';
import { createLocalServiceEndpointEnricher } from './inventory/endpoint';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';

function previewServerBoundary() {
    const registrations = new Map<string, unknown>();
    return {
        registrations,
        input: {
            token: 'daemon-token', serverBaseUrl: 'https://home.example.test',
            http: {
                async post(_url: string, body: unknown) {
                    const resource = LocalServicePreviewResourceV1Schema.parse(body);
                    registrations.set(resource.previewId, resource);
                    return { data: { resource, accessUrl: `https://preview.example.test${resource.initialPath.pathname}${resource.initialPath.search}`, expiresAt: 65_000 } };
                },
                async delete(url: string) {
                    if (!registrations.delete(decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? ''))) {
                        throw new AxiosError('Preview not found', undefined, undefined, undefined, {
                            status: 404,
                            statusText: 'Not Found',
                            headers: {},
                            config: { headers: new AxiosHeaders() },
                            data: { error: 'preview_not_found', reasonCode: 'preview_not_found' },
                        });
                    }
                    return { data: { ok: true } };
                },
            },
        },
    };
}

function buildSnapshot(
    overrides: Partial<NormalizedLocalServiceInventorySnapshot> = {},
): NormalizedLocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId: 'machine-a',
        generatedAt: 1_000,
        refreshState: 'idle',
        diagnostics: [],
        entries: [{
            id: 'entry-1',
            machineId: 'machine-a',
            address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
            endpoint: {
                scheme: 'http',
                host: '127.0.0.1',
                port: 5173,
                probeState: 'ready',
                probedAt: 1_000,
            },
            port: 5173,
            protocol: 'tcp',
            detectedAt: 1_000,
            lastSeenAt: 1_000,
            state: 'listening',
            source: 'detected',
            labels: [],
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            workspaceAssociationConfidence: 'high',
            diagnostics: [],
            provenance: {
                process: {
                    pid: 400,
                    ppid: 300,
                    lineagePids: [400, 300, 1],
                    command: 'npm run dev',
                    cwd: '/repo/app',
                    redacted: true,
                },
            },
        }],
        ...overrides,
    };
}

describe('createLocalServicesDaemonRuntime', () => {
    it('never projects an unavailable scan or a disabled feature as a ready zero', async () => {
        const failed = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', startLoop: false, inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [{ code: 'windows_netstat_scan_failed', severity: 'error' as const }] }),
        });
        expect(failed.subscribeSummary).toBeTypeOf('function');
        const errors: unknown[] = [];
        const unsubscribeFailed = failed.subscribeSummary((summary) => errors.push(summary));
        await failed.refreshInventoryNow();
        expect(errors.at(-1)).toEqual({ v: 1, state: 'error' });
        unsubscribeFailed();
        await failed.stop();
        const disabled = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false, inventoryEnabled: () => false });
        const summaries: unknown[] = [];
        const unsubscribeDisabled = disabled.subscribeSummary((summary) => summaries.push(summary));
        await disabled.refreshInventoryNow();
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'disabled' });
        unsubscribeDisabled();
        await disabled.stop();
    });
    it('invalidates a ready summary when the scanner throws and recovers on the next scan', async () => {
        let failScan = false;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', startLoop: false, inventoryEnabled: () => true,
            scan: async () => {
                if (failScan) throw new Error('OS scan unavailable');
                return { listeners: [], processes: new Map(), workspaces: [], diagnostics: [] };
            },
        });
        const summaries: unknown[] = [];
        const unsubscribe = runtime.subscribeSummary((summary) => summaries.push(summary));
        await runtime.refreshInventoryNow();
        failScan = true;
        await expect(runtime.refreshInventoryNow()).rejects.toThrow('OS scan unavailable');
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'error' });
        failScan = false;
        await runtime.refreshInventoryNow();
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        unsubscribe();
        await runtime.stop();
    });
    it('pushes one stable machine summary from the inventory and distinguishes scan failure from zero', async () => {
        const scan = vi.fn(async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', inventoryEnabled: () => true, scan, startLoop: false });
        const summaries: unknown[] = [];
        expect(runtime.subscribeSummary).toBeTypeOf('function');
        const unsubscribe = runtime.subscribeSummary((summary) => summaries.push(summary));
        await runtime.refreshInventoryNow();
        expect(summaries).toEqual([{ v: 1, state: 'unknown' }, { v: 1, state: 'ready', runningCount: 0 }]);
        const snapshot = buildSnapshot();
        runtime.inventoryRegistry.replaceSnapshot({ ...snapshot, entries: [
            ...snapshot.entries,
            { ...snapshot.entries[0]!, id: 'wildcard', address: { kind: 'wildcard', host: '::', family: 'ipv6' } },
            { ...snapshot.entries[0]!, id: 'internal', port: 3000, classification: { kind: 'happier', signals: [] } },
        ] });
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 1 });
        const last = summaries.at(-1);
        runtime.inventoryRegistry.replaceSnapshot({ ...runtime.inventoryRegistry.getSnapshot(), generatedAt: 2_000 });
        expect(summaries.at(-1)).toBe(last);
        expect(summaries).toHaveLength(3);
        runtime.inventoryRegistry.replaceSnapshot({ ...runtime.inventoryRegistry.getSnapshot(), refreshState: 'error' });
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'error' });
        await runtime.refreshInventoryNow();
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        unsubscribe();
        await runtime.stop();
    });

    it('uses the existing scan loop for summary demand and stops scanning when its last reader leaves', async () => {
        vi.useFakeTimers();
        try {
            const scan = vi.fn(async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }));
            const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', inventoryEnabled: () => true, scan, refreshIntervalMs: 1_000 });
            await vi.advanceTimersByTimeAsync(3_000);
            expect(scan).not.toHaveBeenCalled();
            expect(runtime.subscribeSummary).toBeTypeOf('function');
            const unsubscribe = runtime.subscribeSummary(() => {});
            await vi.advanceTimersByTimeAsync(3_000);
            expect(scan.mock.calls.length).toBeGreaterThan(1);
            unsubscribe();
            const count = scan.mock.calls.length;
            await vi.advanceTimersByTimeAsync(3_000);
            expect(scan.mock.calls.length).toBe(count);
            await runtime.stop();
        } finally { vi.useRealTimers(); }
    });

    it('does not treat registered preview access as evidence of a running listener', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
        });
        const summaries: unknown[] = [];
        expect(runtime.subscribeSummary).toBeTypeOf('function');
        const unsubscribe = runtime.subscribeSummary((summary) => summaries.push(summary));
        await runtime.refreshInventoryNow();
        const registered = registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-a', sessionId: 'session-a', machineId: 'machine-a',
            owner: { kind: 'session', id: 'session-a' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'App', addressLabel: 'localhost:5173' }, originMode: 'host',
        });
        expect(registered.ok).toBe(true);
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());
        expect(summaries).toHaveLength(3);
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 1 });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot({ entries: [] }));
        expect(summaries).toHaveLength(4);
        unregisterLocalServicePreview(runtime.previewRegistry, 'preview-a');
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        unsubscribe();
        await runtime.stop();
    });

    it('keeps the last known services when the inventory gate never resolved, without claiming to have looked', async () => {
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // `localServices.inventory` is server-represented, so with no snapshot the decision is
            // fail-closed and undecided (probe_failed): the daemon did not scan and therefore knows
            // nothing new. It keeps what it last saw and reports the refresh as unsuccessful — it
            // does not age those rows as if a scan had looked for them and missed them.
            resolveServerFeaturesSnapshot: () => undefined,
            scan,
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
        expect(snapshot.refreshState).toBe('error');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_probe_failed', severity: 'info' },
        ]);
    });

    it('does not publish an empty inventory when the gate decision itself never resolved', async () => {
        // The fresh-daemon shape of the same false negative the scan boundary used to produce. The
        // server-features probe is a 1.5 s fetch on an event loop this daemon can stall for tens of
        // seconds; when it does not resolve, the daemon never scans and knows nothing about this
        // machine's services. Reporting that as a settled `idle` inventory with zero entries is what
        // renders a terminal "No local services detected" over running services.
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            resolveServerFeaturesSnapshot: () => ({ status: 'error', reason: 'timeout' }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toEqual([]);
        expect(snapshot.refreshState).toBe('error');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_probe_failed', severity: 'info' },
        ]);
    });

    it('preserves last-known listening entries when a listener scan failure is non-authoritative', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [{
                    code: 'darwin_lsof_scan_failed',
                    severity: 'warning' as const,
                    message: 'Darwin local-service listener scan failed.',
                }],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.refreshState).toBe('error');
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
        expect(snapshot.diagnostics).toEqual([{
            code: 'darwin_lsof_scan_failed',
            severity: 'warning',
            message: 'Darwin local-service listener scan failed.',
        }]);
    });

    it('keeps launcher targets openable after a non-authoritative inventory scan failure', async () => {
        const server = previewServerBoundary();
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            accountId: 'account-a', previewServer: server.input,
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [{
                    code: 'linux_procfs_scan_failed',
                    severity: 'warning' as const,
                    message: 'procfs unavailable',
                }],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());
        const opened = await runtime.previewRoutes.openOrCreate({
            machineId: 'machine-a', inventoryEntryId: 'entry-1',
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error(opened.reasonCode);

        await runtime.refreshInventoryNow();
        const launcherSnapshot = await runtime.launcherRoutes.getSnapshot();
        const target = launcherSnapshot.targets.find((candidate) => candidate.id === 'inventory:entry-1');

        expect(target).toMatchObject({
            state: 'available',
            browserTarget: { kind: 'localServicePreview' },
        });
        expect(target?.browserTarget).toEqual(opened.response.preview.resource.browserTarget);
        const reopened = await runtime.previewRoutes.openOrCreate({
            machineId: 'machine-a', inventoryEntryId: 'entry-1',
        });
        expect(reopened.ok).toBe(true);
        if (!reopened.ok) throw new Error(reopened.reasonCode);
        expect(reopened.response.status).toBe('existing');
        expect(reopened.response.preview.resource.previewId).toBe(opened.response.preview.resource.previewId);
        expect(reopened.response.preview.accessUrl).toBeTruthy();
        await runtime.stop();
    });

    it('runs the inventory scan when the server reports localServices inventory enabled', async () => {
        const scan = vi.fn(async () => ({
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const, pid: 400 }],
            processes: new Map([
                [400, { pid: 400, ppid: 1, command: 'node server.js', cwd: '/repo/app' }],
            ]),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // Server-represented gate (default-allow): the daemon scans when the server allows it.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: true, inventory: { enabled: true } } },
                    capabilities: {},
                }),
            }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).toHaveBeenCalledOnce();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
    });

    it('does not scan when the server explicitly disables localServices inventory', async () => {
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // A server that sets the bit false disables inventory scanning for its users.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: false, inventory: { enabled: false } } },
                    capabilities: {},
                }),
            }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('stale');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_feature_disabled', severity: 'info' },
        ]);
    });

    it('refreshes inventory through the scanner and normalizes listener process lineage', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'npm run dev', cwd: '/repo/app' }],
                ]),
                workspaces: [{ id: 'workspace-a', path: '/repo' }],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-unknown',
            port: 5173,
            state: 'listening',
            source: 'detected',
        });
        expect(snapshot.entries[0]?.provenance?.process).toMatchObject({ pid: 400, ppid: 300 });
    });

    it('single-flights concurrent refreshInventoryNow callers onto one coalesced scan', async () => {
        let resolveScan: () => void = () => {};
        const scanGate = new Promise<void>((resolve) => {
            resolveScan = resolve;
        });
        const scan = vi.fn(async () => {
            await scanGate;
            return {
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const, pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 1, command: 'node server.js', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            };
        });
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        // Three concurrent refresh requests (e.g. the loop tick + an RPC manual refresh +
        // a bare caller) must share a single in-flight scan rather than stacking machine-wide
        // scans on top of each other.
        const first = runtime.refreshInventoryNow();
        const second = runtime.refreshInventoryNow();
        const third = runtime.refreshInventoryNow();
        resolveScan();
        const [a, b, c] = await Promise.all([first, second, third]);

        expect(scan).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(a.entries).toHaveLength(1);

        // A later refresh, once the first has settled, starts a fresh scan (the guard
        // coalesces overlapping callers, it does not cache forever).
        await runtime.refreshInventoryNow();
        expect(scan).toHaveBeenCalledTimes(2);
    });

    it('adds daemon-owned workspace facts to scanner results before normalizing provenance', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'npm run dev -- --token raw-secret', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            workspaceFacts: () => [{ path: '/repo' }],
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries[0]).toMatchObject({
            workspaceAssociationConfidence: 'high',
            provenance: {
                workspace: {
                    path: '/repo',
                    association: 'cwd_containment',
                },
            },
        });
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
    });

    it('enriches listening local services with bounded page-title presentation without changing identity', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            pageTitleEnricher: {
                fetchTitle: async (url) => {
                    expect(url).toBe('http://127.0.0.1:5173/');
                    return { title: 'Local Vite App', source: 'html_title' };
                },
            },
            endpointEnricher: createLocalServiceEndpointEnricher({
                now: () => 2_000, timeoutMs: 250, concurrency: 1,
                successTtlMs: 30_000, failureTtlMs: 5_000,
                probe: async ({ scheme }) => scheme === 'http',
            }),
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-unknown',
            presentation: {
                displayName: 'Vite',
                pageTitle: 'Local Vite App',
                pageTitleSource: 'html_title',
                addressLabel: 'localhost:5173',
            },
        });
    });

    it('owns one registered preview registry and exposes it as a snapshot route', async () => {
        const server = previewServerBoundary();
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            accountId: 'account-a', previewServer: server.input,
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 4_000,
            startLoop: false,
        });

        expect(runtime.previewRegistry).toBeTruthy();
        expect(runtime.previewRoutes).toBeTruthy();

        registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-b',
            sessionId: 'session-b',
            machineId: 'machine-a',
            owner: { kind: 'agent', id: 'agent-b' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5174 },
            initialPath: { pathname: '/b', search: '' },
            display: { title: 'B', addressLabel: 'localhost:5174' },
            originMode: 'host',
        });
        registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-a',
            sessionId: 'session-a',
            machineId: 'machine-a',
            owner: { kind: 'plugin', id: 'plugin-a' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '?v=1' },
            display: { title: 'A', addressLabel: 'localhost:5173' },
            originMode: 'host',
        });

        await expect(runtime.previewRoutes.getSnapshot()).resolves.toMatchObject({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 4_000,
            refreshState: 'idle',
            resources: [
                { previewId: 'preview-a' },
                { previewId: 'preview-b' },
            ],
            diagnostics: [],
        });
    });

    it('activates hosted-web static asset previews through the daemon-owned preview registry', async () => {
        const server = previewServerBoundary();
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            accountId: 'account-a', previewServer: server.input,
            inventoryEnabled: () => false,
            now: () => 5_000,
            startLoop: false,
            hostedWebStaticAssets: {
                verifyArtifact: () => ({ ok: true }),
                startServer: async (input) => {
                    const previewId = buildPluginHostedWebStaticAssetPreviewId(input.preview);
                    const previewResource = {
                        previewId,
                        sessionId: input.preview.sessionId,
                        machineId: input.preview.machineId,
                        owner: { kind: 'plugin' as const, id: input.preview.pluginId },
                        target: { scheme: 'http' as const, host: '127.0.0.1', port: 51515 },
                        initialPath: { pathname: '/', search: '' },
                        display: { title: input.preview.title, addressLabel: '127.0.0.1:51515' },
                        originMode: 'host' as const,
                    };
                    return {
                        baseUrl: 'http://127.0.0.1:51515',
                        endpoint: { scheme: 'http', host: '127.0.0.1', port: 51515 },
                        previewResource,
                        previewRegistration: await input.registerPreview?.(previewResource),
                        stop: async () => {
                            await input.unregisterPreview?.(previewId);
                        },
                    };
                },
            },
        });

        const contributions: Parameters<typeof runtime.syncHostedWebStaticAssets>[0] = [{
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            machineId: 'machine-a',
            title: 'Preview web',
            installedRoot: '/plugin/root/dist/happier-plugin-ui',
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web',
                assetRootId: 'hosted-web/preview-web',
            },
            artifactManifest: {
                version: 2,
                entries: [{
                    artifactId: 'preview-web',
                    tier: 'hostedWeb',
                    entry: 'hosted-web/preview-web/index.html',
                    files: [{
                        relativePath: 'hosted-web/preview-web/index.html',
                        digest: `sha256:${'b'.repeat(64)}`,
                        byteSize: 1,
                    }],
                    digest: `sha256:${'a'.repeat(64)}`,
                    builtWith: { staging: 'staticDirectory' },
                    hostUiApiRange: '^1.0.0',
                }],
            },
            security: {
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [],
                csp: {
                    connectSrc: 'selfOnly',
                    allowDataUrls: false,
                    allowBlobUrls: false,
                    allowInlineStyles: false,
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'deny',
            },
        }];

        const result = await runtime.syncHostedWebStaticAssets(contributions);
        expect(result).toMatchObject({ active: [expect.anything()], diagnostics: [] });
        // Explicit activation publishes the registration; observing a snapshot is read-only.
        expect(server.registrations.size).toBe(1);
        expect([...runtime.previewRegistry.previewsById.values()][0]?.accessUrl).toBe('https://preview.example.test/');
        expect(await runtime.syncHostedWebStaticAssets([])).toMatchObject({ active: [], diagnostics: [] });
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
        expect(await runtime.syncHostedWebStaticAssets(contributions)).toMatchObject({ active: [expect.anything()], diagnostics: [] });
        await runtime.previewRoutes.getSnapshot();
        expect(server.registrations.size).toBe(1);
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([
            expect.objectContaining({
                previewId: 'plugin-static:acme.preview:preview-web:session-a:machine-a',
                sessionId: 'session-a',
                owner: { kind: 'plugin', id: 'acme.preview' },
            }),
        ]);

        await runtime.syncHostedWebStaticAssets([]);
        const publish = server.input.http.post;
        server.input.http.post = async () => { throw new Error('Preview server unavailable'); };
        expect(await runtime.syncHostedWebStaticAssets(contributions)).toMatchObject({
            active: [], diagnostics: [{ code: 'static_asset_server_start_failed' }],
        });
        expect((await runtime.previewRoutes.getSnapshot()).previews).toEqual([
            expect.objectContaining({ accessUrl: null, diagnostics: [expect.objectContaining({ code: 'preview_registration_failed' })] }),
        ]);
        server.input.http.post = publish;
        expect(await runtime.syncHostedWebStaticAssets(contributions)).toMatchObject({ active: [expect.anything()], diagnostics: [] });

        await runtime.stop();
        await expect(runtime.stopHostedWebStaticAssets()).resolves.toBeUndefined();
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
        expect(server.registrations.size).toBe(0);
    });

    it('scans only while an inventory watch is parked, and serves an unwatched reader on demand', async () => {
        vi.useFakeTimers();
        try {
            const scan = vi.fn(async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [],
            }));
            let clock = 10_000;
            const runtime = createLocalServicesDaemonRuntime({
                machineId: 'machine-a',
                inventoryEnabled: () => true,
                scan,
                now: () => clock,
                refreshIntervalMs: 1_000,
            });

            // Nobody is watching: the machine-wide scan plus its TLS/HEAD probes stay off
            // (tunnels audit 4.6 — this used to run unconditionally for a consumer that never
            // subscribed).
            await vi.advanceTimersByTimeAsync(5_000);
            expect(scan).not.toHaveBeenCalled();

            const parked = runtime.inventoryRoutes.watchSnapshot({});
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(scan.mock.calls.length).toBeGreaterThanOrEqual(1);

            // The watch is answered by the scan it enabled, and the loop idles again afterwards.
            expect((await parked).changed).toBe(true);
            const scansWhileWatched = scan.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5_000);
            expect(scan.mock.calls.length).toBe(scansWhileWatched);

            // A reader with no watch (an agent, or the launcher feed) still gets fresh data.
            clock += 60_000;
            await runtime.inventoryRoutes.getSnapshot();
            expect(scan.mock.calls.length).toBe(scansWhileWatched + 1);

            await runtime.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
