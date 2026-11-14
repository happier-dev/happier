import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui/hostApiDefinition';

type SourceProjectionInput = Readonly<{
    manifest: PluginPortableReleaseManifestV1;
    artifact: PluginUiArtifactsManifestEntryV2;
    pluginRoot: string;
    executionOrigin: PluginMachineExecutionOriginV1;
    platform: 'web' | 'ios' | 'android';
}>;

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(filename, '../../../../../..');

/** Exercise the CLI source producer without sharing its @ alias with the UI host. */
export async function createSourcePluginProjection(input: SourceProjectionInput): Promise<PluginProjectionV2> {
    const child = spawn(process.execPath, [resolve(repoRoot, 'packages/tests/scripts/runTsxEntrypoint.mjs'), filename, '--produce'], {
        cwd: resolve(repoRoot, 'apps/cli'),
        env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=happier-source` },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.stdin.end(JSON.stringify(input));
    await new Promise<void>((accept, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? accept() : reject(new Error(`CLI projection producer exited ${code}: ${Buffer.concat(stderr).toString()}`)));
    });
    return PluginProjectionV2Schema.parse(JSON.parse(Buffer.concat(stdout).toString()));
}

if (process.argv[2] === '--produce' && process.argv[1] === filename) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as SourceProjectionInput;
    // These imports deliberately run in the existing CLI source runner, whose
    // tsconfig owns CLI aliases. Only the serialized projection crosses back.
    const source = (path: string) => import(pathToFileURL(resolve(repoRoot, 'apps/cli/src', path)).href);
    const [{ normalizePluginManifestV2 }, { projectLoadedPluginContributes }, { createResolvedContributionRegistry },
        { buildPluginProjectionV2 }, { createPluginRuntimeOccurrenceId }] = await Promise.all([
        source('plugins/manifest/normalize.ts'), source('plugins/projection/registry/fullProjection.ts'),
        source('plugins/projection/registry/createResolvedContributionRegistry.ts'),
        source('plugins/projection/registry/projection/v2.ts'), source('plugins/runtime/runtimeSlots.ts'),
    ]);
    const manifest = normalizePluginManifestV2(input.manifest);
    const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: { loadedPlugins: [{ pluginId: manifest.id, pluginRootPath: input.pluginRoot,
            manifestPath: resolve(input.pluginRoot, '.happier-plugin/plugin.json'), daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: input.pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                resolvedVersion: manifest.version, resolvedPath: input.pluginRoot,
                manifestPath: resolve(input.pluginRoot, '.happier-plugin/plugin.json') },
            manifest, generatedUiArtifactsManifest: { version: 2, entries: [input.artifact] },
        }], diagnosticsByPluginId: {} }, provenance: 'first_party',
    }));
    const projection = buildPluginProjectionV2({ registry: { ...registry,
        occurrenceIdsByPluginId: { [manifest.id]: createPluginRuntimeOccurrenceId(manifest.id) },
    }, generation: 1,
        pluginExecutionOriginsByPluginId: { [manifest.id]: input.executionOrigin },
        pluginUiHostRuntime: { reactNativeBundles: { featureEnabled: true,
            hostRuntime: { platform: input.platform, hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION_V1 } } },
    });
    process.stdout.write(JSON.stringify(projection));
}
