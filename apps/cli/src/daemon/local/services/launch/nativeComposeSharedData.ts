import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import type { WorkspaceManifestEntry } from '@happier-dev/protocol';
import { isDeploymentSourceUnchangedManifestInput, isDeploymentManifestInputUnchanged } from '@/deployments/targets/ownServer/exactCommitRelease';
import { resolveContainedWorkspaceMaterializationPath } from '@/scm/workspace/workspaceMaterializationSafety';
import { realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';

export type NativeComposeSharedBind = Readonly<{ relativePath: string; services: readonly string[] }>;
export type NativeComposeSharedDataInput = Readonly<{
    environmentRoot: string;
    readSourceCustody?(sourcePath: string, assertNativeMountCurrent?: () => Promise<void>): Promise<Readonly<{ rootPath: string; manifest: readonly WorkspaceManifestEntry[] }> | undefined>;
    /** Existing receipt mappings keep retained rollback configuration on the same data. */
    bindings?: readonly NativeComposeSharedBind[];
}>;
type Seed = Readonly<{ relativePath: string; sourcePath?: string; services: string[] }>;
export type NativeComposeSharedDataPlan = Readonly<{ bindings: readonly NativeComposeSharedBind[];
    paths: readonly string[]; seeds: readonly Seed[] }>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown) => record(error) && error.code === 'ENOENT';
const contained = (root: string, path: string) => {
    const suffix = relative(resolve(root), resolve(path));
    return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
};
const refusal = (): never => { throw Object.assign(new Error('Deployment data path escaped its owner'), { code: 'deployment_source_unavailable' }); };

/** Every actual bind source must remain physical, including an existing target
 * needing no seed. Ordinary links inside a mounted data tree are not traversed. */
export async function assertNativeComposeSharedDataPaths(input: Readonly<{
    storage: NativeComposeSharedDataInput; paths: readonly string[];
}>): Promise<void> {
    if (!input.paths.length) return;
    const shared = join(await realpath(input.storage.environmentRoot), 'shared');
    if (await realpathWithAbsentSuffix(shared) !== shared) return refusal();
    for (const path of input.paths) {
        const target = resolveContainedWorkspaceMaterializationPath({ workspaceRoot: shared, candidatePath: path,
            errorMessage: 'Shared deployment bind escaped its owner' });
        if (await realpathWithAbsentSuffix(target) !== target) return refusal();
    }
}

/** One collection per explicit native render, shared by all selected binds.
 * Native mounts, not an assumed releases/<active-id>, locate incumbent data. */
