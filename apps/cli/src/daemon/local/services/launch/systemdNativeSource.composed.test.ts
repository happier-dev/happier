import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { systemdRuntime } from '../../../../../../../packages/plugins/machine-services/src/systemd';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';

describe('systemd native source with production Exec', () => {
    it.skipIf(process.platform === 'linux')('reports unsupported without launching systemd on other native platforms', async () => {
        const lifecycle = systemdRuntime.nativeServiceLifecycle!;
        const instance = { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'user/worker.service' };
        expect(await lifecycle.discover!({ serverId: 'home', machineId: 'machine' })).toEqual({ kind: 'unsupported', code: 'systemd_platform_unsupported' });
        expect(await lifecycle.stop(instance)).toEqual({ status: 'unsupported' });
        expect(await lifecycle.start!(instance)).toEqual({ kind: 'unsupported', code: 'systemd_control_unsupported' });
        expect(await lifecycle.inspect(instance)).toEqual({ phase: 'unknown', readiness: 'not_ready', endpoint: null, displayName: 'worker.service' });
    });

    it.skipIf(process.platform !== 'linux')('preserves native state, partial disclosure and exact daemon-user control without optional capabilities', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-systemd-source-'));
        const state = join(root, 'state.json');
        const calls = join(root, 'calls.jsonl');
        const script = join(root, 'systemctl.cjs');
        const controller = new AbortController();
        await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running', denySystem: false }));
        // OS/systemd is the only substitute. Real Exec launches and settles each child.
        await writeFile(script, `const fs=require('node:fs');const args=process.argv.slice(2);const state=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,bus:process.env.DBUS_SESSION_BUS_ADDRESS,runtime:process.env.XDG_RUNTIME_DIR})+'\\n');
const user=args.includes('--user');if(!user&&state.denySystem)process.exit(5);
if(args.includes('list-units')){process.stdout.write(user&&state.userListingPath?fs.readFileSync(state.userListingPath):(user?'worker.service':'system-worker.service')+' '+state.load+' '+state.active+' '+state.sub+' Worker\\n');if(user&&state.denyUserListing)process.exitCode=5;}
else if(args.includes('show')){const requested=args.find(arg=>arg.startsWith('--property=')).slice('--property='.length).split(',');const properties='LoadState='+state.load+'\\nActiveState='+state.active+'\\nSubState='+state.sub+'\\nMemoryCurrent='+(state.memory??'[not set]')+'\\nExecMainStartTimestamp='+(state.startedAt??'')+'\\nActiveEnterTimestamp='+(state.activeSince??'');process.stdout.write(properties.split('\\n').filter(line=>requested.includes(line.split('=')[0])).join('\\n')+'\\n');}
else if(user&&['start','restart','stop'].some(verb=>args.includes(verb))){if(state.denyControl)process.exit(6);if(!state.ignoreStop){state.active=args.includes('stop')?'inactive':'active';state.sub=args.includes('stop')?'dead':'running';fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(state));}}else process.exitCode=17;`);
        vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/fixture/user-bus');
        vi.stubEnv('XDG_RUNTIME_DIR', '/fixture/runtime');
        const executable = { kind: 'systemTool' as const, id: 'systemctl' };
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolveExecutable: async () => ({ command: process.execPath, args: [script] }),
            resolvePath: async () => { throw new Error('Native Machine operations have no Workspace'); },
            agentIsolation: { read: () => ({ enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }),
                prepareLaunch: async () => { throw new Error('Native Machine operation cannot prepare an Agent'); } },
        } });
        const context: PluginInvocationContext = { plugin: { id: 'happier.machine.services', version: '0.0.0' },
            contribution: { id: 'systemd', qualifiedId: 'happier.machine.services/projectNativeAdapters/systemd' },
            surface: 'cli', signal: controller.signal, invokedAtMs: 0,
            services: owners.createOperationServices({ plugin: { id: 'happier.machine.services', version: '0.0.0' },
                contribution: { id: 'systemd', qualifiedId: 'happier.machine.services/projectNativeAdapters/systemd' },
                occurrenceId: 'native-source', correlationId: 'native-source', surface: 'cli', signal: controller.signal, isOccurrenceCurrent: () => true,
            }, { executionKind: 'machine_native', filesystemRoots: { pluginData: root, projects: new Map() },
                hostAccessRequests: [{ required: true, request: { id: 'systemd-process', capability: 'process', reason: 'Native systemd boundary',
                    scope: { executables: [executable], envKeys: ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] } } }],
            }),
        };
        const lifecycle = systemdRuntime.nativeServiceLifecycle!;
        const instance = { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'user/worker.service' };
        try {
            expect(lifecycle.accounting).toBeUndefined();
            expect(await lifecycle.logs!(instance, { kind: 'read', maxBytes: 64 }))
                .toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
            const unsupportedWatch: unknown[] = [];
            const logsWatch = await lifecycle.logs!(instance, { kind: 'watch', maxBytes: 64,
                emit: value => { unsupportedWatch.push(value); } });
            expect(unsupportedWatch).toEqual([{ kind: 'unavailable', reason: 'admission_unavailable' }]);
            await logsWatch.dispose();
            await expect(readFile(calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await lifecycle.discover!({ serverId: 'home', machineId: 'machine' }, undefined, context)).toMatchObject({
                kind: 'ready', candidates: [{ instance, observation: { phase: 'running', readiness: 'not_reported' } },
                    { instance: { nativeResourceId: 'system/system-worker.service' } }], failures: [],
            });
            expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(2);
            const sourceClocks = { startedAt: 'Mon 2026-11-02 13:00:00 UTC', activeSince: 'Mon 2026-11-02 13:00:02 UTC' };
            const beforeFacts = (await readFile(calls, 'utf8')).trim().split('\n').length;
            for (const memory of [4096, 0]) {
                await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running', memory, ...sourceClocks }));
                expect(await lifecycle.inspect(instance, undefined, context)).toEqual({ phase: 'running', readiness: 'not_reported', endpoint: null, displayName: 'worker.service',
                    accounting: { memoryBytes: memory, startedAtMs: Date.parse(sourceClocks.startedAt) }, healthSince: Date.parse(sourceClocks.activeSince) });
            }
            // Accounting rides the existing inspection; it never adds native reads.
            expect((await readFile(calls, 'utf8')).trim().split('\n').length - beforeFacts).toBe(2);
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'inactive', sub: 'dead',
                memory: '18446744073709551615', ...sourceClocks }));
            expect(await lifecycle.inspect(instance, undefined, context)).toEqual({ phase: 'stopped', readiness: 'not_ready', endpoint: null, displayName: 'worker.service' });
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running',
                memory: 'invalid', startedAt: 'n/a', activeSince: 'n/a' }));
            expect(await lifecycle.inspect(instance, undefined, context)).toEqual({ phase: 'running', readiness: 'not_reported', endpoint: null, displayName: 'worker.service' });
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running', memory: 4096,
                startedAt: 'Mon 2026-11-02 13:00:00 CET', activeSince: 'Mon 2026-11-02 13:00:02 CET' }));
            expect(await lifecycle.inspect(instance, undefined, context)).toEqual({ phase: 'running', readiness: 'not_reported', endpoint: null, displayName: 'worker.service',
                accounting: { memoryBytes: 4096 } });
            for (const [load, active, sub, phase, readiness] of [
                ['loaded', 'inactive', 'dead', 'stopped', 'not_ready'], ['loaded', 'failed', 'failed', 'stopped', 'not_ready'],
                ['not-found', 'active', 'running', 'unknown', 'not_ready'], ['bad-setting', 'active', 'running', 'unknown', 'not_ready'],
                ['loaded', 'activating', 'start', 'unknown', 'not_ready'], ['loaded', 'active', 'exited', 'running', 'not_reported'],
            ]) {
                await writeFile(state, JSON.stringify({ load, active, sub }));
                expect(await lifecycle.inspect(instance, undefined, context)).toEqual({ phase, readiness, endpoint: null, displayName: 'worker.service' });
            }
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running', denySystem: true }));
            expect(await lifecycle.discover!({ serverId: 'home', machineId: 'machine' }, undefined, context)).toMatchObject({
                kind: 'partial', candidates: [{ instance }], failures: [{ kind: 'unavailable', code: 'systemd_system_discovery_unavailable' }],
            });
            expect(await lifecycle.stop(instance, undefined, context)).toEqual({ status: 'stopped' });
            expect(await lifecycle.start!(instance, undefined, context)).toMatchObject({ phase: 'running' });
            expect(await lifecycle.restart!(instance, undefined, context)).toMatchObject({ phase: 'running' });
            const callsBeforeRefusal = await readFile(calls, 'utf8');
            expect(await lifecycle.stop({ ...instance, nativeResourceId: 'system/system-worker.service' }, undefined, context)).toEqual({ status: 'unsupported' });
            await expect(lifecycle.stop({ ...instance, nativeResourceId: 'user/*.service' }, undefined, context)).rejects.toMatchObject({ code: 'systemd_invalid_native_resource' });
            expect(await readFile(calls, 'utf8')).toBe(callsBeforeRefusal);
            const effects = callsBeforeRefusal.trim().split('\n').map(line => JSON.parse(line) as { args: string[]; bus: string; runtime: string });
            expect(effects.every(value => value.bus === 'unix:path=/fixture/user-bus' && value.runtime === '/fixture/runtime')).toBe(true);
            expect(effects.filter(value => value.args.some(arg => ['stop', 'start', 'restart'].includes(arg))).map(value => value.args))
                .toEqual(['stop', 'start', 'restart'].map(verb => ['--user', '--no-ask-password', verb, '--', 'worker.service']));
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running', ignoreStop: true }));
            expect(await lifecycle.stop(instance, undefined, context)).toEqual({ status: 'termination_incomplete' });
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running', denyControl: true }));
            expect(await lifecycle.start!(instance, undefined, context)).toEqual({ kind: 'failed', code: 'systemd_start_unconfirmed' });

            // Canonical default/hard cap: runtime/exec/processSupervisor.ts:34,206.
            // Do not request a bigger buffer or mock Exec's truncation flag.
            const outputBudget = 8 * 1024 * 1024;
            const escapedUnit = 'worker@My\\x20Container\\x201.service';
            const safeUnits = [escapedUnit];
            const lines = [`${escapedUnit} loaded active running Native\n`];
            let bytes = Buffer.byteLength(lines[0]!);
            const partialRow = 'do-not-admit.service loaded active running';
            const retainedCompleteBytes = outputBudget - Buffer.byteLength(partialRow);
            while (bytes < retainedCompleteBytes - 512) {
                const unit = `worker-${safeUnits.length}-${'a'.repeat(128)}.service`;
                const line = `${unit} loaded active running ${'Native description '.repeat(12)}\n`;
                if (bytes + Buffer.byteLength(line) > retainedCompleteBytes) break;
                safeUnits.push(unit); lines.push(line); bytes += Buffer.byteLength(line);
            }
            const lastLine = lines.length - 1;
            lines[lastLine] = `${lines[lastLine]!.slice(0, -1)}${'x'.repeat(retainedCompleteBytes - bytes)}\n`;
            const listing = `${lines.join('')}${partialRow} omitted native description\n`;
            expect(Buffer.byteLength(listing)).toBeGreaterThan(outputBudget);
            const listingPath = join(root, 'native-listing');
            await writeFile(listingPath, listing);
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running', userListingPath: listingPath }));
            const callsBeforeScale = (await readFile(calls, 'utf8')).trim().split('\n').length;
            const scaled = await lifecycle.discover!({ serverId: 'home', machineId: 'machine' }, undefined, context);
            expect(scaled).toMatchObject({ kind: 'partial', failures: [{ kind: 'unavailable', code: 'systemd_user_discovery_truncated' }] });
            if (scaled.kind !== 'partial') throw new Error('Expected explicit native listing incompleteness');
            expect(scaled.candidates).toHaveLength(safeUnits.length + 1);
            const retainedIds = new Set(scaled.candidates.map(candidate => candidate.instance.nativeResourceId));
            expect(retainedIds.has(`user/${escapedUnit}`)).toBe(true);
            expect(retainedIds.has(`user/${safeUnits.at(-1)}`)).toBe(true);
            expect(retainedIds.has('user/do-not-admit.service')).toBe(false);
            expect(retainedIds.has('system/system-worker.service')).toBe(true);
            expect((await readFile(calls, 'utf8')).trim().split('\n').length - callsBeforeScale).toBe(2);
            // Truncation cannot turn a failed command's apparent rows into
            // authoritative inventory, even when complete lines were captured.
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running',
                userListingPath: listingPath, denyUserListing: true }));
            expect(await lifecycle.discover!({ serverId: 'home', machineId: 'machine' }, undefined, context))
                .toMatchObject({ kind: 'partial', candidates: [{ instance: { nativeResourceId: 'system/system-worker.service' } }],
                    failures: [{ kind: 'unavailable', code: 'systemd_user_discovery_unavailable' }] });
            await writeFile(state, JSON.stringify({ load: 'loaded', active: 'active', sub: 'running' }));
            const escapedInstance = { ...instance, nativeResourceId: `user/${escapedUnit}` };
            expect(await lifecycle.inspect(escapedInstance, undefined, context)).toMatchObject({ phase: 'running' });
            expect(await lifecycle.stop(escapedInstance, undefined, context)).toEqual({ status: 'stopped' });
            const escapedCalls = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
            expect(escapedCalls.at(-1)?.args).toContain(escapedUnit);
        } finally { controller.abort(); vi.unstubAllEnvs(); await owners.dispose(); await rm(root, { recursive: true, force: true }); }
    });
});
