import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { ensureCliPackSnapshotRuntimeDependencies } from '../process/cliDistSnapshotNodeModules';
import { resolveCliTestLaunchSpec } from '../process/cliLaunchSpec';
import { runLoggedCommand } from '../process/spawnProcess';

type CliUpdateSourceKind = 'published-channel' | 'published-tag' | 'local-build' | 'local-pack';

export type CliUpdateSource = Readonly<{
    kind: CliUpdateSourceKind;
    ref: string;
}>;

export type CliUpdateSourcePair = Readonly<{
    from: CliUpdateSource;
    to: CliUpdateSource;
}>;

const DEFAULT_LOCAL_BUILD_SOURCE: CliUpdateSource = { kind: 'local-build', ref: 'HEAD' };

const CLI_UPDATE_ENV_KEYS = [
    'HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_KIND',
    'HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_REF',
    'HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_KIND',
    'HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_REF',
] as const;

function npmCommand(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function normalizeCliUpdateSourceKind(raw: unknown): CliUpdateSourceKind | null {
    const value = String(raw ?? '').trim();
    if (
        value === 'published-channel'
        || value === 'published-tag'
        || value === 'local-build'
        || value === 'local-pack'
    ) {
        return value;
    }
    return null;
}

function normalizeCliUpdateChannel(raw: string): 'stable' | 'preview' | 'publicdev' {
    const value = raw.trim().toLowerCase();
    if (value === 'stable' || value === 'production' || value === 'latest') return 'stable';
    if (value === 'preview' || value === 'next') return 'preview';
    if (value === 'dev' || value === 'publicdev') return 'publicdev';
    throw new Error(`Unsupported cli-update published channel: ${raw}`);
}

function npmDistTagForChannel(channel: 'stable' | 'preview' | 'publicdev'): 'latest' | 'next' {
    return channel === 'stable' ? 'latest' : 'next';
}

function resolveCliUpdatePublishedTagNpmRef(tag: string): string {
    const value = tag.trim();
    if (value === 'cli-stable') return 'latest';
    if (value === 'cli-preview' || value === 'cli-dev') return 'next';
    const version = /^cli-v(.+)$/.exec(value)?.[1]?.trim();
    if (version) return version;
    throw new Error(`Unsupported cli-update published tag: ${tag}`);
}

function resolveRequiredSource(kind: unknown, ref: unknown): CliUpdateSource {
    const resolvedKind = normalizeCliUpdateSourceKind(kind);
    if (!resolvedKind) {
        throw new Error(`Unsupported cli-update source kind: ${String(kind ?? '').trim() || '<empty>'}`);
    }
    const resolvedRef = String(ref ?? '').trim();
    if (!resolvedRef) {
        throw new Error(`Missing cli-update source ref for ${resolvedKind}`);
    }
    return { kind: resolvedKind, ref: resolvedRef };
}

export function resolveCliUpdateSourcePairFromEnv(env: NodeJS.ProcessEnv): CliUpdateSourcePair {
    const values = CLI_UPDATE_ENV_KEYS.map((key) => String(env[key] ?? '').trim());
    if (values.every((value) => value.length === 0)) {
        return {
            from: DEFAULT_LOCAL_BUILD_SOURCE,
            to: DEFAULT_LOCAL_BUILD_SOURCE,
        };
    }
    if (values.some((value) => value.length === 0)) {
        throw new Error(`Expected complete cli-update source env (${CLI_UPDATE_ENV_KEYS.join(', ')})`);
    }
    return {
        from: resolveRequiredSource(values[0], values[1]),
        to: resolveRequiredSource(values[2], values[3]),
    };
}

export function resolveCliUpdateNpmPackageSpec(source: CliUpdateSource): string {
    if (source.kind === 'published-channel') {
        const channel = normalizeCliUpdateChannel(source.ref);
        return `@happier-dev/cli@${npmDistTagForChannel(channel)}`;
    }
    if (source.kind === 'published-tag') {
        return `@happier-dev/cli@${resolveCliUpdatePublishedTagNpmRef(source.ref)}`;
    }
    throw new Error(`cli-update source ${source.kind} does not resolve to an npm package spec`);
}

export function resolveCliUpdateValidationLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const next = { ...env };
    delete next.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
    delete next.HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
    return next;
}

function resolveLocalPackPath(sourceRef: string): string {
    return isAbsolute(sourceRef) ? sourceRef : resolve(repoRootDir(), sourceRef);
}

async function findNewestTarball(dir: string): Promise<string> {
    const entries = await readdir(dir);
    const candidates = await Promise.all(
        entries
            .filter((entry) => entry.endsWith('.tgz'))
            .map(async (entry) => {
                const abs = resolve(dir, entry);
                return { abs, mtimeMs: (await stat(abs)).mtimeMs };
            }),
    );
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = candidates[0]?.abs;
    if (!newest) {
        throw new Error(`Expected npm pack to produce a .tgz under ${dir}`);
    }
    return newest;
}

