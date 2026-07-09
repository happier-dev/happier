import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

type PluginStateFile = Readonly<{
    t: 'happier_plugin_state_v1';
    schemaVersion: 1;
    plugins: Record<string, unknown>;
}>;

async function readStateFile(path: string): Promise<PluginStateFile> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as PluginStateFile;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {},
            };
        }
        throw error;
    }
}

export async function writeEnabledPluginSdkV1State(params: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    pluginId: string;
    manifestVersion?: string;
    devWatch?: boolean;
}>): Promise<void> {
    const rootDir = join(params.happyHomeDir, 'plugins', 'plugins');
    const stateDir = join(rootDir, 'state');
    const stateFilePath = join(stateDir, 'plugin-state.v1.json');
    const manifestPath = join(params.pluginRoot, '.happier-plugin', 'plugin.json');

    await Promise.all([
        mkdir(stateDir, { recursive: true }),
        mkdir(join(rootDir, 'installed'), { recursive: true }),
        mkdir(join(rootDir, 'cache'), { recursive: true }),
        mkdir(join(rootDir, 'logs'), { recursive: true }),
        mkdir(join(rootDir, 'locks'), { recursive: true }),
        mkdir(join(rootDir, 'storage'), { recursive: true }),
        mkdir(join(rootDir, 'secrets'), { recursive: true }),
        mkdir(join(rootDir, 'settings'), { recursive: true }),
    ]);

    const current = await readStateFile(stateFilePath);
    await writeFile(
        stateFilePath,
        JSON.stringify(
            {
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {
                    ...current.plugins,
                    [params.pluginId]: {
                        source: {
                            kind: 'path',
                            locator: params.pluginRoot,
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                            resolvedPath: params.pluginRoot,
                            manifestPath,
                            ...(params.devWatch !== undefined ? { devWatch: params.devWatch } : {}),
                        },
                        compatibility: {
                            status: 'unknown',
                            diagnostics: [],
                        },
                        install: {
                            mode: 'link',
                            manifestVersion: params.manifestVersion ?? '1.0.0',
                            manifestDigest: null,
                            installedPath: null,
                        },
                        state: {
                            enabled: true,
                        },
                    },
                },
            },
            null,
            2,
        ),
        'utf8',
    );
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
