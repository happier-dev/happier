import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { PluginModuleNamespace } from './loadPluginModule';
import {
    loadPluginModule,
    resolveNativePluginModuleUrl,
    resolvePluginModuleCandidatePaths,
    resolvePluginModuleLoadMode,
} from './loadPluginModule';

const execFileAsync = promisify(execFile);

const remoteDistribution = {
    kind: 'archive' as const,
    source: { kind: 'remoteUrl' as const, canonicalUrl: 'https://example.test/acme.tgz' },
    integrity: `sha256-${Buffer.alloc(32, 1).toString('base64')}`,
};

async function writeDaemonModule(params: Readonly<{ extension: string; contents: string }>): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-module-'));
    const daemonEntryPath = join(rootDir, `daemon.${params.extension}`);
    await writeFile(daemonEntryPath, params.contents, 'utf8');
    return daemonEntryPath;
}

function createCommittedAuthorization(
    entryPath: string,
    immutableGenerationId = `generation:${entryPath}`,
) {
    const distribution = {
        kind: 'localPath' as const,
        canonicalPath: entryPath,
    };
    return {
        pluginId: 'acme.fixture',
        immutableGenerationId,
        distribution,
        trust: {
            pluginId: 'acme.fixture',
            distribution,
            state: 'trusted' as const,
            approvedAtMs: 1,
        },
        isCurrent: async () => true,
    };
}

