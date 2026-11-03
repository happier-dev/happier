import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeRuntime } from '../../../../../../../packages/plugins/machine-services/src/compose';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';

describe('installed Compose native source capture', () => {
    it('uses the retained engine/project and refuses member-only or inconsistent source coordinates', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-compose-source-'));
        const statePath = join(root, 'state.json');
        const boundary = join(root, 'docker.cjs');
        const ids = ['b'.repeat(64), 'a'.repeat(64)];
        const labels = { 'com.docker.compose.project': 'existing', 'com.docker.compose.service': 'web',
            'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': join(root, 'compose.yaml') };
        const state = { engine: 'engine', labels };
        await writeFile(statePath, JSON.stringify(state));
        await writeFile(boundary, `const fs=require('node:fs'),args=process.argv.slice(2),s=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8')),ids=${JSON.stringify(ids)};if(args[0]==='info')process.stdout.write(JSON.stringify({ID:s.engine}));else if(args[0]==='ps')process.stdout.write(ids.join('\\n'));else if(args[0]==='inspect')process.stdout.write(JSON.stringify(ids.map((Id,i)=>({Id,Config:{Labels:{...s.labels,...(s.inconsistent&&i?{'com.docker.compose.project.working_dir':'/other'}:{})}},State:{Status:'running'}}))));else process.exit(21);`);
        const lifetime = createPluginInvocationLifetime();
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => root, resolveExecutable: async () => ({ command: process.execPath, args: [boundary] }),
        } });
        const seed = { plugin: { id: 'happier.machine.services', version: '0.0.0' },
            contribution: { id: 'compose', qualifiedId: 'happier.machine.services/projectNativeAdapters/compose' },
            occurrenceId: 'source-capture', correlationId: 'source-capture', surface: 'cli' as const,
            signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal, isOccurrenceCurrent: () => true };
        const context = { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
            filesystemRoots: { pluginData: root, projects: new Map() }, hostAccessRequests: [],
        }) };
        const instance = { adapter: { pluginId: 'happier.machine.services', localId: 'compose' }, nativeResourceId: JSON.stringify(['engine', 'existing']) };
        const capture = composeRuntime.nativeServiceLifecycle!.composeSource!;
        try {
            expect(await capture(instance, undefined, context)).toEqual({ kind: 'ready', source: {
                projectName: 'existing', engineId: 'engine', workingDirectory: root,
                configFiles: [join(root, 'compose.yaml')], containerIds: [...ids].sort(),
            } });
            expect(await capture({ ...instance, nativeResourceId: JSON.stringify(['engine', 'existing', 'web']) }, undefined, context))
                .toMatchObject({ kind: 'unsupported' });
            await writeFile(statePath, JSON.stringify({ ...state, inconsistent: true }));
            expect(await capture(instance, undefined, context)).toMatchObject({ kind: 'unavailable' });
            await writeFile(statePath, JSON.stringify({ ...state, labels: { ...labels, 'com.docker.compose.project.config_files': '' } }));
            expect(await capture(instance, undefined, context)).toMatchObject({ kind: 'unavailable' });
            await writeFile(statePath, JSON.stringify({ ...state, engine: 'replacement' }));
            expect(await capture(instance, undefined, context)).toMatchObject({ kind: 'unavailable' });
        } finally { lifetime.complete(); await rm(root, { recursive: true, force: true }); }
    });
});
