import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginServiceLaunchEnvironmentInputV1 } from '@happier-dev/plugin-sdk';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { activatePluginRuntimeRegistry } from '../manager';
import { prepareServiceLaunchEnvironments } from './targetServiceLaunchEnvironments';
import { createWorktreePortsOwner } from '@/workspaces/execution/worktreePorts';

const originalEnvironment = { DATABASE_URL: 'postgres://localhost/original', PRIVATE_TOKEN: 'excluded' };
const input = {
    workspace: { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/work/project', createdAtMs: 1 },
    project: { serverId: 'home', projectId: 'project' }, serviceId: 'web',
    executionPlacement: { mode: 'spawn', machineId: 'machine' },
    async readEnvironment(names: readonly string[]) {
        return {
            projectedEnvironment: Object.fromEntries(names.flatMap(name => name === 'DATABASE_URL' ? [[name, originalEnvironment.DATABASE_URL]] : [])),
            provenance: { DATABASE_URL: { source: 'dotenv' as const, file: '.env' as const } },
        };
    },
    assignedPorts: { database: 15432 },
} satisfies Omit<PluginServiceLaunchEnvironmentInputV1, 'readEnvironment'> & {
    readEnvironment(names: readonly string[]): ReturnType<PluginServiceLaunchEnvironmentInputV1['readEnvironment']>;
};

describe('service launch environment contribution activation', () => {
    it('uses real declarations and activation, projects names, and preserves original inputs for every contributor', async () => {
        const rootPath = await mkdtemp(join(tmpdir(), 'service-listener-demand-'));
        const statePath = join(rootPath, 'host', 'ports.json');
        const ports = createWorktreePortsOwner({ statePath });
        const received: Awaited<ReturnType<PluginServiceLaunchEnvironmentInputV1['readEnvironment']>>[] = [];
        const demandedNames: string[][] = [];
        let allocatedPort: number | undefined;
        let allocatedOtlpPort: number | undefined;
        let existingDatabasePort: number | undefined;
        const listenerDemands: string[][] = [];
        const hostInput = { ...input, async requestListenerPorts(keys: readonly string[]) {
            listenerDemands.push([...keys]);
            return ports.assign({ rootPath, listenerKeys: keys });
        }, async readEnvironment(names: readonly string[]) {
            demandedNames.push([...names]);
            return input.readEnvironment(names);
        } };
        let releases = 0;
        const plugin = definePlugin({ id: 'acme.capture', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, serviceLaunchEnvironments: {
            capture: { declaration: { environmentNames: ['DATABASE_URL', 'OTEL_SERVICE_NAME'] }, runtime: {
                async prepare(request) {
                    expect(request.assignedPorts).toEqual({ database: existingDatabasePort });
                    received.push(await request.readEnvironment());
                    const assigned = await request.requestListenerPorts?.(['database', 'otlp']);
                    if (assigned?.kind !== 'ready') throw new Error('Expected named listener assignment');
                    allocatedPort = assigned.assignment.listenerPorts.database;
                    allocatedOtlpPort = assigned.assignment.listenerPorts.otlp;
                    return { kind: 'replace', replacements: { DATABASE_URL: `postgres://localhost:${allocatedPort}/original` },
                        defaults: { OTEL_SERVICE_NAME: 'project/web' }, release: async () => { releases++; } };
                },
            } },
            broken: { declaration: { environmentNames: ['DATABASE_URL'] }, runtime: {
                async prepare(request) { received.push(await request.readEnvironment()); throw new Error('private upstream value'); },
            } },
            off: { declaration: { environmentNames: ['PRIVATE_TOKEN'] }, runtime: {
                async prepare() { return { kind: 'unchanged' }; },
            } },
        } });
        const ingested = ingestCanonicalPluginManifest(plugin.manifest, { sourceProvenance: 'registryCustodied' });
        expect(ingested).toMatchObject({ ok: true });
        if (!ingested.ok) throw new Error('Expected admitted service environment declaration');
        const contributes = createResolvedContributionRegistry({ activationTargets: [{
            provenance: 'first_party', source: { kind: 'bundled' }, pluginId: plugin.manifest.id,
            manifestPath: '/virtual/capture/plugin.json', daemonEntryPath: '/virtual/capture/daemon.mjs',
            sourceSpec: { kind: 'package', locator: '@acme/capture', trustPolicy: 'local_trusted', installPolicy: 'copy' },
            activationEvents: [], manifest: ingested.manifest,
        }] });
        const registry = await activatePluginRuntimeRegistry({ contributes, generation: 1,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: '@acme/capture/daemon', load: async () => plugin }),
        });
        try {
            // A role/background service activates the plugin before launch preparation.
            // The contribution call itself must never acquire plugin readiness.
            expect(await prepareServiceLaunchEnvironments({ targets: contributes.activationTargets, registry, input: hostInput })).toMatchObject([
                { result: { kind: 'unavailable', code: 'service_launch_environment_unavailable' } },
                { result: { kind: 'unavailable', code: 'service_launch_environment_unavailable' } },
                { result: { kind: 'unavailable', code: 'service_launch_environment_unavailable' } },
            ]);
            expect(received).toHaveLength(0);
            expect(demandedNames).toEqual([]);
            expect(listenerDemands).toEqual([]);
            await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            const ordinaryPorts = await ports.assign({ rootPath, slots: 1,
                listenerKeys: ['acme.capture/capture/database', 'acme.capture/other/database'] });
            if (ordinaryPorts.kind !== 'ready') throw new Error('Expected ordinary worktree assignment');
            existingDatabasePort = ordinaryPorts.assignment.listenerPorts['acme.capture/capture/database'];
            await registry.activateContributionsOnDemand([{ pluginId: 'acme.capture', family: 'serviceLaunchEnvironments', localId: 'capture' }]);
            const results = await prepareServiceLaunchEnvironments({ targets: contributes.activationTargets, registry,
                input: { ...hostInput, assignedPorts: ordinaryPorts.assignment.listenerPorts } });
            expect(received).toHaveLength(2);
            expect(listenerDemands).toEqual([['acme.capture/capture/database', 'acme.capture/capture/otlp']]);
            expect(received[0]?.projectedEnvironment).toEqual({ DATABASE_URL: 'postgres://localhost/original' });
            expect(received[1]?.projectedEnvironment).toEqual({ DATABASE_URL: 'postgres://localhost/original' });
            expect(received[0]?.provenance).toEqual({ DATABASE_URL: { source: 'dotenv', file: '.env' } });
            expect(demandedNames).toEqual([['DATABASE_URL', 'OTEL_SERVICE_NAME'], ['DATABASE_URL']]);
            expect(allocatedPort).toBeGreaterThan(0);
            expect(allocatedPort).toBe(existingDatabasePort);
            expect(allocatedOtlpPort).toBeGreaterThan(0);
            expect(allocatedOtlpPort).not.toBe(allocatedPort);
            expect(await ports.read({ rootPath })).toEqual({ kind: 'ready', assignment: {
                ports: ordinaryPorts.assignment.ports,
                listenerPorts: { ...ordinaryPorts.assignment.listenerPorts, 'acme.capture/capture/otlp': allocatedOtlpPort },
            } });
            expect(results).toMatchObject([
                { contribution: { pluginId: 'acme.capture', localId: 'capture' }, result: { kind: 'replace', defaults: { OTEL_SERVICE_NAME: 'project/web' } } },
                { contribution: { pluginId: 'acme.capture', localId: 'broken' }, result: { kind: 'unavailable', code: 'service_launch_environment_failed' } },
                { contribution: { pluginId: 'acme.capture', localId: 'off' }, result: { kind: 'unchanged' } },
            ]);
            const replacement = results[0]?.result;
            if (replacement?.kind !== 'replace') throw new Error('Expected retained service contribution');
            expect(releases).toBe(0);
            await replacement.release();
            expect(releases).toBe(1);
            expect(originalEnvironment.DATABASE_URL).toBe('postgres://localhost/original');
        } finally { await registry.dispose(); await rm(rootPath, { recursive: true, force: true }); }
    });
});
