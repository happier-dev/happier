import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createProjectServiceDeclarationTargetIdV1, type ProjectServiceDeclarationRefV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { readProjectManifest } from '@/workspaces/projectSetup/projectManifestFile';
import { inspectProjectDefinitions, inspectProjectDefinitionFiles, NATIVE_PROJECT_DEFINITION_FILES } from '@/workspaces/projectSetup/nativeDefinitionInspection';
import { collectNativePackageDirectories, readNativePackage, resolveNativePackageManager, type NativePackageManager } from '@/workspaces/projectSetup/nativePackageScripts';
import { projectNativeSourceKey, resolveNativePackageScript } from '@/workspaces/projectSetup/projectNativeResolution';
import { isWorkspacePathWithin } from '../inventory/provenance';

export type LocalServicePackageManager = NativePackageManager;

export type LocalServiceRunTargetDiscoveryOptions = Readonly<{
    /** Decided by the feed scope; declared Services are always discovered. */
    includePackageScripts?: boolean;
}>;

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

export type LocalServiceDeclarationRunTarget = Readonly<{
    id: string;
    cwd: string;
    workspaceId: string;
    workspace: WorkspaceAddressV1;
    declaration: ProjectServiceDeclarationRefV1;
    title: string;
    /** Naming evidence only; it never gives a detected process managed custody. */
    displayMatch?: Readonly<{ port?: number; command?: string }>;
    packageScript?: Readonly<{ packageName: string; packageManager: LocalServicePackageManager; scriptName: string }>;
}>;
export type LocalServiceLauncherRunTarget = LocalServiceRunTarget | LocalServiceDeclarationRunTarget;

function declarationTarget(workspace: WorkspaceRefV1, selection: ProjectServiceDeclarationRefV1['selection']): LocalServiceDeclarationRunTarget {
    const declaration = { workspaceRefId: workspace.id, selection };
    // The feed id fits its wire contract; full source identity is retained separately.
    const id = createProjectServiceDeclarationTargetIdV1(workspace, selection);
    return { id, cwd: workspace.rootPath, workspaceId: workspace.id,
        workspace: { serverId: workspace.serverId, machineId: workspace.machineId, workspaceId: workspace.id, rootPath: workspace.rootPath }, declaration,
        title: selection.kind === 'manifest' ? selection.name : selection.source.target };
}

const SERVER_SCRIPT_PRIORITY = ['dev', 'serve', 'preview', 'start'] as const;
const RUN_TARGET_ID_MAX_LENGTH = 256;
const RUN_TARGET_ID_HASH_LENGTH = 12;

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
/** Resolve a launcher selection from the actual package, not its presentation preview.
 * Only the canonical finite script vocabulary is admitted, so the resulting
 * command contains no user-authored shell syntax on POSIX, cmd or PowerShell.
 */
