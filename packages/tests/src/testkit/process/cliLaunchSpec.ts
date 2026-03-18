import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { repoRootDir } from '../paths';
import { ensureCliSharedDepsBuilt, ensureCliDistSnapshotEntrypoint } from './cliDist';
import { ensureCliDistSnapshotNodeModules } from './cliDistSnapshotNodeModules';
import { resolveTsxImportHookPath } from './tsxImportHook';

export type CliTestLaunchSpec = Readonly<{
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}>;

type CliLaunchOptions = Parameters<typeof ensureCliDistSnapshotEntrypoint>[1] & {
    preferSourceEntrypoint?: boolean;
};

function resolveCliSourceEntrypoint(rootDir: string): string {
    return resolve(rootDir, 'apps', 'cli', 'src', 'index.ts');
}

function resolveCliTsconfigPath(rootDir: string): string {
    return resolve(rootDir, 'apps', 'cli', 'tsconfig.json');
}

function ensureCopiedTextFile(snapshotDir: string, rootDir: string, relPath: string): void {
    const target = resolve(rootDir, 'apps', 'cli', relPath);
    if (!existsSync(target)) return;
    const dest = resolve(snapshotDir, relPath);
    if (existsSync(dest)) return;
    mkdirSync(dirname(dest), { recursive: true });
    try {
        writeFileSync(dest, readFileSync(target));
    } catch {
        // Best-effort only. Source launch can still proceed if a metadata file is absent.
    }
}

async function ensureCliSourceSnapshotRoot(rootDir: string, snapshotDir: string): Promise<void> {
    const sourceDir = resolve(rootDir, 'apps', 'cli', 'src');
    if (!existsSync(sourceDir)) {
        throw new Error(`CLI source entrypoint missing for test launch: ${resolveCliSourceEntrypoint(rootDir)}`);
    }

    mkdirSync(snapshotDir, { recursive: true });
    await ensureCliSharedDepsBuilt(
        { testDir: snapshotDir, env: process.env },
        {
            repoRoot: rootDir,
        },
    );
    ensureCliDistSnapshotNodeModules({
        snapshotDir,
        snapshotDistDir: resolve(snapshotDir, 'dist'),
        rootDir,
    });
    ensureCopiedTextFile(snapshotDir, rootDir, 'package.json');
    ensureCopiedTextFile(snapshotDir, rootDir, 'tsconfig.json');

    const snapshotSourceDir = resolve(snapshotDir, 'src');
    if (!existsSync(snapshotSourceDir)) {
        mkdirSync(dirname(snapshotSourceDir), { recursive: true });
        try {
            symlinkSync(sourceDir, snapshotSourceDir, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            // Best-effort only. Some environments disallow symlinks.
        }
    }
}

async function resolveCliSourceLaunchSpec(rootDir: string, snapshotDir?: string): Promise<CliTestLaunchSpec> {
    const snapshotRootDir = typeof snapshotDir === 'string' && snapshotDir.trim() ? snapshotDir : null;
    if (snapshotRootDir) {
        await ensureCliSourceSnapshotRoot(rootDir, snapshotRootDir);
    }

    const sourceEntrypoint = snapshotRootDir
        ? resolve(snapshotRootDir, 'src', 'index.ts')
        : resolveCliSourceEntrypoint(rootDir);
    if (!existsSync(sourceEntrypoint)) {
        throw new Error(`CLI source entrypoint missing for test launch: ${sourceEntrypoint}`);
    }

    const tsxHookPath = resolveTsxImportHookPath();
    if (!tsxHookPath) {
        throw new Error('tsx import hook is required for CLI source entrypoint mode but could not be resolved');
    }

    return {
        command: process.execPath,
        args: ['--preserve-symlinks', '--import', tsxHookPath, sourceEntrypoint],
        cwd: snapshotRootDir ?? resolve(rootDir, 'apps', 'cli'),
        env: {
            TSX_TSCONFIG_PATH: snapshotRootDir ? resolve(snapshotRootDir, 'tsconfig.json') : resolveCliTsconfigPath(rootDir),
        },
    };
}

export function shouldUseCliSourceEntrypoint(env: NodeJS.ProcessEnv): boolean {
    const raw = (
        env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT ??
        env.HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT ??
        ''
    )
        .toString()
        .trim()
        .toLowerCase();

    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export async function resolveCliTestLaunchSpec(
    params: Readonly<{ testDir: string; env: NodeJS.ProcessEnv }>,
    options: CliLaunchOptions,
): Promise<CliTestLaunchSpec> {
    const rootDir = options.repoRoot ?? repoRootDir();

    if (options.preferSourceEntrypoint || shouldUseCliSourceEntrypoint(params.env)) {
        return await resolveCliSourceLaunchSpec(rootDir, options.snapshotDir);
    }

    let snapshotEntrypoint: string;
    try {
        snapshotEntrypoint = await ensureCliDistSnapshotEntrypoint(params, options);
    } catch (error) {
        if (!existsSync(resolveCliSourceEntrypoint(rootDir))) {
            throw error;
        }
        return resolveCliSourceLaunchSpec(rootDir);
    }

    return {
        command: process.execPath,
        args: ['--preserve-symlinks', snapshotEntrypoint],
    };
}
