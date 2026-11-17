import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createProjectServiceDeclarationTargetIdV1, type ProjectServiceDeclarationRefV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { readProjectManifest } from '@/workspaces/projectSetup/projectManifestFile';
import { readProjectEffectiveDefinition } from '@/workspaces/projectSetup/projectEffectiveDefinition';
import type { ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import type { ProjectEffectiveDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';
import { readProjectWorktreePortSlotsV1 } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';
import { inspectProjectDefinitions, inspectProjectDefinitionFiles, NATIVE_PROJECT_DEFINITION_FILES } from '@/workspaces/projectSetup/nativeDefinitionInspection';
import { collectNativePackageDirectories, readNativePackage, resolveNativePackageManager, type NativePackageManager } from '@/workspaces/projectSetup/nativePackageScripts';
import { projectNativeSourceKey, resolveNativePackageScript } from '@/workspaces/projectSetup/projectNativeResolution';
import { isWorkspacePathWithin, matchWorkspaceAssociation } from '../inventory/provenance';

export type LocalServicePackageManager = NativePackageManager;

export type LocalServiceRunTargetDiscoveryOptions = Readonly<{
    /** Decided by the feed scope; declared Services are always discovered. */
    includePackageScripts?: boolean;
    /** Passive discovery uses the daemon's explicit Account, never an active requester's fallback. */
    projectDefinitionAccount?: Readonly<{ account: ProjectAccountRowsInput; serverHttpBaseUrl: string; signal?: AbortSignal }>;
    /** Active review reuses the definition already opened under its admitted requester. */
    effectiveDefinitions?: ReadonlyMap<WorkspaceRefV1, ProjectEffectiveDefinitionV1>;
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

export type LocalServiceRunTargetDiscovery<T extends LocalServiceLauncherRunTarget = LocalServiceLauncherRunTarget> = Readonly<{
    targets: readonly T[];
    /** Opted-in roots observed by the same manifest read, including roots with no Services. */
    worktreePortDefinitions: readonly Readonly<{ rootPath: string; slots: number }>[];
}>;

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

function withStableRunTargetIds(targets: readonly LocalServiceRunTarget[]): readonly LocalServiceRunTarget[] {
    return targets.map(target => ({ ...target, id: disambiguatedRunTargetId(target.id, resolve(target.cwd)) }));
}
/** Resolve a launcher selection from the actual package, not its presentation preview.
 * Only the canonical finite script vocabulary is admitted, so the resulting
 * command contains no user-authored shell syntax on POSIX, cmd or PowerShell.
 */
export async function resolveLocalServiceRunTargetScriptName(input: Readonly<{
    cwd: string;
    runTargetId: string;
}>): Promise<string | null> {
    const packageJson = await readNativePackage(input.cwd);
    if (!packageJson) return null;
    const scriptName = SERVER_SCRIPT_PRIORITY.find((name) => {
        const baseId = `${packageJson.name}:${name}`;
        return packageJson.scripts[name]
            && (input.runTargetId === baseId
                || input.runTargetId === disambiguatedRunTargetId(baseId, resolve(input.cwd))
                // Retained pre-FX224 selections hashed their original path spelling.
                || input.runTargetId === disambiguatedRunTargetId(baseId, input.cwd));
    });
    return scriptName ?? null;
}

export async function resolveLocalServiceRunTargetCommand(input: Readonly<{
    cwd: string;
    runTargetId: string;
}>): Promise<string | null> {
    const scriptName = await resolveLocalServiceRunTargetScriptName(input);
    if (!scriptName) return null;
    // Workspace packages inherit the root's declaration or lockfile. Read ancestors
    // without discovering or executing other packages.
    const selected = await resolveNativePackageScript({ root: input.cwd, file: 'package.json', target: scriptName, inheritAncestors: true });
    return selected.kind === 'selected' ? `${selected.packageManager.manager} run ${scriptName}` : null;
}
export function discoverLocalServiceRunTargets(input: Readonly<{ roots: readonly string[]; acceptedWorkspaceRefs: readonly WorkspaceRefV1[] }> & LocalServiceRunTargetDiscoveryOptions): Promise<LocalServiceRunTargetDiscovery>;
export function discoverLocalServiceRunTargets(input: Readonly<{ roots: readonly string[] }> & LocalServiceRunTargetDiscoveryOptions): Promise<LocalServiceRunTargetDiscovery<LocalServiceRunTarget>>;
export async function discoverLocalServiceRunTargets(input: Readonly<{
    roots: readonly string[];
    acceptedWorkspaceRefs?: readonly WorkspaceRefV1[];
}> & LocalServiceRunTargetDiscoveryOptions): Promise<LocalServiceRunTargetDiscovery> {
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

    const workspaces = (input.acceptedWorkspaceRefs ?? []).map(workspace => ({ id: workspace.id, path: workspace.rootPath }));
    // An implicit package script belongs to its nearest accepted Workspace. An
    // accepted parent must not project a second declaration for the same script.
    const packageTargets = targets.map(target => ({ target,
        workspace: matchWorkspaceAssociation({ cwd: target.cwd, workspaces }).workspace }));

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
    const worktreePortDefinitions = new Map<string, number>();
    for (const workspace of input.acceptedWorkspaceRefs ?? []) {
        const { manifest, detected, packageManagers } = definitionsByRoot.get(workspace.rootPath)!;
        const effective = input.effectiveDefinitions?.get(workspace) ?? (input.projectDefinitionAccount && workspace.projectKey
            ? (await readProjectEffectiveDefinition({ root: workspace.rootPath, ...input.projectDefinitionAccount,
                project: { serverId: workspace.serverId, projectId: workspace.projectKey }, repositorySnapshot: manifest })).effectiveDefinition
            : undefined);
        const effectiveManifest = effective ? effective.effectiveManifest : manifest.document?.status === 'valid' ? manifest.document.manifest : null;
        const manifestServices = effectiveManifest?.services ?? {};
        const slots = readProjectWorktreePortSlotsV1(effectiveManifest);
        if (slots !== null) worktreePortDefinitions.set(workspace.rootPath, slots);
        const declaredSources = new Set(Object.values(manifestServices).flatMap(service => service.source.kind === 'command'
            ? [] : [projectNativeSourceKey(workspace.rootPath, service.source)]));
        const isDeclared = (source: Extract<ProjectServiceDeclarationRefV1['selection'], { kind: 'native' }>['source']) =>
            Object.hasOwn(manifestServices, source.target) || declaredSources.has(projectNativeSourceKey(workspace.rootPath, source));
        for (const { target } of packageTargets.filter(target => target.workspace?.id === workspace.id)) {
            const packageManager = packageManagers.get(target.cwd)!;
            const selected = declarationTarget(workspace, { kind: 'native', source: { kind: 'native', tool: 'package_script',
                file: relative(workspace.rootPath, join(target.cwd, 'package.json')).replaceAll('\\', '/'), target: target.scriptName } });
            if (selected.declaration.selection.kind === 'native' && isDeclared(selected.declaration.selection.source)) continue;
            declarations.push({ ...selected, cwd: target.cwd, title: `${target.packageName}:${target.scriptName}`,
                packageScript: { packageName: target.packageName, packageManager, scriptName: target.scriptName } });
        }
        if (effectiveManifest) {
            for (const [name, service] of Object.entries(manifestServices)) {
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
    const unqualified = packageTargets.filter(target => !target.workspace).map(target => target.target);
    return {
        targets: [...withStableRunTargetIds(unqualified), ...declarations],
        worktreePortDefinitions: [...worktreePortDefinitions].map(([rootPath, slots]) => ({ rootPath, slots })),
    };
}
