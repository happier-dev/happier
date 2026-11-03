import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MachineServicesDiscoveryResultV1Schema, MachineServicesListResultV1Schema,
    type MachineMetadataFieldReadV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { createMachineServicesRuntime } from './machineServices';

describe('bundled Compose Machine services', () => {
    it.skipIf(process.platform === 'win32')('discovers and watches the exact native project without changing it, through installed admission and real Exec', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-bundled-compose-'));
        const callsPath = join(root, 'calls.jsonl');
        const statePath = join(root, 'native-state.json');
        const executablePath = join(root, 'docker');
        const containerIds = ['a'.repeat(64), 'b'.repeat(64)];
        const native = { engineId: 'engine-a', project: 'existing-production', state: 'running' };
        await writeFile(statePath, JSON.stringify(native));
        // Genuine OS/Docker boundary only. The installed tool resolver, plugin
        // activation, Exec admission, subprocess settlement and watch owner are real.
        await writeFile(executablePath, `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+'\\n');
const ids=${JSON.stringify(containerIds)};
if(args.includes('info')) process.stdout.write(args.includes('{{.ID}}')?state.engineId:JSON.stringify({ID:state.engineId,OSType:'linux',Architecture:'x86_64'}));
else if(args[0]==='ps') process.stdout.write(ids.join('\\n')+'\\n');
else if(args[0]==='inspect') process.stdout.write(JSON.stringify(ids.map((id,index)=>({Id:id,Image:'sha256:'+'c'.repeat(64),Config:{Labels:{'com.docker.compose.project':state.project,'com.docker.compose.service':index?'worker':'web','com.docker.compose.oneoff':'False'}},State:{Status:state.state,Health:{Status:'healthy'}},NetworkSettings:{Ports:{}},Mounts:[]}))));
else if(args[0]==='logs') process.stdout.write('native '+args.at(-1).slice(0,1)+' log\\n');
else if(['start','stop','restart','up','down','run','build','pull'].some(verb=>args.includes(verb))){fs.writeFileSync(${JSON.stringify(statePath)},JSON.stringify({...state,state:'MUTATED'}));process.exitCode=18;}
else process.exitCode=19;
`, { mode: 0o700 });
        await chmod(executablePath, 0o700);
        vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`);
        const target = { serverId: 'home', machineId: 'machine' };
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        const adapter = { pluginId: 'happier.machine.services', localId: 'compose' };
        let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: { displayName: 'Original' } };
        const port: MachineMetadataFieldPortV1 = { read: async () => metadata, compareAndSwap: async input => {
            if (metadata.status !== 'ready') return metadata;
            if (metadata.metadataVersion !== input.expectedMetadataVersion) return { ...metadata, status: 'conflict' };
            metadata = { status: 'ready', metadataVersion: metadata.metadataVersion + 1, metadata: input.metadata };
            return { ...metadata, status: 'applied' };
        } };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port });
        let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        let environmentHandle: Readonly<{ dispose(): Promise<void> }> | undefined;
        try {
            fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
                runtimeOptions: { pluginIds: ['happier.machine.services'] } });
            const discovered = MachineServicesDiscoveryResultV1Schema.parse(await runtime.execute({
                actionId: 'machines.services.discovery', input: { ...target, adapter }, context,
            }));
            expect(discovered).toMatchObject({ kind: 'snapshot', failures: [], candidates: [{
                adapter, name: native.project, nativeResourceId: JSON.stringify([native.engineId, native.project]),
                observation: { phase: 'running', readiness: 'ready' },
            }] });
            if (discovered.kind !== 'snapshot' || discovered.candidates.length !== 1) throw new Error('Expected one native Compose project');
            const candidate = discovered.candidates[0]!;
            expect(await runtime.execute({ actionId: 'machines.services.watch', context, input: { ...target,
                candidateId: candidate.candidateId, expectedRevision: candidate.revision, lifecyclePurpose: 'deployment',
            } })).toMatchObject({ kind: 'applied' });
            const listed = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            expect(listed).toMatchObject({ kind: 'snapshot', services: [{ authority: 'machine',
                capabilities: { start: false, restart: false, logs: true }, native: { phase: 'running' },
            }] });
            const selected = await fixture.registry.resolveProjectNativeAdapter(adapter, 'nativeServiceLifecycle');
            if (selected.kind !== 'ready') throw new Error('Compose lifecycle did not activate');
            const captured = selected.lease.captureNativeServiceLifecycle(candidate, { machine: target });
            if (captured.kind !== 'ready') throw new Error('Compose lifecycle did not capture');
            try {
                expect(captured.lifecycle.start).toBeUndefined();
                expect(captured.lifecycle.restart).toBeUndefined();
                expect(await captured.lifecycle.stop(candidate)).toEqual({ status: 'unsupported' });
                expect(await captured.lifecycle.logs!(candidate, { kind: 'read', maxBytes: 128 }))
                    .toMatchObject({ kind: 'page', page: { text: expect.stringContaining('native a log') } });
                const bounded = await captured.lifecycle.logs!(candidate, { kind: 'read', maxBytes: 5 });
                expect(bounded).toMatchObject({ kind: 'page', page: { truncated: true } });
                if (bounded.kind !== 'page') throw new Error('Expected a bounded native log page');
                expect(Buffer.byteLength(bounded.page.text)).toBeLessThanOrEqual(5);
                const callsBeforeFollow = await readFile(callsPath, 'utf8');
                const follow: unknown[] = [];
                const subscription = await captured.lifecycle.logs!(candidate, { kind: 'watch', maxBytes: 128,
                    emit: value => { follow.push(value); } });
                expect(follow).toEqual([{ kind: 'unavailable', reason: 'unsupported' }]);
                await subscription.dispose();
                expect(await readFile(callsPath, 'utf8')).toBe(callsBeforeFollow);
                await writeFile(statePath, JSON.stringify({ ...native, engineId: 'other-engine' }));
                expect(await captured.lifecycle.inspect(candidate)).toMatchObject({ phase: 'unknown' });
                expect(await captured.lifecycle.logs!(candidate, { kind: 'read', maxBytes: 128 }))
                    .toMatchObject({ kind: 'unavailable' });
                await writeFile(statePath, JSON.stringify(native));
            } finally { await captured.release(); }
            if (listed.kind !== 'snapshot') throw new Error('Expected watched service');
            const row = listed.services[0]!;
            expect(await runtime.execute({ actionId: 'machines.services.unwatch', context, input: { ...target,
                watchId: row.watchId!, expectedRevision: row.watchRevision!,
            } })).toMatchObject({ kind: 'applied' });
            const document = JSON.stringify({ name: native.project, services: { web: { image: 'example/web:1' } } });
            const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                return { environmentId: 'production', environmentInstanceId: 'production-machine', deploymentId: 'deploy-a',
                    machineId: target.machineId, installationId: 'installation', deploymentRoot: join(root, 'deployments'),
                    artifactDirectory: join(root, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
                        document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                        profiles: [], services: ['web'] }, async assertCurrent() {} };
            } });
            const release = await materializer.materialize({ environmentId: 'production', deploymentId: 'deploy-a' });
            await release.commit();
            const managedCapture = selected.lease.captureNativeServiceLifecycle(candidate, { machine: target });
            if (managedCapture.kind !== 'ready') throw new Error('Managed native observation did not capture');
            // Real stored materialization and semantic owner, observing through
            // the actual installed adapter and the same external Docker process.
            const coldRuntime = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port,
                async restoreEnvironmentServices(owner) {
                    environmentHandle = await owner.superviseProject({ kind: 'environment', ...target,
                        environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
                        deploymentId: release.deploymentId, release, composeService: 'web', serviceId: 'production-machine/web',
                        specIdentity: 'deploy-a', isCurrent: () => true, nativeInstances: [candidate,
                            { adapter, nativeResourceId: JSON.stringify([native.engineId, native.project, 'web']) }],
                        nativeEffects: { keys: [{ kind: 'composeProject', dockerEndpoint: native.engineId, projectName: native.project }] },
                        releaseObservation: managedCapture.release,
                        processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
                            inspect: options => managedCapture.lifecycle.inspect(candidate, options),
                            stop: options => managedCapture.lifecycle.stop(candidate, options),
                        } } },
                    });
                },
            });
            try {
                // Discovery must restore the same ownership facts as list/detail,
                // even when the picker is the first read after daemon startup.
                expect(await coldRuntime.execute({ actionId: 'machines.services.discovery', input: { ...target, adapter }, context }))
                    .toMatchObject({ kind: 'snapshot', candidates: [], failures: [] });
                expect(await coldRuntime.execute({ actionId: 'machines.services.list', input: target, context,
                    canReadEnvironments: async ids => new Set(ids) }))
                    .toMatchObject({ kind: 'snapshot', services: [{ authority: 'project', environmentId: 'production' }] });
                // A similar name is not ownership. Retain the human Compose name
                // separately from its opaque engine/project identity.
                const unownedProject = 'happier-unowned';
                await writeFile(statePath, JSON.stringify({ ...native, project: unownedProject }));
                expect(await coldRuntime.execute({ actionId: 'machines.services.discovery', input: { ...target, adapter }, context }))
                    .toMatchObject({ kind: 'snapshot', failures: [], candidates: [{ name: unownedProject,
                        nativeResourceId: JSON.stringify([native.engineId, unownedProject]) }] });
                await writeFile(statePath, JSON.stringify(native));
            } finally {
                await coldRuntime.dispose();
                if (!environmentHandle) await managedCapture.release();
            }
            expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(native);
            const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
            expect(calls.filter(args => args.some(arg => ['start', 'stop', 'restart', 'up', 'down', 'run', 'build', 'pull'].includes(arg)))).toEqual([]);
            expect(metadata).toMatchObject({ metadata: { displayName: 'Original', serviceWatchesV1: { watches: [] } } });
        } finally {
            try { await environmentHandle?.dispose(); }
            finally { await runtime.dispose(); await fixture?.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
        }
    });
});
