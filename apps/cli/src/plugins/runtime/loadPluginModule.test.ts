import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PluginModuleNamespace } from './loadPluginModule';
import { loadPluginModule } from './loadPluginModule';

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

function createCommittedAuthorization(entryPath: string) {
    const distribution = {
        kind: 'localPath' as const,
        canonicalPath: entryPath,
    };
    return {
        pluginId: 'acme.fixture',
        immutableGenerationId: `generation:${entryPath}`,
        distribution,
        trust: {
            pluginId: 'acme.fixture',
            distribution,
            state: 'trusted' as const,
            approvedAtMs: 1,
        },
        admittedIntegrity: 'sha256:fixture',
        packageDigest: 'sha256:fixture',
        isCurrent: async () => true,
    };
}

describe('loadPluginModule', () => {
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

    it('loads a trusted file-backed daemon entry and caches repeated loads by entry path + fingerprint', async () => {
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
            admittedIntegrity: 'sha256:package',
            packageDigest: 'sha256:package',
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
        await writeFile(dependencyPath, 'export const version: string = "generation-two";\n', 'utf8');
        const second = await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath,
                devEntryPath,
                useDevelopmentEntry: true,
                committedAuthorization: createCommittedAuthorization(entryPath),
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
            const second = await loadPluginModule({
                source: {
                    kind: 'file_backed',
                    entryPath,
                    devEntryPath,
                    useDevelopmentEntry: true,
                    committedAuthorization: createCommittedAuthorization(entryPath),
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
            admittedIntegrity: 'sha256:package',
            packageDigest: 'sha256:package',
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
            admittedIntegrity: 'sha256:package',
            packageDigest: 'sha256:package',
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

    it('invalidates cached file-backed daemon modules when the on-disk fingerprint changes', async () => {
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
        expect((second as { version?: number }).version).toBe(2);
        expect(second).not.toBe(first);
    });

    it('invalidates cached file-backed daemon modules even when size and mtime are preserved (archive reinstall)', async () => {
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
            source: { kind: 'file_backed', entryPath, committedAuthorization: createCommittedAuthorization(entryPath) },
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
