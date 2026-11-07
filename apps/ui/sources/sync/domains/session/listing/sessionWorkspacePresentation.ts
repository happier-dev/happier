import { type MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';

import {
    normalizeSessionPathForProjectGrouping,
    resolveSessionProjectGroupingKeyParts,
} from './sessionListProjectGroupingKeys';

export type SessionWorkspacePresentationMetadata = Readonly<{
    host?: unknown;
    machineId?: unknown;
    path?: unknown;
    homeDir?: unknown;
    sessionRepositoryV1?: unknown;
}> | null | undefined;

export type SessionWorkspacePresentationTarget = Readonly<{
    machineId?: unknown;
    basePath?: unknown;
}> | null | undefined;

export const WorkspacePathDisplayModeV1SchemaValues = ['name', 'path'] as const;
export type WorkspacePathDisplayModeV1 = typeof WorkspacePathDisplayModeV1SchemaValues[number];

export type SessionWorkspacePresentation = Readonly<{
    groupKey: string;
    workspaceHash: string;
    workspaceKey: string;
    pathKey: string;
    displayPath: string;
    displayTitle: string;
    customLabel: string | null;
    hasCustomLabel: boolean;
    machineId: string | null;
    machine: MachineDisplayRenderable;
    machineLabel: string;
}>;

function makeUnknownMachine(id: string): MachineDisplayRenderable {
    return {
        id,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
    };
}

function hashFNV1a32Hex(input: string): string {
    // FNV-1a 32-bit. Used to avoid persisting raw local paths in synced keys.
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function readWorkspaceLabel(labels: unknown, workspaceKey: string): string | null {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null;
    return normalizeNonEmptyString((labels as Record<string, unknown>)[workspaceKey]);
}

function resolveMachineLabel(machine: MachineDisplayRenderable): string {
    return normalizeNonEmptyString(machine.metadata?.displayName)
        ?? normalizeNonEmptyString(machine.metadata?.host)
        ?? machine.id;
}

function resolveWorkspaceBasename(path: string): string {
    const trimmed = path.trim();
    const normalized = trimmed.replace(/[\\/]+$/, '') || trimmed;
    if (!normalized || normalized === '~') return normalized;
    const segments = normalized.split(/[\\/]+/);
    return normalizeNonEmptyString(segments[segments.length - 1]) ?? normalized;
}

export function resolveSessionWorkspacePresentation(params: Readonly<{
    metadata: SessionWorkspacePresentationMetadata;
    machines: Readonly<Record<string, MachineDisplayRenderable>>;
    target?: SessionWorkspacePresentationTarget;
    workspaceLabelsV1?: unknown;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    groupGitWorktreesByRepository?: boolean;
}>): SessionWorkspacePresentation {
    const parts = resolveSessionProjectGroupingKeyParts(params.metadata);
    const targetMachineId = normalizeNonEmptyString(params.target?.machineId);
    const targetPath = normalizeNonEmptyString(params.target?.basePath);
    const rawDisplayMachineId = targetMachineId ?? parts.machineId;
    const canonical = rawDisplayMachineId
        ? resolveCanonicalMachineId(rawDisplayMachineId, params.machines)
        : null;
    const displayMachineId = canonical?.reason === 'missingReplacementTarget'
        ? rawDisplayMachineId
        : canonical?.machineId ?? rawDisplayMachineId;
    const displayPathInput = targetPath ?? normalizeNonEmptyString(params.metadata?.path);
    const directMachine = displayMachineId ? params.machines[displayMachineId] : undefined;
    const homeDir = normalizeNonEmptyString(directMachine?.metadata?.homeDir) ?? parts.homeDir;
    const checkoutPathKey = normalizeSessionPathForProjectGrouping(displayPathInput, homeDir);
    const originalMachine = parts.machineId ? resolveCanonicalMachineId(parts.machineId, params.machines) : null;
    const originalMachineId = originalMachine?.reason === 'missingReplacementTarget'
        ? parts.machineId : originalMachine?.machineId ?? parts.machineId;
    // Repository observations belong to the observed checkout. A reachable target on
    // another machine or path must supply its own observation before grouping it.
    const pathKey = params.groupGitWorktreesByRepository === true
        && displayMachineId === originalMachineId
        && checkoutPathKey === parts.pathKey
        ? parts.repositoryPathKey ?? checkoutPathKey
        : checkoutPathKey;
    const machineGroupId = displayMachineId ? `id:${displayMachineId}` : parts.machineGroupId;
    const groupKey = `${machineGroupId}:${pathKey}`;
    const workspaceHash = hashFNV1a32Hex(groupKey);
    const workspaceKey = `wl_${workspaceHash}`;
    const displayPath = pathKey ? formatPathRelativeToHome(pathKey, homeDir ?? undefined) : '';
    const customLabel = readWorkspaceLabel(params.workspaceLabelsV1, workspaceKey);
    const defaultDisplayTitle = params.workspacePathDisplayModeV1 === 'path'
        ? displayPath
        : resolveWorkspaceBasename(displayPath || pathKey);
    const displayMachine = (() => {
        if (displayMachineId) {
            return params.machines[displayMachineId] ?? makeUnknownMachine(displayMachineId);
        }
        return makeUnknownMachine('unknown');
    })();

    return {
        groupKey,
        workspaceHash,
        workspaceKey,
        pathKey,
        displayPath,
        displayTitle: customLabel ?? defaultDisplayTitle,
        customLabel,
        hasCustomLabel: customLabel !== null,
        machineId: displayMachineId ?? null,
        machine: displayMachine,
        machineLabel: resolveMachineLabel(directMachine ?? displayMachine),
    };
}
