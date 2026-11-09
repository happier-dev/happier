import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol/installables';
import { getRuntimeInstallableAdapterForDescriptor } from '../registry';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';

const descriptor = InstallableDependencyDescriptorSchema.parse({
    id: 'dep.acme.language', key: 'dep.acme.language', kind: 'dep', version: '1', capabilityId: 'dep.acme.language',
    display: { name: 'External language server' }, description: 'Fixture language server',
    source: { kind: 'managed_package', packageName: '@acme/language', version: '1.2.3', packageManager: 'managed_js_runtime' },
    binary: { commands: ['language-server'], systemFirst: false, managedFallback: true },
    defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' },
    consent: { install: 'not_required', update: 'required' }, stability: { experimental: false, supported: true },
});

describe('managed JavaScript package executable', () => {
    it('runs the exact installed package entry with empty PATH, without a shell launcher or acquisition on read', async () => {
        await withTempDir('happier-managed-js-package-', async home => {
            const adapter = await getRuntimeInstallableAdapterForDescriptor(descriptor, { ownerId: 'acme.language' });
            const env = { HAPPIER_HOME_DIR: home, HAPPIER_JS_RUNTIME_PATH: process.execPath, PATH: '' };
            expect(await adapter.resolveLaunchCommand?.({ env })).toMatchObject({ ok: false });
            expect(await adapter.detectCapabilityStatus?.({ env })).toMatchObject({ installed: false, installedVersion: null });
            const packageRoot = join(home, 'tools', 'providers', descriptor.key, 'current', 'workspace', 'node_modules', '@acme', 'language');
            await mkdir(packageRoot, { recursive: true });
            await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@acme/language', version: '1.2.3', bin: { 'language-server': 'server.cjs' } }));
            // A real process/framing boundary. The entry is intentionally not executable.
            await writeFile(join(packageRoot, 'server.cjs'), `let input=Buffer.alloc(0);process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);for(;;){const end=input.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=Number(/Content-Length: (\\d+)/i.exec(input.subarray(0,end).toString())[1]);if(input.length<end+4+length)return;const request=JSON.parse(input.subarray(end+4,end+4+length));input=input.subarray(end+4+length);if(request.id===undefined)continue;const result=request.method==='initialize'?{capabilities:{hoverProvider:true}}:{contents:'managed package'};const body=JSON.stringify({jsonrpc:'2.0',id:request.id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);}});`);
            const launch = await adapter.resolveLaunchCommand?.({ env });
            expect(launch).toMatchObject({ ok: true, command: process.execPath, args: [await realpath(join(packageRoot, 'server.cjs'))] });
            // The capability service forwards this producer output unchanged to Machine Tools.
            expect(await adapter.detectCapabilityStatus?.({ env })).toMatchObject({
                installed: true, installedVersion: '1.2.3', version: '1.2.3', availableVersion: '1.2.3',
                sourceKind: 'managed_package',
            });
            if (!launch?.ok) throw new Error('Installed package must be launchable');
            const executable = { kind: 'managedDependency', id: 'server' } as const;
            const service = createStablePluginExecService({
                resolveExecutable: async () => launch, resolvePath: async () => home, environment: env,
                signal: new AbortController().signal, isOccurrenceCurrent: () => true });
            const client = await service.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength',
                launch: { executable, cwd: home } });
            try {
                expect(await client.client.request('initialize', {})).toMatchObject({ capabilities: { hoverProvider: true } });
            } finally { await client.dispose(); }
            await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@acme/language', version: '9.0.0', bin: { 'language-server': 'server.cjs' } }));
            expect(await adapter.resolveLaunchCommand?.({ env })).toMatchObject({ ok: false });
            expect(await adapter.detectCapabilityStatus?.({ env })).toMatchObject({ installed: false, installedVersion: null });
        });
    });
});
