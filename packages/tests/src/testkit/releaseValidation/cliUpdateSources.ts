import { existsSync } from 'node:fs';
import { cp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
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

function resolveCliUpdatePublishedTag(tag: string): Readonly<{
    tag: string;
    releaseChannel: 'stable' | 'preview' | 'publicdev';
    version: string | null;
}> {
    const value = tag.trim();
    if (value === 'cli-stable') return { tag: value, releaseChannel: 'stable', version: null };
    if (value === 'cli-preview') return { tag: value, releaseChannel: 'preview', version: null };
    if (value === 'cli-dev') return { tag: value, releaseChannel: 'publicdev', version: null };
    const version = /^cli-v(.+)$/.exec(value)?.[1]?.trim();
    if (version) {
        const releaseChannel = version.includes('-preview.')
            ? 'preview'
            : version.includes('-dev.')
                ? 'publicdev'
                : 'stable';
        return { tag: value, releaseChannel, version };
    }
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

export function resolveCliUpdatePublishedReleasePlan(
    source: CliUpdateSource,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): Readonly<{
    tag: string;
    releaseChannel: 'stable' | 'preview' | 'publicdev';
    version: string | null;
    installRootName: 'cli' | 'cli-preview' | 'cli-dev';
    archivePattern: string;
    checksumsPattern: string;
    signaturePattern: string;
}> {
    let published: Readonly<{
        tag: string;
        releaseChannel: 'stable' | 'preview' | 'publicdev';
        version: string | null;
    }>;
    if (source.kind === 'published-channel') {
        const releaseChannel = normalizeCliUpdateChannel(source.ref);
        const suffix = releaseChannel === 'stable' ? 'stable' : releaseChannel === 'preview' ? 'preview' : 'dev';
        published = { tag: `cli-${suffix}`, releaseChannel, version: null };
    } else if (source.kind === 'published-tag') {
        published = resolveCliUpdatePublishedTag(source.ref);
    } else {
        throw new Error(`cli-update source ${source.kind} does not resolve to a published GitHub release`);
    }

    const releaseOs = platform === 'win32' ? 'windows' : platform;
    if ((releaseOs !== 'linux' && releaseOs !== 'darwin' && releaseOs !== 'windows') || (arch !== 'x64' && arch !== 'arm64')) {
        throw new Error(`Unsupported cli-update release target: ${platform}-${arch}`);
    }
    if (releaseOs === 'windows' && arch !== 'x64') {
        throw new Error(`Unsupported cli-update release target: ${platform}-${arch}`);
    }

    const versionPattern = published.version ?? '*';
    const installRootName = published.releaseChannel === 'stable'
        ? 'cli'
        : published.releaseChannel === 'preview'
            ? 'cli-preview'
            : 'cli-dev';
    return {
        ...published,
        installRootName,
        archivePattern: `happier-v${versionPattern}-${releaseOs}-${arch}.tar.gz`,
        checksumsPattern: `checksums-happier-v${versionPattern}.txt`,
        signaturePattern: `checksums-happier-v${versionPattern}.txt.minisig`,
    };
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

async function preparePublishedCliSourceSnapshot(params: {
    testDir: string;
    role: 'from' | 'to';
    source: CliUpdateSource;
    env: NodeJS.ProcessEnv;
    snapshotDir: string;
}): Promise<void> {
    const plan = resolveCliUpdatePublishedReleasePlan(params.source);
    const assetsDir = resolve(params.testDir, `cli-update-${params.role}-release-assets`);
    const installDir = resolve(params.testDir, `cli-update-${params.role}-install`);
    const binDir = resolve(params.testDir, `cli-update-${params.role}-bin`);
    await rm(assetsDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
    await mkdir(assetsDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const repo = String(params.env.GITHUB_REPOSITORY ?? 'happier-dev/happier').trim();
    if (!repo.includes('/')) {
        throw new Error(`Invalid GITHUB_REPOSITORY for cli-update release validation: ${repo}`);
    }
    await runLoggedCommand({
        command: 'gh',
        args: [
            'release', 'download', plan.tag,
            '--repo', repo,
            '--dir', assetsDir,
            '--clobber',
            '--pattern', plan.archivePattern,
            '--pattern', plan.checksumsPattern,
            '--pattern', plan.signaturePattern,
        ],
        cwd: repoRootDir(),
        env: {
            ...params.env,
            GH_TOKEN: params.env.GH_TOKEN ?? params.env.GITHUB_TOKEN ?? '',
        },
        stdoutPath: resolve(params.testDir, `cli-update.${params.role}.release-download.stdout.log`),
        stderrPath: resolve(params.testDir, `cli-update.${params.role}.release-download.stderr.log`),
        timeoutMs: 600_000,
    });

    const installerPath = resolve(
        repoRootDir(),
        'apps',
        'website',
        'public',
        process.platform === 'win32' ? 'install.ps1' : 'install.sh',
    );
    await runLoggedCommand({
        command: process.platform === 'win32' ? 'pwsh' : 'bash',
        args: process.platform === 'win32' ? ['-NoProfile', '-File', installerPath] : [installerPath],
        cwd: repoRootDir(),
        env: {
            ...params.env,
            HAPPIER_CHANNEL: plan.releaseChannel,
            HAPPIER_PRODUCT: 'cli',
            HAPPIER_INSTALL_DIR: installDir,
            HAPPIER_BIN_DIR: binDir,
            HAPPIER_WITH_DAEMON: '0',
            HAPPIER_NO_PATH_UPDATE: '1',
            HAPPIER_NONINTERACTIVE: '1',
            HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
            HAPPIER_INSTALL_VERSION: plan.version ?? '',
            HAPPIER_GITHUB_REPO: repo,
        },
        stdoutPath: resolve(params.testDir, `cli-update.${params.role}.release-install.stdout.log`),
        stderrPath: resolve(params.testDir, `cli-update.${params.role}.release-install.stderr.log`),
        timeoutMs: 600_000,
    });

    const installedPayload = await realpath(resolve(installDir, plan.installRootName, 'current'));
    if (!existsSync(resolve(installedPayload, 'package-dist', 'index.mjs')) || !existsSync(resolve(installedPayload, 'node_modules'))) {
        throw new Error(`Installed cli-update release payload is incomplete: ${installedPayload}`);
    }
    await rm(params.snapshotDir, { recursive: true, force: true });
    await rename(installedPayload, params.snapshotDir);
    await writeFile(
        resolve(params.snapshotDir, '.cli-dist-snapshot.ready.json'),
        JSON.stringify({ v: 1, source: 'cli-update-release-validation', role: params.role }, null, 2),
        'utf8',
    );
    await writeFile(
        resolve(params.snapshotDir, '.cli-update-release-validation-source.json'),
        JSON.stringify({ source: params.source, release: plan }, null, 2),
        'utf8',
    );
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

    if (params.source.kind === 'published-channel' || params.source.kind === 'published-tag') {
        await preparePublishedCliSourceSnapshot({ ...params, snapshotDir });
        return snapshotDir;
    }

    const tarballPath = resolveLocalPackPath(params.source.ref);
    await extractCliPackageTarball({
        ...params,
        tarballPath,
        snapshotDir,
    });
    return snapshotDir;
}
