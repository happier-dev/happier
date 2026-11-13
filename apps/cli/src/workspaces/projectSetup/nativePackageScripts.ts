import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { basename, dirname, join, resolve } from 'node:path';
import { readProjectDefinitionFile } from './nativeDefinitionFiles';
import { readRepositoryIgnoredPaths } from '@/scm/readRepositoryIgnoredPaths';
import type { ScmBackendRegistry } from '@/scm/registry';
import { ProjectDetectedApplicationV1Schema, type ProjectDetectedApplicationV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

export type NativePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type NativePackageManagerSelection = Readonly<{ manager: NativePackageManager; version?: string; root: string }>;
export type NativePackage = Readonly<{ name: string; scripts: Readonly<Record<string, string>>; packageManager?: string;
    application: Pick<ProjectDetectedApplicationV1, 'framework' | 'runtime' | 'port'> }>;

const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules']);
const LOCKFILES = [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'],
] as const;

export function isNativePackageDiscoveryDirectory(name: string): boolean {
    return !IGNORED_DIRECTORY_NAMES.has(name);
}

export function isNativePackageDeclarationFile(name: string): boolean {
    return name === 'package.json' || LOCKFILES.some(([file]) => file === name);
}

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
    const dependencies = new Set([parsed.dependencies, parsed.devDependencies].flatMap(value =>
        isNativeDefinitionRecord(value) ? Object.keys(value) : []));
    // Specialized framework declarations win over their Vite build-tool dependency.
    const frameworks = ['next', 'nuxt', 'astro', '@sveltejs/kit', '@remix-run/react'].filter(name => dependencies.has(name));
    const framework = frameworks.length === 1 ? frameworks[0]! : frameworks.length === 0 && dependencies.has('vite') ? 'vite' : null;
    const node = isNativeDefinitionRecord(parsed.engines) && typeof parsed.engines.node === 'string' && parsed.engines.node.trim()
        ? parsed.engines.node.trim() : null;
    const ports = new Set([...((scripts.start ?? '').matchAll(/(?:^|\s)(?:--port(?:=|\s+)|-p\s+|PORT=)(\d+)(?=\s|$)/gu))]
        .flatMap(match => {
            const port = ProjectDetectedApplicationV1Schema.shape.port.safeParse(Number(match[1]));
            return port.success && port.data !== null ? [port.data] : [];
        }));
    return {
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : basename(cwd) || 'package',
        scripts,
        application: { framework, runtime: node ? { name: 'node', version: node } : null,
            port: ports.size === 1 ? [...ports][0]! : null },
        ...(typeof parsed.packageManager === 'string' ? { packageManager: parsed.packageManager } : {}),
    };
}

export async function readNativePackage(cwd: string, readDefinition = readProjectDefinitionFile): Promise<NativePackage | null> {
    const read = await readDefinition(cwd, 'package.json');
    if (read.kind !== 'read') return null;
    try { return parseNativePackage(read.content, cwd); }
    catch { return null; }
}

async function isFile(file: string): Promise<boolean> {
    try { return (await currentWorkspaceSource().stat(file)).isFile(); } catch { return false; }
}

/** A package's declaration wins at each applicable root; otherwise the nearest lock selects the manager. */
export async function resolveNativePackageManager(cwd: string, projectRoot?: string,
    readDefinition = readProjectDefinitionFile): Promise<NativePackageManagerSelection> {
    let root = cwd;
    while (true) {
        const declaration = (await readNativePackage(root, readDefinition))?.packageManager;
        const match = declaration?.match(/^(npm|pnpm|yarn|bun)@([^\s]+)$/);
        if (match) return { manager: match[1] as NativePackageManager, version: match[2], root };
        for (const [file, manager] of LOCKFILES) {
            if ((await readDefinition(root, file)).kind === 'read') return { manager, root };
        }
        if (projectRoot !== undefined && root === projectRoot) return { manager: 'npm', root: cwd };
        const parent = dirname(root);
        if (parent === root) return { manager: 'npm', root: cwd };
        root = parent;
    }
}

/** Repository-relative ignored paths with separators normalized and directory markers trimmed. */
async function readIgnoredPathSet(root: string, scmRegistry?: ScmBackendRegistry): Promise<ReadonlySet<string>> {
    // Ignore rules only narrow discovery: without an SCM answer the walk stays complete.
    // The reader reports a repository that could not answer; this fallback adds no second log.
    const paths = await readRepositoryIgnoredPaths({ repositoryRoot: root, ...(scmRegistry ? { registry: scmRegistry } : {}) })
        .catch(() => null);
    return new Set((paths ?? []).map(path => path.replaceAll('\\', '/').replace(/\/+$/u, '')));
}

/**
 * Shared passive inventory; never follows directory symlinks or traverses dependency/build output.
 * Inside a repository, paths its SCM ignores (Git's standard exclude sources, with tracked
 * force-added files kept) are not opened. A folder with no repository keeps the full walk.
 */
export async function collectNativePackageDirectories(root: string | readonly string[],
    options?: Readonly<{ scmRegistry?: ScmBackendRegistry }>): Promise<string[]> {
    const out: string[] = [];
    const roots = (typeof root === 'string' ? [root] : root).map(directory => ({ directory, identity: resolve(directory) }));
    // Descendant dirents never follow symlinks, so only explicit overlapping
    // roots can repeat. Retain input identities, not every directory in the tree.
    const visitedRoots = new Map(roots.map(({ identity }) => [identity, false]));
    const visit = async (directory: string, identity: string, ignored: ReadonlySet<string>, relativePath: string): Promise<void> => {
        if (visitedRoots.get(identity) === true) return;
        if (visitedRoots.has(identity)) visitedRoots.set(identity, true);
        const entries = await currentWorkspaceSource().readdir(directory).catch(() => null);
        const packageEntry = entries?.find(entry => entry.name === 'package.json');
        const child = (name: string) => relativePath ? `${relativePath}/${name}` : name;
        // The listing already proves ordinary file presence/absence. Only a
        // symlink (or an unreadable listing) needs the previous followed stat.
        if (!ignored.has(child('package.json')) && (packageEntry?.isFile() || ((!entries || packageEntry?.isSymbolicLink())
            && await isFile(join(directory, 'package.json'))))) out.push(directory);
        for (const entry of entries ?? []) {
            if (entry.isDirectory() && isNativePackageDiscoveryDirectory(entry.name) && !ignored.has(child(entry.name))) {
                const childDirectory = join(directory, entry.name);
                await visit(childDirectory, directory === identity ? childDirectory : join(identity, entry.name), ignored, child(entry.name));
            }
        }
    };
    for (const { directory, identity } of roots) {
        if (visitedRoots.get(identity) === true) continue;
        await visit(directory, identity, await readIgnoredPathSet(directory, options?.scmRegistry), '');
    }
    return out;
}