describe('loadPluginModule', () => {
    it('uses canonical native ESM identity for JavaScript development leaves and a scoped Jiti graph only for TypeScript', () => {
        expect(resolvePluginModuleLoadMode({
            entryPath: '/plugins/acme/src/factory.mjs',
            useDevelopmentEntry: true,
        })).toBe('immutable-js');
        expect(resolvePluginModuleLoadMode({
            entryPath: '/plugins/acme/src/factory.ts',
            useDevelopmentEntry: true,
        })).toBe('source-ts');
        expect(resolvePluginModuleLoadMode({
            entryPath: '/plugins/acme/generations/g1/factory.mjs',
            useDevelopmentEntry: false,
        })).toBe('immutable-js');
    });

    it('maps NodeNext JavaScript specifiers to their TypeScript authoring leaves only in source mode', () => {
        expect(resolvePluginModuleCandidatePaths({
            candidateBase: '/plugins/acme/src/agent/runtime.js',
            loadMode: 'source-ts',
        })).toEqual([
            '/plugins/acme/src/agent/runtime.js',
            '/plugins/acme/src/agent/runtime.ts',
        ]);
        expect(resolvePluginModuleCandidatePaths({
            candidateBase: '/plugins/acme/src/agent/runtime.js',
            loadMode: 'immutable-js',
        })).toEqual(['/plugins/acme/src/agent/runtime.js']);
    });

    it('does not treat local source provenance as executable authorization', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = "must-not-load";\n',
        });

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        })).rejects.toMatchObject({
            code: 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
        });
    });

    it('loads a trusted file-backed daemon entry and caches repeated loads by opaque generation identity', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export async function resolveTranscriptBinding() { return "loaded"; }\n',
        });

        const first = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
        });
        const second = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
        });

        expect(typeof (first as PluginModuleNamespace).resolveTranscriptBinding).toBe('function');
        expect(second).toBe(first);
    });

    it('does not treat acquisition integrity as executable authorization', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = "direct-custody";\n',
        });
        const authorization = {
            ...createCommittedAuthorization(entryPath),
            admittedIntegrity: 'sha256:stale-source-copy',
        };

        await expect(loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                committedAuthorization: authorization,
            },
        })).resolves.toMatchObject({ version: 'direct-custody' });
    });

    it('preserves strict factory identity for a committed external ESM activation entry and its distinct runner leaf', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-committed-esm-factory-'));
        const entryPath = join(rootDir, 'daemon.mjs');
        const factoryPath = join(rootDir, 'factory.mjs');
        const pluginId = 'acme.committed-esm-factory';
        const authorization = Object.freeze({
            pluginId,
            immutableGenerationId: 'generation-committed-esm-factory',
            distribution: remoteDistribution,
            trust: {
                pluginId,
                distribution: remoteDistribution,
                state: 'trusted' as const,
                approvedAtMs: 1,
            },
            isCurrent: async () => true,
        });
        await writeFile(
            factoryPath,
            'export const factory = () => ({ sessions: { open() { throw new Error("unused"); } } });\n',
            'utf8',
        );
        await writeFile(
            entryPath,
            [
                'import { factory } from "./factory.mjs";',
                'export { factory as registeredFactory };',
                'export function activate(api) {',
                '  api.agents.register("runner", factory, {',
                '    sessionRunnerFactory: {',
                '      module: "./factory.mjs",',
                '      export: "factory",',
                '      runtimeApiVersion: 1',
                '    }',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        try {
            const entryModule = await loadPluginModule({
                source: {
                    kind: 'file_backed',
                    entryPath,
                    committedAuthorization: authorization,
                },
                cacheKey: 'committed-esm-entry',
            });
            const leafModule = await loadPluginModule({
                source: {
                    kind: 'file_backed',
                    entryPath: factoryPath,
                    committedAuthorization: authorization,
                },
                cacheKey: 'committed-esm-runner-leaf',
                nativeFileUrlMode: 'canonical',
            });

            expect(entryModule.activate).toEqual(expect.any(Function));
            expect(leafModule.factory).toBe(entryModule.registeredFactory);
            await execFileAsync(process.execPath, [
                '--input-type=module',
                '-e',
                [
                    'import assert from "node:assert/strict";',
                    'const [entryUrl, leafUrl] = process.argv.slice(1);',
                    'const entry = await import(entryUrl);',
                    'const leaf = await import(leafUrl);',
                    'assert.strictEqual(leaf.factory, entry.registeredFactory);',
                ].join('\n'),
                resolveNativePluginModuleUrl({
                    resolvedEntryPath: entryPath,
                    cacheKey: 'committed-esm-entry',
                    mode: 'generation-keyed',
                }),
                resolveNativePluginModuleUrl({
                    resolvedEntryPath: factoryPath,
                    cacheKey: 'committed-esm-runner-leaf',
                    mode: 'canonical',
                }),
            ]);
        } finally {
            await rm(rootDir, { recursive: true, force: true });
        }
    });

    it('fails clearly when a file-backed daemon entry path does not exist', async () => {
        const missingRootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-missing-'));
        const entryPath = join(missingRootDir, 'missing.mjs');

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
        })).rejects.toThrow(/daemon entry does not exist/i);
    });

    it('rejects unsupported file-backed daemon entry extensions', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'ts',
            contents: 'export function resolveTranscriptBinding() { return "nope"; }\n',
        });

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
        })).rejects.toThrow(/Unsupported .* daemon entry extension/i);
    });

    it('rejects TSX development modules because daemon executable leaves are non-UI source', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-tsx-'));
        const entryPath = join(rootDir, 'dist', 'daemon.mjs');
        const devEntryPath = join(rootDir, 'src', 'daemon.tsx');
        await mkdir(join(rootDir, 'dist'), { recursive: true });
        await mkdir(join(rootDir, 'src'), { recursive: true });
        await writeFile(entryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(devEntryPath, 'export const version: string = "tsx-dev";\n', 'utf8');

        await expect(loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                devEntryPath,
                useDevelopmentEntry: true,
                committedAuthorization: createCommittedAuthorization(entryPath),
            },
        })).rejects.toMatchObject({
            code: 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
        });
    });

    it('loads an explicitly selected committed TypeScript development entry instead of the compiled daemon entry', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-module-'));
        const entryPath = join(rootDir, 'dist', 'daemon.mjs');
        const devEntryPath = join(rootDir, 'src', 'daemon.ts');
        await mkdir(join(rootDir, 'dist'), { recursive: true });
        await mkdir(join(rootDir, 'src'), { recursive: true });
        await writeFile(entryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(
            devEntryPath,
            [
                'const version: string = "typescript-dev";',
                'export { version };',
                '',
            ].join('\n'),
            'utf8',
        );

        const module = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                devEntryPath,
                useDevelopmentEntry: true,
                committedAuthorization: createCommittedAuthorization(entryPath),
            },
        });

        expect((module as { version?: string }).version).toBe('typescript-dev');
    });

    it('loads an explicitly selected development entry using committed reviewed trust', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-reviewed-dev-module-'));
        const entryPath = join(rootDir, 'dist', 'daemon.mjs');
        const devEntryPath = join(rootDir, 'src', 'daemon.ts');
        await mkdir(join(rootDir, 'dist'), { recursive: true });
        await mkdir(join(rootDir, 'src'), { recursive: true });
        await writeFile(entryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(devEntryPath, 'export const version: string = "reviewed-typescript-dev";\n', 'utf8');
        const authorization = {
            pluginId: 'acme.reviewed-dev',
            immutableGenerationId: 'generation-reviewed-dev',
            distribution: remoteDistribution,
            trust: {
                pluginId: 'acme.reviewed-dev',
                distribution: remoteDistribution,
                state: 'trusted' as const,
                approvedAtMs: 1,
            },
            isCurrent: async () => true,
        };

        const module = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                devEntryPath,
                useDevelopmentEntry: true,
                trustPolicy: 'prompt',
                committedAuthorization: authorization,
            },
        });

        expect((module as { version?: string }).version).toBe('reviewed-typescript-dev');
    });

    it('rebuilds the TypeScript dependency graph for each development generation', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-graph-'));
        const entryPath = join(rootDir, 'dist', 'daemon.mjs');
        const devEntryPath = join(rootDir, 'src', 'daemon.ts');
        const dependencyPath = join(rootDir, 'src', 'value.ts');
        await mkdir(join(rootDir, 'dist'), { recursive: true });
        await mkdir(join(rootDir, 'src'), { recursive: true });
        await writeFile(entryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(devEntryPath, 'export { version } from "./value";\n', 'utf8');
        await writeFile(dependencyPath, 'export const version: string = "generation-one";\n', 'utf8');

        const first = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                devEntryPath,
                useDevelopmentEntry: true,
                committedAuthorization: createCommittedAuthorization(entryPath),
            },
            cacheKey: 'development-generation-1',
        });
        const secondRootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-graph-2-'));
        const secondEntryPath = join(secondRootDir, 'dist', 'daemon.mjs');
        const secondDevEntryPath = join(secondRootDir, 'src', 'daemon.ts');
        await mkdir(join(secondRootDir, 'dist'), { recursive: true });
        await mkdir(join(secondRootDir, 'src'), { recursive: true });
        await writeFile(secondEntryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(secondDevEntryPath, 'export { version } from "./value";\n', 'utf8');
        await writeFile(join(secondRootDir, 'src', 'value.ts'), 'export const version: string = "generation-two";\n', 'utf8');
        const second = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath: secondEntryPath,
                devEntryPath: secondDevEntryPath,
                useDevelopmentEntry: true,
                committedAuthorization: createCommittedAuthorization(secondEntryPath),
            },
            cacheKey: 'development-generation-2',
        });

        expect((first as { version?: string }).version).toBe('generation-one');
        expect((second as { version?: string }).version).toBe('generation-two');
        expect(second).not.toBe(first);
    });

    it('shares one TypeScript module instance inside a generation and rebuilds it once for the replacement', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-diamond-'));
        const entryPath = join(rootDir, 'dist', 'daemon.mjs');
        const sourceRoot = join(rootDir, 'src');
        const devEntryPath = join(sourceRoot, 'daemon.ts');
        const sharedPath = join(sourceRoot, 'shared.ts');
        const counterKey = `__happier_plugin_diamond_${rootDir.replace(/[^a-z0-9]/giu, '_')}`;
        const counters = globalThis as typeof globalThis & Record<string, number | undefined>;
        await mkdir(join(rootDir, 'dist'), { recursive: true });
        await mkdir(sourceRoot, { recursive: true });
        await writeFile(entryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(
            sharedPath,
            [
                `const counterKey = ${JSON.stringify(counterKey)};`,
                'const counters = globalThis as typeof globalThis & Record<string, number | undefined>;',
                'counters[counterKey] = (counters[counterKey] ?? 0) + 1;',
                'export const loadCount = counters[counterKey];',
                '',
            ].join('\n'),
            'utf8',
        );
        await writeFile(
            join(sourceRoot, 'left.ts'),
            'export { loadCount as leftLoadCount } from "./shared";\n',
            'utf8',
        );
        await writeFile(
            join(sourceRoot, 'right.ts'),
            'export { loadCount as rightLoadCount } from "./shared";\n',
            'utf8',
        );
        await writeFile(
            devEntryPath,
            [
                'export { leftLoadCount } from "./left";',
                'export { rightLoadCount } from "./right";',
                '',
            ].join('\n'),
            'utf8',
        );

        try {
            const first = await loadPluginModule({
                source: {
                    kind: 'file_backed',
                    entryPath,
                    devEntryPath,
                    useDevelopmentEntry: true,
                    committedAuthorization: createCommittedAuthorization(entryPath),
                },
                cacheKey: 'diamond-generation-1',
            });
            const secondRootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-diamond-2-'));
            const secondEntryPath = join(secondRootDir, 'dist', 'daemon.mjs');
            const secondSourceRoot = join(secondRootDir, 'src');
            const secondDevEntryPath = join(secondSourceRoot, 'daemon.ts');
            await mkdir(join(secondRootDir, 'dist'), { recursive: true });
            await mkdir(secondSourceRoot, { recursive: true });
            await writeFile(secondEntryPath, 'export const version = "compiled-main";\n', 'utf8');
            await writeFile(join(secondSourceRoot, 'shared.ts'), [
                `const counterKey = ${JSON.stringify(counterKey)};`,
                'const counters = globalThis as typeof globalThis & Record<string, number | undefined>;',
                'counters[counterKey] = (counters[counterKey] ?? 0) + 1;',
                'export const loadCount = counters[counterKey];',
                '',
            ].join('\n'), 'utf8');
            await writeFile(join(secondSourceRoot, 'left.ts'), 'export { loadCount as leftLoadCount } from "./shared";\n', 'utf8');
            await writeFile(join(secondSourceRoot, 'right.ts'), 'export { loadCount as rightLoadCount } from "./shared";\n', 'utf8');
            await writeFile(secondDevEntryPath, [
                'export { leftLoadCount } from "./left";',
                'export { rightLoadCount } from "./right";',
                '',
            ].join('\n'), 'utf8');
            const second = await loadPluginModule({
                source: {
                    kind: 'file_backed',
                    entryPath: secondEntryPath,
                    devEntryPath: secondDevEntryPath,
                    useDevelopmentEntry: true,
                    committedAuthorization: createCommittedAuthorization(secondEntryPath),
                },
                cacheKey: 'diamond-generation-2',
            });

            expect(first).toMatchObject({ leftLoadCount: 1, rightLoadCount: 1 });
            expect(second).toMatchObject({ leftLoadCount: 2, rightLoadCount: 2 });
            expect(second).not.toBe(first);
            expect(counters[counterKey]).toBe(2);
        } finally {
            delete counters[counterKey];
        }
    });

    it('keeps a TypeScript development entry and locator leaf in the same authorization-scoped graph', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-factory-'));
        const entryPath = join(rootDir, 'dist', 'daemon.mjs');
        const sourceRoot = join(rootDir, 'src');
        const devEntryPath = join(sourceRoot, 'daemon.ts');
        const factoryPath = join(sourceRoot, 'factory.ts');
        await mkdir(join(rootDir, 'dist'), { recursive: true });
        await mkdir(sourceRoot, { recursive: true });
        await writeFile(entryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(factoryPath, 'export const factory = () => ({ generation: Symbol() });\n', 'utf8');
        await writeFile(
            devEntryPath,
            'export { factory as registeredFactory } from "./factory";\n',
            'utf8',
        );

        const firstAuthorization = createCommittedAuthorization(entryPath);
        const firstEntry = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                devEntryPath,
                useDevelopmentEntry: true,
                committedAuthorization: firstAuthorization,
            },
            cacheKey: 'factory-entry-generation-1',
        });
        const firstLeaf = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath: factoryPath,
                devEntryPath: factoryPath,
                useDevelopmentEntry: true,
                committedAuthorization: firstAuthorization,
            },
            cacheKey: 'factory-leaf',
        });
        expect(firstLeaf.factory).toBe(firstEntry.registeredFactory);

        const secondRootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-factory-2-'));
        const secondEntryPath = join(secondRootDir, 'dist', 'daemon.mjs');
        const secondSourceRoot = join(secondRootDir, 'src');
        const secondDevEntryPath = join(secondSourceRoot, 'daemon.ts');
        const secondFactoryPath = join(secondSourceRoot, 'factory.ts');
        await mkdir(join(secondRootDir, 'dist'), { recursive: true });
        await mkdir(secondSourceRoot, { recursive: true });
        await writeFile(secondEntryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(secondFactoryPath, 'export const factory = () => ({ generation: Symbol() });\n', 'utf8');
        await writeFile(secondDevEntryPath, 'export { factory as registeredFactory } from "./factory";\n', 'utf8');
        const secondAuthorization = createCommittedAuthorization(secondEntryPath);
        const secondEntry = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath: secondEntryPath,
                devEntryPath: secondDevEntryPath,
                useDevelopmentEntry: true,
                committedAuthorization: secondAuthorization,
            },
            cacheKey: 'factory-entry-generation-2',
        });
        const secondLeaf = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath: secondFactoryPath,
                devEntryPath: secondFactoryPath,
                useDevelopmentEntry: true,
                committedAuthorization: secondAuthorization,
            },
            cacheKey: 'factory-leaf',
        });

        expect(secondLeaf.factory).toBe(secondEntry.registeredFactory);
        expect(secondEntry.registeredFactory).not.toBe(firstEntry.registeredFactory);
    });

    it('does not load a TypeScript dev entry unless the file-backed source is locally trusted', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-dev-untrusted-'));
        const entryPath = join(rootDir, 'dist', 'daemon.mjs');
        const devEntryPath = join(rootDir, 'src', 'daemon.ts');
        await mkdir(join(rootDir, 'dist'), { recursive: true });
        await mkdir(join(rootDir, 'src'), { recursive: true });
        await writeFile(entryPath, 'export const version = "compiled-main";\n', 'utf8');
        await writeFile(devEntryPath, 'export const version: string = "typescript-dev";\n', 'utf8');

        await expect(loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                devEntryPath,
                trustPolicy: 'prompt',
            },
        })).rejects.toThrow(/requires a reviewed, committed, current/i);
    });

    it('loads an approved prompt-provenance remote generation and rejects substituted or stale authority', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = "approved-remote";\n',
        });
        const authorization = {
            pluginId: 'acme.remote',
            immutableGenerationId: 'generation-remote',
            distribution: remoteDistribution,
            trust: { pluginId: 'acme.remote', distribution: remoteDistribution, state: 'trusted' as const, approvedAtMs: 1 },
            isCurrent: async () => true,
        };

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'prompt', committedAuthorization: authorization },
        })).resolves.toMatchObject({ version: 'approved-remote' });

        await expect(loadPluginModule({
            source: {
                kind: 'file_backed', entryPath, trustPolicy: 'prompt',
                committedAuthorization: {
                    ...authorization,
                    distribution: {
                        ...remoteDistribution,
                        source: { kind: 'remoteUrl', canonicalUrl: 'https://example.test/substituted.tgz' },
                    },
                },
            },
        })).rejects.toThrow(/trust|approval|authoriz/i);
        await expect(loadPluginModule({
            source: {
                kind: 'file_backed', entryPath, trustPolicy: 'prompt',
                committedAuthorization: { ...authorization, isCurrent: async () => false },
            },
        })).rejects.toThrow(/stale|current/i);
    });

    it('does not let local source provenance bypass committed generation currentness', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = "stale-local";\n',
        });
        const authorization = {
            pluginId: 'acme.local',
            immutableGenerationId: 'generation-local-stale',
            distribution: {
                kind: 'localPath' as const,
                canonicalPath: '/plugins/acme.local',
            },
            trust: {
                pluginId: 'acme.local',
                distribution: {
                    kind: 'localPath' as const,
                    canonicalPath: '/plugins/acme.local',
                },
                state: 'trusted' as const,
                approvedAtMs: 1,
            },
            isCurrent: async () => false,
        };

        await expect(loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                trustPolicy: 'local_trusted',
                committedAuthorization: authorization,
            },
        })).rejects.toThrow(/stale|current/i);
    });

    it('fails closed when file-backed executable trust metadata is missing', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath },
        })).rejects.toThrow(/requires a reviewed, committed, current/i);
    });

    it('does not derive a second runtime identity from mutations within an admitted generation', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        const first = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
        });
        expect((first as { version?: number }).version).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(entryPath, 'export const version = 2;\n', 'utf8');

        const second = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
        });
        expect((second as { version?: number }).version).toBe(1);
        expect(second).toBe(first);
    });

    it('loads replacement bytes only under a fresh opaque generation even when size and mtime are preserved', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        const first = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
        });
        expect((first as { version?: number }).version).toBe(1);

        const before = await stat(entryPath);
        const preservedMtime = before.mtime;
        const preservedAtime = before.atime;

        await writeFile(entryPath, 'export const version = 2;\n', 'utf8');
        await utimes(entryPath, preservedAtime, preservedMtime);

        const second = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                committedAuthorization: createCommittedAuthorization(
                    entryPath,
                    `replacement:${entryPath}`,
                ),
            },
        });
        expect((second as { version?: number }).version).toBe(2);
        expect(second).not.toBe(first);
    });

    it('loads a bundled activation source via the provided loader and caches by moduleId + cacheKey', async () => {
        let loads = 0;
        const source = {
            kind: 'bundled' as const,
            moduleId: '@happier-dev/plugins-acme/daemon:test-cache-1',
            load: async () => {
                loads += 1;
                return { version: 1 } as unknown as PluginModuleNamespace;
            },
        };

        const first = await loadPluginModule({ source, cacheKey: 'gen:1' });
        const second = await loadPluginModule({ source, cacheKey: 'gen:1' });

        expect(first).toBe(second);
        expect(loads).toBe(1);
    });

    it('invalidates bundled module caches when cacheKey changes', async () => {
        let loads = 0;
        const source = {
            kind: 'bundled' as const,
            moduleId: '@happier-dev/plugins-acme/daemon:test-cache-2',
            load: async () => {
                loads += 1;
                return { version: loads } as unknown as PluginModuleNamespace;
            },
        };

        const first = await loadPluginModule({ source, cacheKey: 'gen:1' });
        const second = await loadPluginModule({ source, cacheKey: 'gen:2' });

        expect((first as { version?: number }).version).toBe(1);
        expect((second as { version?: number }).version).toBe(2);
        expect(second).not.toBe(first);
        expect(loads).toBe(2);
    });
});
