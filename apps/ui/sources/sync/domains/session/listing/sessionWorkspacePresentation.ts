import {
    resolveBestMachineDisplayRenderableForHost,
    type MachineDisplayRenderable,
} from '@/sync/domains/machines/machineDisplayRenderable';
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
}> | null | undefined;

export type SessionWorkspacePresentationTarget = Readonly<{
    machineId?: unknown;
    basePath?: unknown;
}> | null | undefined;

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

export function resolveSessionWorkspacePresentation(params: Readonly<{
    metadata: SessionWorkspacePresentationMetadata;
    machines: Readonly<Record<string, MachineDisplayRenderable>>;
    target?: SessionWorkspacePresentationTarget;
    workspaceLabelsV1?: unknown;
}>): SessionWorkspacePresentation {
    const parts = resolveSessionProjectGroupingKeyParts(params.metadata);
    const targetMachineId = normalizeNonEmptyString(params.target?.machineId);
    const targetPath = normalizeNonEmptyString(params.target?.basePath);
    const displayMachineId = targetMachineId ?? parts.machineId;
    const displayPathInput = targetPath ?? normalizeNonEmptyString(params.metadata?.path);
    const directMachine = displayMachineId ? params.machines[displayMachineId] : undefined;
    const host = normalizeNonEmptyString(directMachine?.metadata?.host) ?? parts.host;
    const homeDir = normalizeNonEmptyString(directMachine?.metadata?.homeDir) ?? parts.homeDir;
    const pathKey = normalizeSessionPathForProjectGrouping(displayPathInput, homeDir);
    const machineGroupId = host ? `host:${host}` : displayMachineId ? `id:${displayMachineId}` : 'unknown';
    const groupKey = `${machineGroupId}:${pathKey}`;
    const workspaceHash = hashFNV1a32Hex(groupKey);
    const workspaceKey = `wl_${workspaceHash}`;
    const displayPath = pathKey ? formatPathRelativeToHome(pathKey, homeDir ?? undefined) : '';
    const customLabel = readWorkspaceLabel(params.workspaceLabelsV1, workspaceKey);
    const displayMachine = (() => {
        if (host) {
            return resolveBestMachineDisplayRenderableForHost(params.machines, host) ?? makeUnknownMachine(host);
        }
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
        displayTitle: customLabel ?? displayPath,
        customLabel,
        hasCustomLabel: customLabel !== null,
        machineId: displayMachineId ?? null,
        machine: displayMachine,
        machineLabel: resolveMachineLabel(directMachine ?? displayMachine),
    };
}
