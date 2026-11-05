import { expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const native = vi.hoisted(() => ({ starts: [] as string[], closes: [] as string[] }));
// Count real OS watch enrollments, retaining the production discovery and lifecycle.
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
        const path = String(args[0]);
        const watcher = actual.watch(...args);
        native.starts.push(path);
        watcher.on('close', () => native.closes.push(path));
        return watcher;
    } };
});

import { createLocalServicesDaemonRuntime } from './runtime';

it('keeps declaration observation enrolled across value replies until the subscribed consumer leaves', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-lifetime-')));
    await mkdir(join(root, '.happier'));
    const manifest = join(root, '.happier', 'project.json');
    const document = (name: string) => JSON.stringify({ version: 1,
        services: { [name]: { source: { kind: 'command', command: name } } } });
    await writeFile(manifest, document('before'));
    const workspace = { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
    const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false,
        inventoryEnabled: () => true,
        workspaceFacts: () => ({ facts: [{ id: workspace.id, path: root }], acceptedWorkspaceRefs: [workspace], diagnostics: [] }),
        scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
    const subscribed = new AbortController();
    let observation: Promise<unknown> | undefined;
    let reply: Promise<unknown> | undefined;
    try {
        await runtime.inventoryRoutes.getSnapshot();
        observation = runtime.inventoryRoutes.watchSnapshot({ observationOnly: true, signal: subscribed.signal });
        await vi.waitFor(() => expect(native.starts.some(path => path.startsWith(root))).toBe(true));
        // Let the initial reconciliation finish before measuring stable enrollment.
        await runtime.launcherRoutes.getSnapshot({ scope: 'machine' });
        native.starts.length = 0;
        native.closes.length = 0;
        for (let index = 0; index < 8; index++) {
            reply = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt,
                signal: subscribed.signal });
            await vi.waitFor(() => expect(runtime.inventoryRoutes.watcherCount()).toBe(2));
            runtime.inventoryRegistry.invalidate();
            await expect(reply).resolves.toMatchObject({ changed: true });
            // This is the network re-arm gap: no value RPC remains outstanding.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(runtime.inventoryRoutes.watcherCount()).toBe(1);
        }
        expect(native.closes).toHaveLength(0);
        expect(native.starts).toHaveLength(0);
        reply = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt,
            signal: subscribed.signal });
        await writeFile(manifest, document('after'));
        await expect(reply).resolves.toMatchObject({ changed: true });
        const changed = await runtime.launcherRoutes.getSnapshot({ scope: 'machine', discovery: 'cached' });
        expect(changed.targets.map(target => target.declaration?.selection)).toEqual([{ kind: 'manifest', name: 'after' }]);
        expect(native.closes).toHaveLength(0);
        expect(native.starts).toHaveLength(0);
        subscribed.abort();
        await observation;
        await vi.waitFor(() => expect(native.closes.length).toBeGreaterThan(0));
        expect(runtime.inventoryRoutes.watcherCount()).toBe(0);
    } finally {
        subscribed.abort();
        await Promise.all([observation, reply]);
        await runtime.stop();
        await rm(root, { recursive: true, force: true });
    }
});
