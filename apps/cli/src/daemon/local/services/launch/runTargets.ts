import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createProjectServiceDeclarationTargetIdV1, type ProjectServiceDeclarationRefV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { readProjectManifest } from '@/workspaces/projectSetup/projectManifestFile';
import { inspectProjectDefinitions } from '@/workspaces/projectSetup/projectDefinitionInspection';
import { collectNativePackageDirectories, readNativePackage, resolveNativePackageManager, type NativePackageManager } from '@/workspaces/projectSetup/nativePackageScripts';
import { resolveNativePackageScript } from '@/workspaces/projectSetup/projectNativeResolution';
import { isWorkspacePathWithin } from '../inventory/provenance';

export type LocalServicePackageManager = NativePackageManager;

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
export function discoverLocalServiceRunTargets(input: Readonly<{ roots: readonly string[] }>): Promise<readonly LocalServiceRunTarget[]>;
export function discoverLocalServiceRunTargets(input: Readonly<{ roots: readonly string[]; acceptedWorkspaceRefs: readonly WorkspaceRefV1[] }>): Promise<readonly LocalServiceLauncherRunTarget[]>;
export async function discoverLocalServiceRunTargets(input: Readonly<{
    roots: readonly string[];
    acceptedWorkspaceRefs?: readonly WorkspaceRefV1[];
}>): Promise<readonly LocalServiceLauncherRunTarget[]> {
    const targets: LocalServiceRunTarget[] = [];
    const seenDirectories = new Set<string>();
    for (const root of [...input.roots, ...(input.acceptedWorkspaceRefs ?? []).map(workspace => workspace.rootPath)]) {
        const directories = await collectNativePackageDirectories(root);
        for (const cwd of directories) {
            if (seenDirectories.has(cwd)) {
                continue;
            }
            seenDirectories.add(cwd);
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
    }

    const declarations: LocalServiceDeclarationRunTarget[] = [];
    for (const workspace of input.acceptedWorkspaceRefs ?? []) {
        for (const target of targets.filter(target => isWorkspacePathWithin(workspace.rootPath, target.cwd))) {
            const { manager: packageManager } = await resolveNativePackageManager(target.cwd, workspace.rootPath);
            const selected = declarationTarget(workspace, { kind: 'native', source: { kind: 'native', tool: 'package_script',
                file: relative(workspace.rootPath, join(target.cwd, 'package.json')).replaceAll('\\', '/'), target: target.scriptName } });
            declarations.push({ ...selected, cwd: target.cwd, title: `${target.packageName}:${target.scriptName}`,
                packageScript: { packageName: target.packageName, packageManager, scriptName: target.scriptName } });
        }
        const manifest = await readProjectManifest({ root: workspace.rootPath });
        if (manifest.document?.status === 'valid') {
            for (const name of Object.keys(manifest.document.manifest.services ?? {})) {
                declarations.push(declarationTarget(workspace, { kind: 'manifest', name }));
            }
        }
        const detected = await inspectProjectDefinitions(workspace.rootPath);
        for (const entry of detected.entries) {
            if (entry.usage === 'service') declarations.push(declarationTarget(workspace, { kind: 'native', source: entry.source }));
        }
    }
    const unqualified = targets.filter(target => !(input.acceptedWorkspaceRefs ?? []).some(workspace => isWorkspacePathWithin(workspace.rootPath, target.cwd)));
    return [...disambiguateRunTargetIds(unqualified), ...declarations];
}
