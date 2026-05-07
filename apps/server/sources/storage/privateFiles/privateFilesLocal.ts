import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { resolveLightDataDir } from "@/flavors/light/env";
import { expandHomeDirPath } from "@/utils/path/expandHomeDirPath";

import { normalizePrivateFileKey } from "./privateFileKeys";
import type { PrivateFilesBackend } from "./privateFiles";

export type LocalPrivateFilesBackendOptions = Readonly<{
    rootDir: string;
}>;

export function resolveLocalPrivateFilesDir(env: NodeJS.ProcessEnv = process.env): string {
    const explicit = expandHomeDirPath(
        (env.HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR ?? env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR)?.trim() ?? "",
        env,
    );
    if (explicit) {
        return explicit;
    }
    return join(resolveLightDataDir(env), "private-files");
}

export function createLocalPrivateFilesBackendFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateFilesBackend {
    return createLocalPrivateFilesBackend({ rootDir: resolveLocalPrivateFilesDir(env) });
}

type ResolvedPrivateFilePath = Readonly<{
    root: string;
    path: string;
    parts: string[];
}>;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function privateFilePathError(): Error {
    return new Error("Invalid private file path");
}

function resolvePrivateFilePath(rootDir: string, key: string): ResolvedPrivateFilePath {
    const safeKey = normalizePrivateFileKey(key);
    const root = resolve(rootDir);
    const absolute = resolve(join(root, safeKey));
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || rel === "" || rel.includes("\0")) {
        throw new Error("Invalid private file key");
    }
    return {
        root,
        path: absolute,
        parts: safeKey.split("/"),
    };
}

async function assertSafeDirectory(path: string): Promise<void> {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw privateFilePathError();
    }
}

async function readOptionalPathStats(path: string) {
    return await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
}

async function ensureSafeParentDirectories(resolved: ResolvedPrivateFilePath): Promise<void> {
    await mkdir(resolved.root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertSafeDirectory(resolved.root);
    await chmod(resolved.root, PRIVATE_DIRECTORY_MODE);
    let current = resolved.root;
    for (const part of resolved.parts.slice(0, -1)) {
        current = join(current, part);
        const stats = await readOptionalPathStats(current);
        if (!stats) {
            await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
            await assertSafeDirectory(current);
        } else if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw privateFilePathError();
        }
        await chmod(current, PRIVATE_DIRECTORY_MODE);
    }
}

async function assertSafeExistingFile(resolved: ResolvedPrivateFilePath): Promise<void> {
    await assertSafeDirectory(resolved.root);
    let current = resolved.root;
    for (const [index, part] of resolved.parts.entries()) {
        current = join(current, part);
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
            throw privateFilePathError();
        }
        if (index < resolved.parts.length - 1 && !stats.isDirectory()) {
            throw privateFilePathError();
        }
        if (index === resolved.parts.length - 1 && !stats.isFile()) {
            throw privateFilePathError();
        }
    }
}

export function createLocalPrivateFilesBackend(options: LocalPrivateFilesBackendOptions): PrivateFilesBackend {
    const rootDir = options.rootDir;

    return {
        async init() {
            await mkdir(rootDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
            await assertSafeDirectory(rootDir);
            await chmod(rootDir, PRIVATE_DIRECTORY_MODE);
        },
        async writePrivateFile(key, data) {
            const resolved = resolvePrivateFilePath(rootDir, key);
            await ensureSafeParentDirectories(resolved);
            const leafStats = await readOptionalPathStats(resolved.path);
            if (leafStats?.isSymbolicLink() || (leafStats && !leafStats.isFile())) {
                throw privateFilePathError();
            }
            await writeFile(resolved.path, data, { mode: PRIVATE_FILE_MODE });
            await chmod(resolved.path, PRIVATE_FILE_MODE);
        },
        async readPrivateFile(key) {
            const resolved = resolvePrivateFilePath(rootDir, key);
            await assertSafeExistingFile(resolved);
            const data = await readFile(resolved.path);
            return new Uint8Array(data);
        },
        async deletePrivateFile(key) {
            const resolved = resolvePrivateFilePath(rootDir, key);
            await assertSafeExistingFile(resolved).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return;
                throw error;
            });
            await rm(resolved.path, { force: true });
        },
    };
}