export function createNativeComposeIncumbentBindReader(input: Readonly<{
    projectName: string;
    run(args: readonly string[]): Promise<Readonly<{ stdout: string; exitCode?: number | null }>>;
    readSourceCustody?: NativeComposeSharedDataInput['readSourceCustody'];
}>) {
    let rows: Promise<readonly Record<string, unknown>[]> | undefined;
    const read = async () => {
        rows ??= (async () => {
            const listed = await input.run(['ps', '--all', '--no-trunc', '--format', '{{.ID}}']);
            if (listed.exitCode !== undefined && listed.exitCode !== 0) return refusal();
            const ids = listed.stdout.trim().split('\n').filter(Boolean);
            if (!ids.length) return [];
            if (ids.some(id => !/^[a-f0-9]{64}$/u.test(id)) || new Set(ids).size !== ids.length) return refusal();
            const inspected = await input.run(['inspect', '--type', 'container', ...ids]);
            if (inspected.exitCode !== undefined && inspected.exitCode !== 0) return refusal();
            const observed: unknown = JSON.parse(inspected.stdout);
            if (!Array.isArray(observed) || observed.length !== ids.length || observed.some(row => !record(row) || typeof row.Id !== 'string'
                || !ids.includes(row.Id) || !Array.isArray(row.Mounts)
                || !record(row.State) || typeof row.State.Status !== 'string')) return refusal();
            // Docker is the native boundary; every consumed field was checked.
            return observed as Record<string, unknown>[];
        })();
        return rows;
    };
    return { async read(service: string, target: string, relativePath: string) {
        const matches: { path: string; running: boolean }[] = [];
        for (const row of await read()) {
            if (!record(row.Config) || !record(row.Config.Labels)
                || row.Config.Labels['com.docker.compose.project'] !== input.projectName || !Array.isArray(row.Mounts)) continue;
            for (const mount of row.Mounts) {
                if (!record(mount) || mount.Type !== 'bind' || typeof mount.Source !== 'string') continue;
                const exact = row.Config.Labels['com.docker.compose.service'] === service && mount.Destination === target;
                const nativeService = row.Config.Labels['com.docker.compose.service'];
                const custody = await input.readSourceCustody?.(mount.Source, async () => {
                    const inspected = await input.run(['inspect', '--type', 'container', String(row.Id)]);
                    if (inspected.exitCode !== undefined && inspected.exitCode !== 0) return refusal();
                    const current: unknown = JSON.parse(inspected.stdout);
                    const exact = Array.isArray(current) && current.length === 1 && record(current[0]) ? current[0] : null;
                    if (!exact || exact.Id !== row.Id || !record(exact.Config) || !record(exact.Config.Labels)
                        || exact.Config.Labels['com.docker.compose.project'] !== input.projectName
                        || exact.Config.Labels['com.docker.compose.service'] !== nativeService
                        || !Array.isArray(exact.Mounts) || !exact.Mounts.some(value => record(value) && value.Type === 'bind'
                            && value.Source === mount.Source && value.Destination === mount.Destination)) return refusal();
                });
                let incumbentPath = mount.Source;
                if (custody) {
                    const source = await realpathWithAbsentSuffix(mount.Source);
                    const candidate = resolveContainedWorkspaceMaterializationPath({ workspaceRoot: custody.rootPath,
                        candidatePath: relativePath, errorMessage: 'Incumbent deployment bind escaped its owner' });
                    if (source === candidate || contained(source, candidate)) {
                        const selected = await realpathWithAbsentSuffix(candidate);
                        if (!contained(custody.rootPath, selected) || source !== selected && !contained(source, selected)) return refusal();
                        try { await lstat(selected); } catch (error) { if (missing(error)) continue; throw error; }
                        // A renamed file bind can select a child of the prior
                        // directory mount. Its own bytes, not sibling changes,
                        // determine whether the incumbent data is mutable.
                        incumbentPath = selected;
                    } else if (!exact) continue;
                } else if (!exact) continue;
                matches.push({ path: incumbentPath, running: record(row.State)
                    && !['created', 'exited', 'dead'].includes(String(row.State.Status)) });
            }
        }
        if (!matches.length) return undefined;
        const current = matches.some(match => match.running) ? matches.filter(match => match.running) : matches;
        if (current.some(match => match.path !== current[0].path)) return refusal();
        return { path: current[0].path, running: current.some(match => match.running) };
    }, async bindSources() {
        const paths = new Set<string>();
        for (const row of await read()) {
            if (!Array.isArray(row.Mounts)) return refusal();
            for (const mount of row.Mounts) {
            if (!record(mount) || mount.Type !== 'bind') continue;
            if (typeof mount.Source !== 'string') return refusal();
            paths.add(await realpathWithAbsentSuffix(mount.Source));
            }
        }
        return [...paths];
    }, async writers(paths: readonly string[]) {
        const selected = await Promise.all(paths.map(path => realpathWithAbsentSuffix(path)));
        const ids = new Set<string>();
        for (const row of await read()) {
            if (!record(row.State) || ['created', 'exited', 'dead'].includes(String(row.State.Status)) || !Array.isArray(row.Mounts)) continue;
            for (const mount of row.Mounts) {
                if (!record(mount) || mount.Type !== 'bind' || typeof mount.Source !== 'string' || mount.RW === false) continue;
                const source = await realpathWithAbsentSuffix(mount.Source);
                if (!selected.some(path => path === source || contained(source, path) || contained(path, source))) continue;
                if (!record(row.Config) || !record(row.Config.Labels)
                    || row.Config.Labels['com.docker.compose.project'] !== input.projectName
                    || typeof row.Config.Labels['com.docker.compose.service'] !== 'string') return refusal();
                ids.add(String(row.Id));
            }
        }
        return [...ids];
    } };
}

