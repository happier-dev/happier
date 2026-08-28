import { existsSync } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const SERVER_RUNTIME_DIRECTORY_ENTRY_NAMES = Object.freeze([
    'generated',
    'node_modules',
    'prisma',
    'runtime',
] as const);

export function resolveServerRuntimeExecutableNames(platform: NodeJS.Platform = process.platform): Readonly<{
    server: string;
    migrate: string;
}> {
    const suffix = platform === 'win32' ? '.exe' : '';
    return {
        server: `happier-server${suffix}`,
        migrate: `happier-server-migrate${suffix}`,
    };
}

export function resolveServerRuntimePayloadRootFromBinaryPath(serverBinaryPath: string): string {
    const binaryPath = String(serverBinaryPath ?? '').trim();
    const binaryDir = dirname(binaryPath);
    return basename(binaryDir) === 'bin' ? dirname(binaryDir) : binaryDir;
}

export function resolveManagedServerRuntimePaths(params: Readonly<{
    installRoot: string;
    platform?: NodeJS.Platform;
}>): Readonly<{
    runtimeRoot: string;
    serverBinaryPath: string;
    migrationBinaryPath: string;
}> {
    const names = resolveServerRuntimeExecutableNames(params.platform);
    const runtimeRoot = join(params.installRoot, 'bin');
    return {
        runtimeRoot,
        serverBinaryPath: join(runtimeRoot, names.server),
        migrationBinaryPath: join(runtimeRoot, names.migrate),
    };
}

export async function assertPackagedServerRuntimeClosure(params: Readonly<{
    runtimeRoot: string;
}>): Promise<void> {
    const runtimeRoot = String(params.runtimeRoot ?? '').trim();
    const generated = await stat(join(runtimeRoot, 'generated')).catch(() => null);
    if (!generated?.isDirectory()) {
        throw new Error('[self-host] server runtime is missing packaged generated clients');
    }
    const prismaClient = await stat(join(runtimeRoot, 'node_modules', '.prisma')).catch(() => null);
    const prismaPackage = await stat(join(runtimeRoot, 'node_modules', '@prisma')).catch(() => null);
    if (!prismaClient?.isDirectory() || !prismaPackage?.isDirectory()) {
        throw new Error('[self-host] server runtime is missing packaged node_modules sidecars');
    }
}

/**
 * Release server payloads are intentionally flat. Managed service installs keep
 * their executable closure under installRoot/bin, so relocate every path whose
 * runtime lookup is relative to the executable together. Keeping this list here
 * prevents installers from independently inventing partial payload layouts.
 */
export async function relocateServerRuntimeArtifactClosure(params: Readonly<{
    payloadRoot: string;
    platform?: NodeJS.Platform;
}>): Promise<Readonly<{
    runtimeRoot: string;
    serverBinaryPath: string;
    migrationBinaryPath: string | null;
}>> {
    const platform = params.platform ?? process.platform;
    const payloadRoot = String(params.payloadRoot ?? '').trim();
    const names = resolveServerRuntimeExecutableNames(platform);
    const runtimeRoot = join(payloadRoot, 'bin');
    const nestedServerBinaryPath = join(runtimeRoot, names.server);

    if (existsSync(nestedServerBinaryPath)) {
        return {
            runtimeRoot,
            serverBinaryPath: nestedServerBinaryPath,
            migrationBinaryPath: existsSync(join(runtimeRoot, names.migrate))
                ? join(runtimeRoot, names.migrate)
                : null,
        };
    }

    const flatServerBinaryPath = join(payloadRoot, names.server);
    const serverInfo = await stat(flatServerBinaryPath).catch(() => null);
    if (!serverInfo?.isFile()) {
        throw new Error(`[relay-runtime] staged server binary missing (${flatServerBinaryPath})`);
    }

    await mkdir(runtimeRoot, { recursive: true });
    const closureEntryNames = [
        names.server,
        names.migrate,
        ...SERVER_RUNTIME_DIRECTORY_ENTRY_NAMES,
    ];
    for (const entryName of closureEntryNames) {
        const sourcePath = join(payloadRoot, entryName);
        if (!existsSync(sourcePath)) continue;
        const targetPath = join(runtimeRoot, entryName);
        if (existsSync(targetPath)) {
            throw new Error(`[relay-runtime] ambiguous server runtime payload entry (${targetPath})`);
        }
        await rename(sourcePath, targetPath);
    }

    return {
        runtimeRoot,
        serverBinaryPath: nestedServerBinaryPath,
        migrationBinaryPath: existsSync(join(runtimeRoot, names.migrate))
            ? join(runtimeRoot, names.migrate)
            : null,
    };
}