async function packPublishedCliSource(params: {
    testDir: string;
    role: 'from' | 'to';
    source: CliUpdateSource;
    env: NodeJS.ProcessEnv;
}): Promise<string> {
    const packDir = resolve(params.testDir, `cli-update-${params.role}-packs`);
    await rm(packDir, { recursive: true, force: true });
    await mkdir(packDir, { recursive: true });

    const packageSpec = resolveCliUpdateNpmPackageSpec(params.source);
    await runLoggedCommand({
        command: npmCommand(),
        args: ['pack', packageSpec, '--pack-destination', packDir, '--silent'],
        cwd: repoRootDir(),
        env: {
            ...params.env,
            npm_config_loglevel: 'silent',
        },
        stdoutPath: resolve(params.testDir, `cli-update.${params.role}.npm-pack.stdout.log`),
        stderrPath: resolve(params.testDir, `cli-update.${params.role}.npm-pack.stderr.log`),
        timeoutMs: 180_000,
    });

    return await findNewestTarball(packDir);
}

async function extractCliPackageTarball(params: {
    testDir: string;
    role: 'from' | 'to';
    source: CliUpdateSource;
    tarballPath: string;
    snapshotDir: string;
    env: NodeJS.ProcessEnv;
}): Promise<void> {
    const extractDir = resolve(params.testDir, `cli-update-${params.role}-extract`);
    await rm(extractDir, { recursive: true, force: true });
    await rm(params.snapshotDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    await mkdir(resolve(params.snapshotDir, '..'), { recursive: true });

    await runLoggedCommand({
        command: 'tar',
        args: ['-xzf', params.tarballPath, '-C', extractDir],
        cwd: repoRootDir(),
        env: params.env,
        stdoutPath: resolve(params.testDir, `cli-update.${params.role}.tar.stdout.log`),
        stderrPath: resolve(params.testDir, `cli-update.${params.role}.tar.stderr.log`),
        timeoutMs: 120_000,
    });

    const packageDir = resolve(extractDir, 'package');
    if (!existsSync(resolve(packageDir, 'dist', 'index.mjs'))) {
        throw new Error(`Extracted cli-update package is missing dist/index.mjs: ${packageDir}`);
    }
    try {
        await rename(packageDir, params.snapshotDir);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EXDEV') throw error;
        await cp(packageDir, params.snapshotDir, { recursive: true, force: true });
        await rm(packageDir, { recursive: true, force: true });
    }
    ensureCliPackSnapshotRuntimeDependencies({
        snapshotDir: params.snapshotDir,
        rootDir: repoRootDir(),
    });
    await writeFile(
        resolve(params.snapshotDir, '.cli-update-release-validation-source.json'),
        JSON.stringify({ source: params.source, tarballPath: params.tarballPath }, null, 2),
        'utf8',
    );
    if (existsSync(resolve(params.snapshotDir, 'node_modules'))) {
        await writeFile(
            resolve(params.snapshotDir, '.cli-dist-snapshot.ready.json'),
            JSON.stringify({ v: 1, source: 'cli-update-release-validation', role: params.role }, null, 2),
            'utf8',
        );
    }
}

async function prepareLocalBuildCliSourceSnapshot(params: {
    testDir: string;
    snapshotDir: string;
    env: NodeJS.ProcessEnv;
}): Promise<void> {
    await resolveCliTestLaunchSpec(
        {
            testDir: params.testDir,
            env: resolveCliUpdateValidationLaunchEnv({
                ...params.env,
                HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE:
                    params.env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? 'symlink',
            }),
        },
        {
            snapshotDir: params.snapshotDir,
            skipDistIntegrityCheck: true,
            skipSourceFreshnessCheck: true,
        },
    );
}

export async function prepareCliUpdateSourceSnapshot(params: {
    testDir: string;
    role: 'from' | 'to';
    source: CliUpdateSource;
    env: NodeJS.ProcessEnv;
}): Promise<string> {
    const snapshotDir = resolve(params.testDir, `cli-update-${params.role}`);
    if (params.source.kind === 'local-build') {
        await prepareLocalBuildCliSourceSnapshot({
            testDir: params.testDir,
            snapshotDir,
            env: params.env,
        });
        return snapshotDir;
    }

    const tarballPath =
        params.source.kind === 'local-pack'
            ? resolveLocalPackPath(params.source.ref)
            : await packPublishedCliSource(params);
    await extractCliPackageTarball({
        ...params,
        tarballPath,
        snapshotDir,
    });
    return snapshotDir;
}