/** Native Compose already resolved syntax/includes/interpolation. This owner
 * changes only the effective bind path; source documents are never rewritten. */
export async function projectNativeComposeSharedData(input: Readonly<{
    model: Record<string, unknown>; source: DeploymentSourceMaterializationV1; storage: NativeComposeSharedDataInput;
    unresolvedModel?: Record<string, unknown>;
    readIncumbentBind?(service: string, target: string, relativePath: string): Promise<Readonly<{ path: string; running: boolean }> | undefined>;
    readSeedWriters?(paths: readonly string[]): Promise<readonly string[]>;
}>): Promise<NativeComposeSharedDataPlan> {
    const root = await realpath(input.source.rootPath);
    const suppliedRoot = resolve(input.source.rootPath);
    const shared = join(await realpath(input.storage.environmentRoot), 'shared');
    const bindings = new Map<string, { relativePath: string; services: string[] }>();
    const paths = new Set<string>();
    const seeds = new Map<string, Seed>();
    for (const [service, definition] of Object.entries(record(input.model.services) ? input.model.services : {})) {
        if (!record(definition) || !Array.isArray(definition.volumes)) continue;
        for (const [index, mount] of definition.volumes.entries()) {
            if (!record(mount) || mount.type !== 'bind' || typeof mount.source !== 'string') continue;
            const suppliedPath = resolve(suppliedRoot, mount.source);
            if (!contained(suppliedRoot, suppliedPath) && !contained(root, suppliedPath)) continue;
            const path = await realpathWithAbsentSuffix(suppliedPath);
            if (!contained(root, path)) continue;
            const relativePath = relative(root, path).split(sep).join('/');
            const unresolvedService = record(input.unresolvedModel?.services) ? input.unresolvedModel.services[service] : undefined;
            const unresolvedMount = record(unresolvedService) && Array.isArray(unresolvedService.volumes) ? unresolvedService.volumes[index] : undefined;
            // Keep interpolation expressions in provenance, never actual bound
            // values. Only invocation-owned native input uses the resolved path.
            const bindingPath = record(unresolvedMount) && typeof unresolvedMount.source === 'string'
                ? relative(suppliedRoot, resolve(suppliedRoot, unresolvedMount.source)).split(sep).join('/') : relativePath;
            const target = resolveContainedWorkspaceMaterializationPath({ workspaceRoot: shared, candidatePath: relativePath,
                errorMessage: 'Shared deployment bind escaped its owner' });
            let exists = false;
            try { exists = (await lstat(target)).isFile() || (await lstat(target)).isDirectory(); }
            catch (error) { if (!missing(error)) throw error; }
            if (!exists && input.storage.bindings?.some(binding => binding.relativePath === bindingPath)) return refusal();
            const incumbent = !exists && typeof mount.target === 'string' ? await input.readIncumbentBind?.(service, mount.target, relativePath) : undefined;
            const incumbentPath = incumbent?.path;
            let incumbentMutable = false;
            if (incumbentPath) {
                const custody = await input.storage.readSourceCustody?.(incumbentPath);
                if (!custody || !contained(custody.rootPath, incumbentPath)) return refusal();
                try {
                    await lstat(incumbentPath);
                    incumbentMutable = !await isDeploymentManifestInputUnchanged({ rootPath: custody.rootPath,
                        manifest: custody.manifest, path: incumbentPath });
                } catch (error) { if (missing(error)) return refusal(); throw error; }
            }
            if (!exists && !incumbentMutable
                && await isDeploymentSourceUnchangedManifestInput(input.source, path)) continue;
            await assertNativeComposeSharedDataPaths({ storage: input.storage, paths: [relativePath] });
            paths.add(relativePath);
            let sourcePath: string | undefined;
            for (const candidate of [...new Set([incumbentPath, path].filter((value): value is string => value !== undefined))]) {
                try { await lstat(candidate); sourcePath = candidate; break; }
                catch (error) { if (!missing(error)) throw error; }
            }
            if (!sourcePath && record(mount.bind) && mount.bind.create_host_path === false) return refusal();
            const binding = bindings.get(bindingPath) ?? { relativePath: bindingPath, services: [] };
            if (!binding.services.includes(service)) binding.services.push(service);
            bindings.set(bindingPath, binding);
            if (!exists) {
                const seed = seeds.get(relativePath) ?? { relativePath, ...(sourcePath ? { sourcePath } : {}),
                    services: [] };
                // Review refuses foreign overlapping writers without effects.
                // Activation re-observes exact IDs after native admission.
                await input.readSeedWriters?.([target, ...(sourcePath ? [sourcePath] : [])]);
                if (!seed.services.includes(service)) seed.services.push(service);
                seeds.set(relativePath, seed);
            }
            mount.source = target;
            if (record(unresolvedMount)) unresolvedMount.source = target;
        }
    }
    return { bindings: [...bindings.values()], paths: [...paths], seeds: [...seeds.values()] };
}