export async function resolveLocalServiceRunTargetCommand(input: Readonly<{
    cwd: string;
    runTargetId: string;
}>): Promise<string | null> {
    const packageJson = await readNativePackage(input.cwd);
    if (!packageJson) return null;
    const scriptName = SERVER_SCRIPT_PRIORITY.find((name) => {
        const baseId = `${packageJson.name}:${name}`;
        return packageJson.scripts[name]
            && (input.runTargetId === baseId || input.runTargetId === disambiguatedRunTargetId(baseId, input.cwd));
    });
    if (!scriptName) return null;
    // Workspace packages inherit the root's declaration or lockfile. Read ancestors
    // without discovering or executing other packages.
    const selected = await resolveNativePackageScript({ root: input.cwd, file: 'package.json', target: scriptName, inheritAncestors: true });
    return selected.kind === 'selected' ? `${selected.packageManager.manager} run ${scriptName}` : null;
}
export function discoverLocalServiceRunTargets(input: Readonly<{ roots: readonly string[] }> & LocalServiceRunTargetDiscoveryOptions): Promise<readonly LocalServiceRunTarget[]>;
export function discoverLocalServiceRunTargets(input: Readonly<{ roots: readonly string[]; acceptedWorkspaceRefs: readonly WorkspaceRefV1[] }> & LocalServiceRunTargetDiscoveryOptions): Promise<readonly LocalServiceLauncherRunTarget[]>;
export async function discoverLocalServiceRunTargets(input: Readonly<{
    roots: readonly string[];
    acceptedWorkspaceRefs?: readonly WorkspaceRefV1[];
}> & LocalServiceRunTargetDiscoveryOptions): Promise<readonly LocalServiceLauncherRunTarget[]> {
    const targets: LocalServiceRunTarget[] = [];
    // Accepted parents qualify scoped declarations, not traversal demand. A
    // selected child must not reopen its parent's sibling package trees.
    const directories = input.includePackageScripts === false ? [] : await collectNativePackageDirectories(input.roots.length > 0
        ? input.roots : (input.acceptedWorkspaceRefs ?? []).map(workspace => workspace.rootPath));
    for (const cwd of directories) {
        const packageJson = await readNativePackage(cwd);
        if (!packageJson) {
            continue;
        }
        const { manager: packageManager } = await resolveNativePackageManager(cwd);
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

    // Physical files are observed once per discovery, then projected for each
    // Workspace identity. Nothing from this operation survives the next read.
    const definitionsByRoot = new Map<string, Readonly<{
        manifest: Awaited<ReturnType<typeof readProjectManifest>>;
        detected: Awaited<ReturnType<typeof inspectProjectDefinitions>>;
        packageManagers: ReadonlyMap<string, LocalServicePackageManager>;
    }>>();
    for (const root of new Set((input.acceptedWorkspaceRefs ?? []).map(workspace => workspace.rootPath))) {
        const manifest = await readProjectManifest({ root });
        const detected = input.includePackageScripts === false
            ? await inspectProjectDefinitionFiles(root, NATIVE_PROJECT_DEFINITION_FILES
                .filter(file => file !== 'package.json').map(file => ({ file })))
            : await inspectProjectDefinitions(root, {
            packageDirectories: directories.filter(cwd => isWorkspacePathWithin(root, cwd)),
        });
        const packageManagers = new Map<string, LocalServicePackageManager>();
        for (const target of targets) {
            if (!isWorkspacePathWithin(root, target.cwd) || packageManagers.has(target.cwd)) continue;
            packageManagers.set(target.cwd, (await resolveNativePackageManager(target.cwd, root)).manager);
        }
        definitionsByRoot.set(root, { manifest, detected, packageManagers });
    }
    const declarations: LocalServiceDeclarationRunTarget[] = [];
    for (const workspace of input.acceptedWorkspaceRefs ?? []) {
        const { manifest, detected, packageManagers } = definitionsByRoot.get(workspace.rootPath)!;
        const manifestServices = manifest.document?.status === 'valid' ? manifest.document.manifest.services ?? {} : {};
        const declaredSources = new Set(Object.values(manifestServices).flatMap(service => service.source.kind === 'command'
            ? [] : [projectNativeSourceKey(workspace.rootPath, service.source)]));
        const isDeclared = (source: Extract<ProjectServiceDeclarationRefV1['selection'], { kind: 'native' }>['source']) =>
            Object.hasOwn(manifestServices, source.target) || declaredSources.has(projectNativeSourceKey(workspace.rootPath, source));
        for (const target of targets.filter(target => isWorkspacePathWithin(workspace.rootPath, target.cwd))) {
            const packageManager = packageManagers.get(target.cwd)!;
            const selected = declarationTarget(workspace, { kind: 'native', source: { kind: 'native', tool: 'package_script',
                file: relative(workspace.rootPath, join(target.cwd, 'package.json')).replaceAll('\\', '/'), target: target.scriptName } });
            if (selected.declaration.selection.kind === 'native' && isDeclared(selected.declaration.selection.source)) continue;
            declarations.push({ ...selected, cwd: target.cwd, title: `${target.packageName}:${target.scriptName}`,
                packageScript: { packageName: target.packageName, packageManager, scriptName: target.scriptName } });
        }
        if (manifest.document?.status === 'valid') {
            for (const [name, service] of Object.entries(manifest.document.manifest.services ?? {})) {
                declarations.push({ ...declarationTarget(workspace, { kind: 'manifest', name }),
                    displayMatch: { ...(service.port !== undefined ? { port: service.port } : {}),
                        ...(service.source.kind === 'command' ? { command: service.source.command } : {}) } });
            }
        }
        for (const entry of detected.entries) {
            // One named declaration owns its native source even when renamed in project.json.
            if (entry.usage === 'service' && !isDeclared(entry.source)) {
                declarations.push(declarationTarget(workspace, { kind: 'native', source: entry.source }));
            }
        }
    }
    const unqualified = targets.filter(target => !(input.acceptedWorkspaceRefs ?? []).some(workspace => isWorkspacePathWithin(workspace.rootPath, target.cwd)));
    return [...disambiguateRunTargetIds(unqualified), ...declarations];
}
