import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { resolveLightDataDir } from "@/flavors/light/env";
import { expandHomeDirPath } from "@happier-dev/cli-common/path";

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
    await mkdir(resolved.root, { recursive: true });
    await assertSafeDirectory(resolved.root);
    let current = resolved.root;
    for (const part of resolved.parts.slice(0, -1)) {
        current = join(current, part);
        const stats = await readOptionalPathStats(current);
        if (!stats) {
            await mkdir(current);
            await assertSafeDirectory(current);
            continue;
        }
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw privateFilePathError();
        }
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
            await mkdir(rootDir, { recursive: true });
        },
        async writePrivateFile(key, data) {
            const resolved = resolvePrivateFilePath(rootDir, key);
            await ensureSafeParentDirectories(resolved);
            const leafStats = await readOptionalPathStats(resolved.path);
            if (leafStats?.isSymbolicLink() || (leafStats && !leafStats.isFile())) {
                throw privateFilePathError();
            }
            await writeFile(resolved.path, data);
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