/** Caller holds native admission and has quiesced only the incumbent services
 * whose original writable bind is being moved. Existing shared data always wins. */
export async function seedNativeComposeSharedData(input: Readonly<{
    source: DeploymentSourceMaterializationV1;
    storage: NativeComposeSharedDataInput; plan: NativeComposeSharedDataPlan; assertCurrent(): Promise<void>;
}>): Promise<void> {
    const environment = await realpath(input.storage.environmentRoot);
    const shared = join(environment, 'shared');
    await input.assertCurrent();
    try { await mkdir(shared, { mode: 0o700 }); } catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
    if (!(await lstat(shared)).isDirectory() || await realpath(shared) !== shared) return refusal();
    for (const seed of input.plan.seeds) {
        const target = resolveContainedWorkspaceMaterializationPath({ workspaceRoot: shared, candidatePath: seed.relativePath,
            errorMessage: 'Shared deployment bind escaped its owner' });
        let parent = shared;
        for (const segment of relative(shared, dirname(target)).split(sep).filter(Boolean)) {
            parent = join(parent, segment);
            await input.assertCurrent();
            try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
            if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) return refusal();
        }
        try { const stat = await lstat(target); if (!stat.isFile() && !stat.isDirectory()) return refusal(); continue; }
        catch (error) { if (!missing(error)) throw error; }
        const temporary = await mkdtemp(join(dirname(target), '.happier-seed-'));
        const staged = join(temporary, 'data');
        try {
            if (seed.sourcePath) {
                const selected = await realpathWithAbsentSuffix(seed.sourcePath);
                if (!contained(await realpath(input.source.rootPath), selected)) {
                    const custody = await input.storage.readSourceCustody?.(seed.sourcePath);
                    if (!custody || !contained(custody.rootPath, selected)) return refusal();
                }
            }
            if (seed.sourcePath) await cp(seed.sourcePath, staged, { recursive: true, force: false, errorOnExist: true,
                dereference: false, verbatimSymlinks: true,
                mode: constants.COPYFILE_EXCL, async filter(path) {
                    await input.assertCurrent();
                    const stat = await lstat(path);
                    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) return refusal();
                    return true;
                } });
            else await mkdir(staged, { mode: 0o700 });
            await input.assertCurrent();
            // Native admission serializes the Environment's effects. Do not
            // replace an already-created shared target after a settled seed.
            try { await lstat(target); continue; } catch (error) { if (!missing(error)) throw error; }
            await rename(staged, target);
        } finally { await rm(temporary, { recursive: true, force: true }); }
    }
}
