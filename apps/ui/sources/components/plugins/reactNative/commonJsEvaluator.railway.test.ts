import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { compileUniversalPluginUiCommonJs } from '../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { railwayVendor } from '../../../../../../packages/plugins/machine-railway/testkit/vendor';
import * as entry from '../../../../../../packages/plugins/machine-railway/src/index';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { instantiatePluginUiCommonJsBundle } from './commonJsEvaluator';

describe('Railway portable Account artifact', () => {
    it('opens the platform WebSocket through the app evaluator and preserves private guest bytes', async () => {
        const repoRoot = resolve(import.meta.dirname, '../../../../../..');
        const packages = await readWorkspacePackages(repoRoot);
        const artifactId = 'account-runtime';
        const compiled = await compileUniversalPluginUiCommonJs({
            projectRoot: join(repoRoot, 'packages/plugins/machine-railway'), entryPath: 'src/manifest.ts', artifactId,
            requestedExports: ['activateAccount'], exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
        });
        const bridges = await Promise.all(compiled.externalSpecifiers.filter(s => s.startsWith('@happier-dev/plugin-sdk'))
            .map(specifier => loadVitestModuleForNodeRequire(pathToFileURL(createRequire(import.meta.url).resolve(specifier)),
                () => import(pathToFileURL(resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] })).href))));
        const vendor = railwayVendor();
        let kit: Awaited<ReturnType<typeof createPluginTestkit>> | undefined;
        try {
            const instance = instantiatePluginUiCommonJsBundle({ bytes: compiled.bytes,
                identity: { pluginId: entry.manifest.id, artifactId, digest: 'sha256:constructed-railway-source' }, requestedExport: 'activateAccount' });
            // The evaluator ABI returns an opaque callable; the artifact's authored public export supplies its signature.
            const activateAccount = instance.readExport('activateAccount') as typeof entry.PLUGIN.activateAccount;
            const requests: unknown[] = [];
            const http = createPluginHttpFixture({ async request(input, cancellation) {
                requests.push(input);
                const response = await vendor.request(input.url, { method: input.method, body: input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : new TextDecoder().decode(input.body), signal: cancellation?.signal });
                return { status: response.status, finalUrl: input.url, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
            } });
            kit = await createPluginTestkit({ manifest: entry.manifest, module: { activate: entry.activate,
                activateAccount(api, target) {
                    return target?.artifactId === artifactId ? activateAccount(api, target) : entry.PLUGIN.activateAccount(api, target);
                },
            }, services: { http } });
            const result = await kit.invokeAction('acquire', { launch: { environmentId: 'environment-one' }, managedId: 'portable-managed' }, { surface: 'plugin' });
            if (!isJsonObject(result) || result.kind !== 'bound' || !isJsonObject(result.resource)) throw new Error('Expected portable acquisition');
            const resource = result.resource.value;
            if (resource === undefined) throw new Error('Missing resource value');
            expect(await kit.invokeAction('bootstrap', { resource }, { surface: 'plugin' }))
                .toMatchObject({ kind: 'native', guestHome: { daemonStartup: 'native-process' } });
            const guestPath = join(vendor.home, 'portable-private');
            const bytesBase64 = 'AP9BQkM=';
            expect(await kit.invokeAction('put-file', { resource, guestPath, bytesBase64, mode: 0o600 }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
            expect(readFileSync(guestPath).toString('base64')).toBe(bytesBase64);
            expect(await kit.invokeAction('exec', { resource, argv: ['cat'], inputBase64: '77u/56eY5a+G' }, { surface: 'plugin' }))
                .toMatchObject({ stdoutBase64: '77u/56eY5a+G', stderrBase64: '', termination: { observed: { kind: 'exit', exitCode: 0 } } });
            expect(vendor.sockets.length).toBeGreaterThan(0);
            expect(vendor.sockets.every(socket => socket.closed)).toBe(true);
            expect(JSON.stringify(vendor.calls)).not.toContain('77u/56eY5a+G');
            expect(requests).toContainEqual(expect.objectContaining({ credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'cloud-api', origin: 'https://backboard.railway.com', method: 'POST', headerNames: ['authorization'] } }));
        } finally {
            await kit?.dispose(); vendor.cleanup();
            for (const bridge of bridges) bridge.dispose();
        }
    });
});
