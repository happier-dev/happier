import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { seedCurrentLocalPathPluginFixture } from '../../../../../apps/cli/src/plugins/store/registry/currentState.testkit';

type PluginSdkV1ContributionMap = Readonly<Record<string, unknown>>;

export type PluginSdkV1Manifest = Readonly<{
    schemaVersion: 2;
    id: string;
    version: string;
    displayName: string;
    description: string;
    engines: Readonly<{ happier: string }>;
    uses: readonly string[];
    entrypoints: Readonly<{
        main: string;
        dev?: string;
    }>;
    declares: Readonly<{
        capabilities: readonly unknown[];
    }>;
    permissions: Readonly<{
        required: readonly Readonly<{
            capability: string;
            reason?: string;
        }>[];
        optional: readonly Readonly<{
            capability: string;
            reason?: string;
        }>[];
    }>;
    activationEvents: readonly string[];
    contributes: PluginSdkV1ContributionMap;
}>;

export function createPluginSdkV1Manifest(params: Readonly<{
    pluginId: string;
    version?: string;
    displayName?: string;
    description?: string;
    uses?: readonly string[];
    permissions?: readonly string[];
    activationEvents?: readonly string[];
    entrypoints?: Readonly<{
        main?: string;
        dev?: string;
    }>;
    contributes?: PluginSdkV1ContributionMap;
}>): PluginSdkV1Manifest {
    return {
        schemaVersion: 2,
        id: params.pluginId,
        version: params.version ?? '1.0.0',
        displayName: params.displayName ?? params.pluginId,
        description: params.description ?? `Plugin SDK v1 fixture for ${params.pluginId}`,
        engines: {
            happier: '^0.2.0',
        },
        uses: Object.freeze([...(params.uses ?? [])]),
        entrypoints: {
            main: params.entrypoints?.main ?? './daemon.mjs',
            ...(params.entrypoints?.dev ? { dev: params.entrypoints.dev } : {}),
        },
        declares: {
            capabilities: [],
        },
        permissions: {
            required: Object.freeze((params.permissions ?? []).map((capability) => ({
                capability,
                reason: `Fixture requires ${capability}.`,
            }))),
            optional: [],
        },
        activationEvents: Object.freeze([...(params.activationEvents ?? ['startup'])]),
        contributes: params.contributes ?? {},
    };
}

async function writeEntrypoint(params: Readonly<{
    pluginRoot: string;
    entrypoint: string;
    contents: string;
}>): Promise<void> {
    const entrypointPath = join(params.pluginRoot, params.entrypoint);
    await mkdir(dirname(entrypointPath), { recursive: true });
    await writeFile(entrypointPath, params.contents, 'utf8');
}

export async function writePluginSdkV1Fixture(params: Readonly<{
    pluginRoot: string;
    manifest: PluginSdkV1Manifest;
    daemonModuleContents: string;
    devModuleContents?: string;
}>): Promise<void> {
    const manifestDir = join(params.pluginRoot, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(params.manifest, null, 2),
        'utf8',
    );
    await writeEntrypoint({
        pluginRoot: params.pluginRoot,
        entrypoint: params.manifest.entrypoints.main,
        contents: params.daemonModuleContents,
    });
    if (params.devModuleContents && params.manifest.entrypoints.dev) {
        await writeEntrypoint({
            pluginRoot: params.pluginRoot,
            entrypoint: params.manifest.entrypoints.dev,
            contents: params.devModuleContents,
        });
    }
}

export async function writeEnabledPluginSdkV1State(params: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    pluginId: string;
    manifestVersion?: string;
    devWatch?: boolean;
}>): Promise<void> {
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir: params.happyHomeDir,
        pluginRoot: params.pluginRoot,
        pluginId: params.pluginId,
        manifestVersion: params.manifestVersion ?? '1.0.0',
        ...(params.devWatch === undefined ? {} : { devWatch: params.devWatch }),
    });
}

export function createReloadablePluginSdkV1DaemonModule(params: Readonly<{
    actionId: string;
    generation: string;
    activationLogPath: string;
    disposalLogPath: string;
}>): string {
    return [
        'import { appendFile } from "node:fs/promises";',
        '',
        `const activationLogPath = ${JSON.stringify(params.activationLogPath)};`,
        `const disposalLogPath = ${JSON.stringify(params.disposalLogPath)};`,
        '',
        'export async function activate(host) {',
        `  await appendFile(activationLogPath, ${JSON.stringify(`activate:${params.generation}\n`)}, "utf8");`,
        '  host.registerAction({',
        `    id: ${JSON.stringify(params.actionId)},`,
        `    handler: async () => ({ ok: true, data: { generation: ${JSON.stringify(params.generation)} } }),`,
        '  });',
        '  host.onDispose(async () => {',
        `    await appendFile(disposalLogPath, ${JSON.stringify(`dispose:${params.generation}\n`)}, "utf8");`,
        '  });',
        '}',
        '',
    ].join('\n');
}
