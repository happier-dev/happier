import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readProjectDefinitionFile } from './nativeDefinitionFiles';

export type NativePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type NativePackageManagerSelection = Readonly<{ manager: NativePackageManager; version?: string; root: string }>;
export type NativePackage = Readonly<{ name: string; scripts: Readonly<Record<string, string>>; packageManager?: string }>;

const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules']);
const LOCKFILES = [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'],
] as const;

export function isNativeDefinitionRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseNativePackage(bytes: string, cwd: string): NativePackage {
    const parsed: unknown = JSON.parse(bytes);
    if (!isNativeDefinitionRecord(parsed)) throw new Error('invalid_package');
    const scripts: Record<string, string> = {};
    if (isNativeDefinitionRecord(parsed.scripts)) {
        for (const [name, command] of Object.entries(parsed.scripts)) {
            if (typeof command === 'string' && command.trim()) scripts[name] = command;
        }
    }
    return {
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : basename(cwd) || 'package',
        scripts,
        ...(typeof parsed.packageManager === 'string' ? { packageManager: parsed.packageManager } : {}),
    };
}

export async function readNativePackage(cwd: string): Promise<NativePackage | null> {
    const read = await readProjectDefinitionFile(cwd, 'package.json');
    if (read.kind !== 'read') return null;
    try { return parseNativePackage(read.content, cwd); }
    catch { return null; }
}

async function isFile(file: string): Promise<boolean> {
    try { return (await stat(file)).isFile(); } catch { return false; }
}

/** A package's declaration wins at each applicable root; otherwise the nearest lock selects the manager. */
export async function resolveNativePackageManager(cwd: string, projectRoot?: string): Promise<NativePackageManagerSelection> {
    let root = cwd;
    while (true) {
        const declaration = (await readNativePackage(root))?.packageManager;
        const match = declaration?.match(/^(npm|pnpm|yarn|bun)@([^\s]+)$/);
        if (match) return { manager: match[1] as NativePackageManager, version: match[2], root };
        for (const [file, manager] of LOCKFILES) {
            if ((await readProjectDefinitionFile(root, file)).kind === 'read') return { manager, root };
        }
        if (projectRoot !== undefined && root === projectRoot) return { manager: 'npm', root: cwd };
        const parent = dirname(root);
        if (parent === root) return { manager: 'npm', root: cwd };
        root = parent;
    }
}

/** Shared passive inventory; never follows directory symlinks or traverses dependency/build output. */
export async function collectNativePackageDirectories(root: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        if (await isFile(join(directory, 'package.json'))) out.push(directory);
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name)) await visit(join(directory, entry.name));
        }
    };
    await visit(root);
    return out;
}
