import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MachineServicesDiscoveryResultV1Schema, MachineServicesListResultV1Schema,
    type MachineMetadataFieldReadV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineServicesRuntime } from './machineServices';

describe('bundled systemd Machine services', () => {
    it.skipIf(process.platform !== 'linux')('activates the actual bundle, watches passively and controls only its daemon-user unit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-bundled-systemd-'));
        const callsPath = join(root, 'calls.jsonl');
        const statePath = join(root, 'state');
        const loadPath = join(root, 'load');
        const subPath = join(root, 'sub');
        const factsPath = join(root, 'facts');
        const denySystemPath = join(root, 'deny-system');
        const executablePath = join(root, 'systemctl');
        // Genuine OS/systemd boundary: the normal declared-tool resolver and Exec
        // launch real children; only the external systemctl executable is replaced.
        await writeFile(statePath, 'active');
        await writeFile(loadPath, 'loaded');
        await writeFile(subPath, 'running');
        const sourceFacts = { memoryBytes: 4096, startedAt: 'Mon 2026-11-02 13:00:00 UTC', activeSince: 'Mon 2026-11-02 13:00:02 UTC' };
        await writeFile(factsPath, JSON.stringify(sourceFacts));
        await writeFile(executablePath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args)+'\\n');
const user = args.includes('--user');
const unit = user ? 'worker.service' : 'system-worker.service';
const facts = JSON.parse(fs.readFileSync(${JSON.stringify(factsPath)}, 'utf8'));
if (!user && fs.existsSync(${JSON.stringify(denySystemPath)})) process.exit(5);
if (args.includes('list-units')) process.stdout.write(unit+' loaded '+(user?fs.readFileSync(${JSON.stringify(statePath)},'utf8'):'active')+' running Worker\\n');
else if (args.includes('show')) process.stdout.write('LoadState='+fs.readFileSync(${JSON.stringify(loadPath)},'utf8')+'\\nActiveState='+(user?fs.readFileSync(${JSON.stringify(statePath)},'utf8'):'active')+'\\nSubState='+fs.readFileSync(${JSON.stringify(subPath)},'utf8')+'\\nMemoryCurrent='+(facts.memoryBytes??'[not set]')+'\\nExecMainStartTimestamp='+(facts.startedAt??'')+'\\nActiveEnterTimestamp='+(facts.activeSince??'')+'\\n');
else if (user && args.includes('stop')) fs.writeFileSync(${JSON.stringify(statePath)},'inactive');
else if (user && (args.includes('start') || args.includes('restart'))) fs.writeFileSync(${JSON.stringify(statePath)},'active');
else process.exitCode=17;
`, { mode: 0o700 });
        await chmod(executablePath, 0o700);
        vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`);
        const target = { serverId: 'home', machineId: 'machine' };
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: { displayName: 'Original' } };
        const port: MachineMetadataFieldPortV1 = { read: async () => metadata, compareAndSwap: async input => {
            if (metadata.status !== 'ready') return metadata;
            if (metadata.metadataVersion !== input.expectedMetadataVersion) return { ...metadata, status: 'conflict' };
            metadata = { status: 'ready', metadataVersion: metadata.metadataVersion + 1, metadata: input.metadata };
            return { ...metadata, status: 'applied' };
        } };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port });
        let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        try {
            fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
                runtimeOptions: { pluginIds: ['happier.machine.services'], agentIsolation: {
                    read: () => ({ enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }),
                    prepareLaunch: async () => { throw new Error('A native Machine service cannot prepare Agent material'); },
                } } });
            const discovery = MachineServicesDiscoveryResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.discovery',
                input: { ...target, adapter: { pluginId: 'happier.machine.services', localId: 'systemd' } }, context }));
            expect(discovery).toMatchObject({ kind: 'snapshot', failures: [], candidates: [
                { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'user/worker.service', observation: { phase: 'running' } },
                { nativeResourceId: 'system/system-worker.service' },
            ] });
            if (discovery.kind !== 'snapshot') throw new Error('Expected native discovery');
            const candidate = discovery.candidates.find(value => value.nativeResourceId === 'user/worker.service')!;
            expect(await runtime.execute({ actionId: 'machines.services.watch', context, input: { ...target,
                candidateId: candidate.candidateId, expectedRevision: candidate.revision, lifecyclePurpose: 'infrastructure' } })).toMatchObject({ kind: 'applied' });
            const listed = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            expect(listed).toMatchObject({ kind: 'snapshot', services: [{ authority: 'machine', state: 'running',
                accounting: { memoryBytes: sourceFacts.memoryBytes, startedAtMs: Date.parse(sourceFacts.startedAt) },
                health: { since: Date.parse(sourceFacts.activeSince) },
                capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false } }] });
            if (listed.kind !== 'snapshot') throw new Error('Expected watched service');
            expect(await runtime.execute({ actionId: 'machines.services.detail', input: { ...target, serviceId: listed.services[0]!.serviceId }, context }))
                .toMatchObject({ kind: 'service', runtimeFacts: { configuration: null, freshness: 'current',
                    accounting: { memoryBytes: sourceFacts.memoryBytes, startedAtMs: Date.parse(sourceFacts.startedAt) },
                    healthSince: Date.parse(sourceFacts.activeSince) } });
            const callsBeforeRepeatedList = await readFile(callsPath, 'utf8');
            await runtime.execute({ actionId: 'machines.services.list', input: target, context });
            expect(await readFile(callsPath, 'utf8')).toBe(callsBeforeRepeatedList);
            const adopted = fixture.registry.projectManagedServices.listMachineServices()[0]!;
            const changedFacts = { ...sourceFacts, memoryBytes: 0, activeSince: 'Mon 2026-11-02 13:00:03 UTC' };
            await writeFile(factsPath, JSON.stringify(changedFacts));
            await adopted.inspectCurrentOccurrence();
            expect(MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context })))
                .toMatchObject({ kind: 'snapshot', services: [{ accounting: { memoryBytes: 0 }, health: { since: Date.parse(changedFacts.activeSince) } }] });
            // Inspect once; projection of its retained native facts performs no IO.
            expect((await readFile(callsPath, 'utf8')).trim().split('\n').length - callsBeforeRepeatedList.trim().split('\n').length).toBe(1);
            await writeFile(loadPath, 'not-found');
            await adopted.inspectCurrentOccurrence();
            expect(adopted.readNativeRuntimeFacts()).toEqual({ configuration: null, freshness: 'unavailable', observedAt: null });
            const unknown = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            expect(unknown).toMatchObject({ kind: 'snapshot', services: [{ native: { phase: 'unknown' },
                health: { status: 'unknown', freshness: 'unavailable', observedAtMs: null, reason: 'coverage_unavailable' } }] });
            if (unknown.kind !== 'snapshot') throw new Error('Expected unknown native service observation');
            expect(unknown.services[0]).not.toHaveProperty('accounting');
            expect(unknown.services[0]!.health).not.toHaveProperty('since');
            await writeFile(loadPath, 'loaded');
            await adopted.inspectCurrentOccurrence();
            expect(adopted.readNativeRuntimeFacts()).toMatchObject({ freshness: 'current',
                accounting: { memoryBytes: 0 }, healthSince: Date.parse(changedFacts.activeSince) });
            expect(await readFile(statePath, 'utf8')).toBe('active');
            const selected = await fixture.registry.resolveProjectNativeAdapter(candidate.adapter, 'nativeServiceLifecycle');
            if (selected.kind !== 'ready') throw new Error('Bundled adapter did not activate');
            const captured = selected.lease.captureNativeServiceLifecycle(candidate, { machine: target });
            if (captured.kind !== 'ready') throw new Error('Bundled lifecycle did not capture');
            try {
                expect(await adopted.controlNative('stop', { operation: { operationId: 'fixture-stop', kind: 'machine-services-control' } }))
                    .toMatchObject({ kind: 'observed' });
                expect(await readFile(statePath, 'utf8')).toBe('inactive');
                expect(adopted.readNativeRuntimeFacts()).toEqual({ configuration: null, freshness: 'current', observedAt: expect.any(Number) });
                expect(await adopted.controlNative('start', { operation: { operationId: 'fixture-start', kind: 'machine-services-control' } }))
                    .toMatchObject({ kind: 'observed' });
                expect(adopted.readNativeRuntimeFacts()).toMatchObject({ accounting: { memoryBytes: 0 }, healthSince: Date.parse(changedFacts.activeSince) });
                await writeFile(factsPath, '{}');
                for (const [load, active, sub, phase, readiness] of [
                    ['loaded', 'inactive', 'dead', 'stopped', 'not_ready'],
                    ['loaded', 'failed', 'failed', 'stopped', 'not_ready'],
                    ['not-found', 'active', 'running', 'unknown', 'not_ready'],
                    ['loaded', 'activating', 'start', 'unknown', 'not_ready'],
                    ['loaded', 'active', 'exited', 'running', 'not_reported'],
                ]) {
                    await Promise.all([writeFile(loadPath, load!), writeFile(statePath, active!), writeFile(subPath, sub!)]);
                    expect(await captured.lifecycle.inspect(candidate)).toEqual({ phase, readiness, endpoint: null });
                }
                await Promise.all([writeFile(loadPath, 'loaded'), writeFile(statePath, 'active'), writeFile(subPath, 'running')]);
            } finally { await captured.release(); }
            const systemCandidate = discovery.candidates.find(value => value.nativeResourceId === 'system/system-worker.service')!;
            const systemCapture = selected.lease.captureNativeServiceLifecycle(systemCandidate, { machine: target });
            if (systemCapture.kind !== 'ready') throw new Error('System lifecycle did not capture');
            try { expect(await systemCapture.lifecycle.stop(systemCandidate)).toEqual({ status: 'unsupported' }); }
            finally { await systemCapture.release(); }
            if (listed.kind !== 'snapshot') throw new Error('Expected watched service');
            const row = listed.services[0]!;
            expect(await runtime.execute({ actionId: 'machines.services.unwatch', context, input: { ...target,
                watchId: row.watchId!, expectedRevision: row.watchRevision! } })).toMatchObject({ kind: 'applied' });
            expect(await readFile(statePath, 'utf8')).toBe('active');
            await writeFile(denySystemPath, 'denied');
            expect(await runtime.execute({ actionId: 'machines.services.discovery',
                input: { ...target, adapter: { pluginId: 'happier.machine.services', localId: 'systemd' } }, context })).toMatchObject({
                kind: 'snapshot', candidates: [{ nativeResourceId: 'user/worker.service' }],
                failures: [{ code: 'systemd_system_discovery_unavailable' }],
            });
            const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
            expect(calls.filter(args => args.some(arg => ['start', 'stop', 'restart'].includes(arg))))
                .toEqual([['--user', '--no-ask-password', 'stop', '--', 'worker.service'], ['--user', '--no-ask-password', 'start', '--', 'worker.service']]);
            expect(metadata).toMatchObject({ metadata: { displayName: 'Original', serviceWatchesV1: { watches: [] } } });
        } finally {
            await runtime.dispose();
            await fixture?.dispose();
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    });
});
