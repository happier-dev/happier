import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginProjectNativeAdapterRuntimeV1 } from '@happier-dev/plugin-sdk';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { createPluginInvocationLifetime } from '../../invocation/lifetime';
import { activatePluginRuntimeRegistry } from '../manager';
import { createPluginRuntimeOccurrenceId } from '../../runtimeSlots';
import { resolveProjectNativeAdapter, type ProjectNativeAdapterInvocationContextFactoryV1 } from './targetProjectNativeAdapters';

describe('native lifecycle-only invocation recovery', () => {
    it('uses admitted Exec for inspect and exact Stop after restart, without a command role or retained old invocation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-lifecycle-io-'));
        const statePath = join(root, 'resource.json');
        await writeFile(statePath, JSON.stringify({ phase: 'running' }));
        const pluginId = 'acme.native-lifecycle';
        const instance = { adapter: { pluginId, localId: 'native' }, nativeResourceId: 'exact-surviving-resource' };
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
            runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { projectNativeAdapters: [{ id: 'native', files: ['resource.json'], roles: ['nativeServiceLifecycle'] }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected admitted lifecycle-only fixture');
        const targets = [{ provenance: 'first_party' as const, source: { kind: 'bundled' as const }, pluginId,
            manifestPath: '/virtual/native/plugin.json', daemonEntryPath: '/virtual/native/daemon.mjs',
            sourceSpec: { kind: 'package' as const, locator: '@acme/native', trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [], manifest: ingested.manifest }];
        const contributes = createResolvedContributionRegistry({ activationTargets: targets });
        // Installed tool lookup and plugin module loading are the only boundaries.
        // Admission, Exec spawn/IO, lifecycle capture and occurrence retirement are real.
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => root,
            async resolveExecutable(reference) {
                if (reference.kind !== 'systemTool' || reference.id !== 'fixture.native') throw new Error('No starter tool is admitted');
                return { command: process.execPath };
            },
        } });
        const nativeServiceLifecycle: NonNullable<PluginProjectNativeAdapterRuntimeV1['nativeServiceLifecycle']> = {
            async inspect(candidate, options, context) {
                if (!context || candidate.nativeResourceId !== instance.nativeResourceId) throw new Error('Exact lifecycle context unavailable');
                const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture.native' },
                    args: ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(statePath)}, 'utf8'))`] }, options);
                const state: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
                if (!state || typeof state !== 'object' || !('phase' in state) || state.phase !== 'running' && state.phase !== 'stopped') throw new Error('Malformed native observation');
                return { phase: state.phase, readiness: 'not_reported', endpoint: null };
            },
            async stop(candidate, options, context) {
                if (!context || candidate.nativeResourceId !== instance.nativeResourceId) throw new Error('Exact lifecycle context unavailable');
                await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture.native' },
                    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(statePath)}, '{"phase":"stopped"}')`] }, options);
                return { status: 'stopped' };
            },
        };
        const createInvocationContext: ProjectNativeAdapterInvocationContextFactoryV1 = input => {
            const lifetime = createPluginInvocationLifetime(input.signal);
            const seed = { plugin: { id: pluginId, version: '1.0.0' },
                contribution: { id: 'native', qualifiedId: `${pluginId}/projectNativeAdapters/native` },
                occurrenceId: input.occurrenceId, correlationId: 'native-recovery-test', surface: 'cli' as const,
                signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal, isOccurrenceCurrent: input.isCurrent };
            return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
                filesystemRoots: { pluginData: input.root, workspace: input.root, projects: new Map() }, hostAccessRequests: [],
            }) }, complete() { lifetime.complete(); } };
        };
        const activate = (generation: number) => activatePluginRuntimeRegistry({ contributes, generation,
            occurrenceIdsByPluginId: new Map([[pluginId, createPluginRuntimeOccurrenceId(pluginId)]]),
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: `@acme/native/lifecycle-recovery/${generation}`,
                load: async () => ({ activate(api: PluginApi) { api.projectNativeAdapters.register('native', { nativeServiceLifecycle }); } }) }),
        });
        const original = await activate(1);
        let replacement: Awaited<ReturnType<typeof activate>> | undefined;
        const releases: Array<() => Promise<void>> = [];
        try {
            const selected = await resolveProjectNativeAdapter({ reference: instance.adapter, role: 'nativeServiceLifecycle', targets, registry: original, createInvocationContext });
            if (selected.kind !== 'ready') throw new Error(selected.code);
            const captured = selected.lease.captureNativeServiceLifecycle(instance, { root });
            if (captured.kind !== 'ready') throw new Error(captured.code);
            releases.push(captured.release);
            expect(await captured.lifecycle.inspect(instance)).toMatchObject({ phase: 'running' });
            await original.dispose();
            await expect(captured.lifecycle.stop(instance)).rejects.toThrow();
            expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ phase: 'running' });
            replacement = await activate(2);
            const recovered = await resolveProjectNativeAdapter({ reference: instance.adapter, role: 'nativeServiceLifecycle', targets, registry: replacement, createInvocationContext });
            if (recovered.kind !== 'ready') throw new Error(recovered.code);
            const current = recovered.lease.captureNativeServiceLifecycle(instance, { root });
            if (current.kind !== 'ready') throw new Error(current.code);
            releases.push(current.release);
            expect(await current.lifecycle.inspect(instance)).toMatchObject({ phase: 'running' });
            expect(await current.lifecycle.stop(instance)).toEqual({ status: 'stopped' });
            expect(await current.lifecycle.inspect(instance)).toMatchObject({ phase: 'stopped' });
        } finally {
            for (const release of releases) await release();
            await replacement?.dispose();
            await original.dispose();
            await owners.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });
});
