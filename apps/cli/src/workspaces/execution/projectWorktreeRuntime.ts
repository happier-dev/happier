import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { configuration } from '@/configuration';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { buildLocalServiceDeclarationPreviewLandingUrlV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { readProjectWorktreePortSlotsV1 } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { getHostWorktreePortsOwner, type WorktreePortAssignment } from './worktreePorts';

type RuntimeInput = Readonly<{
    workspace: Pick<WorkspaceRefV1, 'id' | 'serverId' | 'machineId' | 'rootPath'>;
    manifest: ProjectManifestV1 | null;
    serviceName?: string;
}>;

/** Reserved defaults are produced here, never inherited from a previous worktree. */
export function isProjectWorktreeRuntimeVariable(name: string): boolean {
    return /^HAPPIER_WORKTREE_(?:PORT(?:_[0-9]+)?|SLUG|URL|LOCAL_URL)$/.test(name);
}

/** Port defaults only. A's launch composer owns every environment precedence decision. */
export function projectWorktreeRuntimeEnvironment(input: RuntimeInput & Readonly<{ assignment: WorktreePortAssignment }>): Record<string, string> {
    if (!input.manifest) return {};
    const slots = readProjectWorktreePortSlotsV1(input.manifest);
    if (slots === null) return {};
    const ports = input.assignment.ports.slice(0, slots);
    const primary = ports[0];
    if (primary === undefined) return {};
    const name = posix.basename(input.workspace.rootPath.replaceAll('\\', '/')).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
    const identity = createHash('sha256').update(JSON.stringify([input.workspace.serverId, input.workspace.id])).digest('hex').slice(0, 12);
    // The primary address names slot zero's declaration, never an observed port or a grant.
    const primaryDeclaration = Object.entries(input.manifest.services ?? {}).find(([, service]) =>
        service.runtime?.primary === true || service.runtime?.portSlot === 0)?.[0];
    const worktreeUrl = primaryDeclaration === undefined ? undefined : buildLocalServiceDeclarationPreviewLandingUrlV1(
        configuration.webappUrl, { serverId: input.workspace.serverId, machineId: input.workspace.machineId,
            targetId: createProjectServiceDeclarationTargetIdV1(input.workspace, { kind: 'manifest', name: primaryDeclaration }) });
    const environment: Record<string, string> = {
        HAPPIER_WORKTREE_PORT: String(primary),
        HAPPIER_WORKTREE_SLUG: `${name}-${identity}`,
        HAPPIER_WORKTREE_LOCAL_URL: `http://127.0.0.1:${primary}`,
        ...(worktreeUrl ? { HAPPIER_WORKTREE_URL: worktreeUrl } : {}),
    };
    ports.forEach((port, index) => { if (index) environment[`HAPPIER_WORKTREE_PORT_${index}`] = String(port); });
    const runtime = input.serviceName === undefined ? undefined : input.manifest.services?.[input.serviceName]?.runtime;
    const slot = input.serviceName === undefined || runtime?.primary ? 0 : runtime?.portSlot;
    if (slot !== undefined && ports[slot] !== undefined) environment.PORT = String(ports[slot]);
    return environment;
}

/** Called after admitted placement, never by inventory or passive definition inspection. */
export async function prepareProjectWorktreeRuntime(input: RuntimeInput & Readonly<{
    listenerKeys?: readonly string[];
    signal?: AbortSignal;
}>) {
    const slots = readProjectWorktreePortSlotsV1(input.manifest) ?? undefined;
    const result = await getHostWorktreePortsOwner().assign({ rootPath: input.workspace.rootPath,
        slots, listenerKeys: input.listenerKeys, signal: input.signal });
    if (result.kind !== 'ready') return result;
    return { ...result, runtimeEnvironment: projectWorktreeRuntimeEnvironment({ ...input, assignment: result.assignment }) };
}
