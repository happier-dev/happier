import { describe, expect, it, vi } from 'vitest';
import { createLocalServiceActionConfirmationNonceV1, FeaturesResponseSchema, type LocalServiceActionRequestV1 } from '@happier-dev/protocol';
import { buildPluginHostedWebStaticAssetPreviewId } from '@happier-dev/protocol/plugins/ui';

import { createLocalServicesDaemonRuntime } from './runtime';
import {
    listLocalServicePreviewResources,
    registerLocalServicePreview,
} from './preview/registry';
import type { NormalizedLocalServiceInventorySnapshot } from './inventory/scanner';

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
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
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

        await runtime.refreshInventoryNow();
        const launcherSnapshot = await runtime.launcherRoutes.getSnapshot();
        const target = launcherSnapshot.targets.find((candidate) => candidate.id === 'inventory:entry-1');

        expect(target).toMatchObject({
            state: 'available',
            actions: ['open'],
            browserTarget: { kind: 'externalUrl' },
        });
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
            endpointEnricher: {
                enrich: async (snapshot) => ({
                    ...snapshot,
                    entries: snapshot.entries.map((entry) => ({
                        ...entry,
                        endpoint: {
                            scheme: 'http' as const,
                            host: '127.0.0.1',
                            port: entry.port,
                            probeState: 'ready' as const,
                            probedAt: 2_000,
                        },
                    })),
                }),
            },
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
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
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
            originMode: 'path',
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
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
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
                        originMode: 'path' as const,
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

        const result = await runtime.syncHostedWebStaticAssets([{
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            machineId: 'machine-a',
            title: 'Preview web',
            installedRoot: '/plugin/root/dist/happier-plugin-ui',
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-artifact',
                assetRootId: 'hosted-web/preview-web',
            },
            artifactManifest: {
                version: 1,
                entries: [{
                    contributionId: 'preview-web',
                    tier: 'hostedWeb',
                    platform: 'web',
                    entry: 'hosted-web/preview-web/index.html',
                    files: [{
                        relativePath: 'hosted-web/preview-web/index.html',
                        digest: `sha256:${'b'.repeat(64)}`,
                        byteSize: 1,
                    }],
                    digest: `sha256:${'a'.repeat(64)}`,
                    builtWith: { bundler: 'vite', version: '6.0.0' },
                    hostUiApiVersion: '1.0.0',
                    compat: {},
                }],
            },
            security: {
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [],
                csp: {
                    scriptSrc: 'selfOnly',
                    styleSrc: 'selfOnly',
                    imgSrc: 'selfOnly',
                    fontSrc: 'selfOnly',
                    connectSrc: 'selfOnly',
                    allowDataUrls: false,
                    allowBlobUrls: false,
                    allowInlineStyles: false,
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'deny',
            },
        }]);

        expect(result.active).toHaveLength(1);
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([
            expect.objectContaining({
                previewId: 'plugin-static:acme.preview:preview-web:session-a:machine-a',
                sessionId: 'session-a',
                owner: { kind: 'plugin', id: 'acme.preview' },
            }),
        ]);

        runtime.stop();

        await expect(runtime.stopHostedWebStaticAssets()).resolves.toBeUndefined();
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
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
