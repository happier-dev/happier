import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type LocalServicePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type LocalServiceRunTarget = Readonly<{
    id: string;
    cwd: string;
    packageName: string;
    packageManager: LocalServicePackageManager;
    scriptName: string;
    command: string;
    launchIntent: Readonly<{
        kind: 'packageScript';
        packageManager: LocalServicePackageManager;
        cwd: string;
        scriptName: string;
    }>;
}>;

const SERVER_SCRIPT_PRIORITY = ['dev', 'serve', 'preview', 'start'] as const;
const RUN_TARGET_ID_MAX_LENGTH = 256;
const RUN_TARGET_ID_HASH_LENGTH = 12;
const DEFAULT_MAX_VISITED_DIRECTORIES = 5_000;
const IGNORED_DIRECTORY_NAMES = new Set([
    '.git',
    '.hg',
    '.svn',
    '.next',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'node_modules',
]);

function disambiguatedRunTargetId(baseId: string, cwd: string): string {
    const suffix = `:${createHash('sha256').update(cwd).digest('hex').slice(0, RUN_TARGET_ID_HASH_LENGTH)}`;
    if (baseId.length + suffix.length <= RUN_TARGET_ID_MAX_LENGTH) {
        return `${baseId}${suffix}`;
    }
    return `${baseId.slice(0, RUN_TARGET_ID_MAX_LENGTH - suffix.length)}${suffix}`;
}

function disambiguateRunTargetIds(targets: readonly LocalServiceRunTarget[]): readonly LocalServiceRunTarget[] {
    const countById = new Map<string, number>();
    for (const target of targets) {
        countById.set(target.id, (countById.get(target.id) ?? 0) + 1);
    }
    return targets.map((target) => {
        if ((countById.get(target.id) ?? 0) <= 1) {
            return target;
        }
        return {
            ...target,
            id: disambiguatedRunTargetId(target.id, target.cwd),
        };
    });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> {
    if (!isRecord(value)) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
            out[key] = entry;
        }
    }
    return out;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function resolvePackageManager(root: string): Promise<LocalServicePackageManager> {
    if (await pathExists(join(root, 'pnpm-lock.yaml'))) {
        return 'pnpm';
    }
    if (await pathExists(join(root, 'yarn.lock'))) {
        return 'yarn';
    }
    if (await pathExists(join(root, 'bun.lock')) || await pathExists(join(root, 'bun.lockb'))) {
        return 'bun';
    }
    return 'npm';
}

async function readPackageJson(cwd: string): Promise<Readonly<{
    name: string;
    scripts: Readonly<Record<string, string>>;
}> | null> {
    let raw: string;
    try {
        raw = await readFile(join(cwd, 'package.json'), 'utf8');
    } catch {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) {
        return null;
    }
    const name = typeof parsed.name === 'string' && parsed.name.trim().length > 0
        ? parsed.name.trim()
        : cwd.split(/[\\/]+/).filter(Boolean).at(-1) ?? 'package';
    return {
        name,
        scripts: readStringRecord(parsed.scripts),
    };
}

async function collectPackageDirectories(
    root: string,
    budget: { remaining: number },
): Promise<string[]> {
    const out: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        if (budget.remaining <= 0) {
            return;
        }
        budget.remaining -= 1;
        if (await pathExists(join(directory, 'package.json'))) {
            out.push(directory);
        }
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory() || IGNORED_DIRECTORY_NAMES.has(entry.name)) {
                continue;
            }
            await visit(join(directory, entry.name));
        }
    };
    await visit(root);
    return out;
}

export async function discoverLocalServiceRunTargets(input: Readonly<{
    roots: readonly string[];
    maxVisitedDirectories?: number;
}>): Promise<readonly LocalServiceRunTarget[]> {
    const targets: LocalServiceRunTarget[] = [];
    const seenDirectories = new Set<string>();
    const traversalBudget = {
        remaining: Math.max(0, input.maxVisitedDirectories ?? DEFAULT_MAX_VISITED_DIRECTORIES),
    };

    for (const root of input.roots) {
        const packageManager = await resolvePackageManager(root);
        const directories = await collectPackageDirectories(root, traversalBudget);
        for (const cwd of directories) {
            if (seenDirectories.has(cwd)) {
                continue;
            }
            seenDirectories.add(cwd);
            const packageJson = await readPackageJson(cwd);
            if (!packageJson) {
                continue;
            }
            for (const scriptName of SERVER_SCRIPT_PRIORITY) {
                const command = packageJson.scripts[scriptName];
                if (!command) {
                    continue;
                }
                targets.push({
                    id: `${packageJson.name}:${scriptName}`,
                    cwd,
                    packageName: packageJson.name,
                    packageManager,
                    scriptName,
                    command,
                    launchIntent: {
                        kind: 'packageScript',
                        packageManager,
                        cwd,
                        scriptName,
                    },
                });
            }
        }
    }

    return disambiguateRunTargetIds(targets);
}
