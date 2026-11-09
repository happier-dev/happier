import type {
    LocalServiceLauncherSnapshotV1,
    LocalServiceLaunchTargetActionV1,
    LocalServiceLaunchTargetV1,
    LocalServicePreviewResourceV1,
} from '@happier-dev/protocol';
import { LOCAL_SERVICE_LAUNCH_TARGET_TITLE_MAX_LENGTH, LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH } from '@happier-dev/protocol/local/services/launcher/v1';
import { isLocalServiceWebServerV1 } from '@happier-dev/protocol/local/services/inventory/v1';

import type { LocalServiceLauncherRunTarget } from './runTargets';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { isWorkspacePathWithin } from '../inventory/provenance';
import { resolveLocalServiceActionEligibility } from '../actions/policy';
import { buildLocalServicePreviewBrowserTarget, selectLocalServicePreviewForInventoryEntry } from '../preview/registry';

/** Bound display text without changing the source/declaration used for admission. */
export function formatLocalServiceLauncherTitle(value: string): string {
    const title = value.trim() || JSON.stringify(value);
    return clipLauncherText(title, LOCAL_SERVICE_LAUNCH_TARGET_TITLE_MAX_LENGTH);
}

function clipLauncherText(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    // Avoid leaving half a UTF-16 pair when the wire's string-length bound clips a label.
    return `${value.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`;
}

export type BuildLocalServiceLauncherSnapshotInput = Readonly<{
    machineId: string;
    accountId?: string;
    sessionId?: string;
    /**
     * Workspace-PATH scope (D1). When present, inventory entries and run-targets are
     * kept only when their workspace path / cwd matches one of these paths. Scope is by
     * PATH, never by session: a service started by another session in the same workspace
     * stays visible. Absent → no scoping (full machine view).
     */
    workspaceScopePaths?: readonly string[];
    updatedAt: number;
    runTargets: readonly LocalServiceLauncherRunTarget[];
    inventoryEntries: readonly NormalizedLocalServiceInventoryEntry[];
    previewResources: readonly LocalServicePreviewResourceV1[];
    terminateDetectedEnabled?: boolean;
    terminalUrlCandidates?: readonly LocalServiceTerminalUrlLaunchCandidate[];
    workspaceFileAssetCandidates?: readonly LocalServiceWorkspaceFileAssetLaunchCandidate[];
}>;

export type LocalServiceTerminalUrlLaunchCandidate = Readonly<{
    sourceId: string;
    addressLabel: string;
    title?: string;
    cwd?: string;
    workspaceId?: string;
    host?: string;
    port?: number;
    kind?: string;
    confidence?: LocalServiceLaunchTargetV1['confidence'];
}>;

export type LocalServiceWorkspaceFileAssetLaunchCandidate = Readonly<{
    sourceId: string;
    assetRef: string;
    title: string;
    mediaType?: string;
    cwd?: string;
    workspaceId?: string;
    kind?: string;
    confidence?: LocalServiceLaunchTargetV1['confidence'];
}>;

function readEntryPresentation(entry: NormalizedLocalServiceInventoryEntry, key: keyof NonNullable<NormalizedLocalServiceInventoryEntry['presentation']>): string | undefined {
    const value = entry.presentation?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function addressLabel(entry: NormalizedLocalServiceInventoryEntry): string {
    return readEntryPresentation(entry, 'addressLabel') ?? `${entry.address.host}:${entry.port}`;
}

function entryTitle(entry: NormalizedLocalServiceInventoryEntry): string {
    return readEntryPresentation(entry, 'pageTitle')
        ?? readEntryPresentation(entry, 'displayName')
        ?? entry.classification?.displayName
        ?? addressLabel(entry);
}

function entryCommandPreview(entry: NormalizedLocalServiceInventoryEntry): string | undefined {
    const command = entry.provenance?.process?.command?.trim();
    return command && command !== 'unknown'
        ? clipLauncherText(command, LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH) : undefined;
}

function declarationTitleForEntry(
    entry: NormalizedLocalServiceInventoryEntry,
    runTargets: readonly LocalServiceLauncherRunTarget[],
): string | undefined {
    const workspace = entry.provenance?.workspace;
    if (!workspace) return undefined;
    const cwd = entry.provenance?.process?.cwd ?? workspace.path;
    const command = entry.provenance?.process?.command?.trim();
    const matches = runTargets.filter(target => 'declaration' in target && target.workspace.machineId === entry.machineId
        && (!workspace.id || target.workspace.workspaceId === workspace.id)
        && isWorkspacePathWithin(target.workspace.rootPath, workspace.path)
        && isWorkspacePathWithin(workspace.path, target.workspace.rootPath)
        && isWorkspacePathWithin(target.cwd, cwd) && target.displayMatch
        && (target.displayMatch.port === entry.port
            || command && target.displayMatch.command?.trim() === command));
    // A shared port/command is not enough to choose between two declarations.
    const [match] = matches;
    return matches.length === 1 && match && 'declaration' in match ? formatLocalServiceLauncherTitle(match.title) : undefined;
}

function hostMatchesCandidate(host: string, candidateHost: string): boolean {
    const normalizedHost = host.toLowerCase().replace(/^\[|\]$/gu, '');
    const normalizedCandidateHost = candidateHost.toLowerCase().replace(/^\[|\]$/gu, '');
    return normalizedHost === normalizedCandidateHost
        || (normalizedHost === 'localhost' && (normalizedCandidateHost === '127.0.0.1' || normalizedCandidateHost === '::1'))
        || (normalizedCandidateHost === 'localhost' && (normalizedHost === '127.0.0.1' || normalizedHost === '::1'));
}

function terminalUrlCandidateMatchesInventoryEntry(
    candidate: LocalServiceTerminalUrlLaunchCandidate,
    entry: NormalizedLocalServiceInventoryEntry,
): boolean {
    return typeof candidate.port === 'number'
        && candidate.port === entry.port
        && (!candidate.host || hostMatchesCandidate(entry.address.host, candidate.host));
}

function targetFromTerminalUrlCandidate(
    candidate: LocalServiceTerminalUrlLaunchCandidate,
    machineId: string,
): LocalServiceLaunchTargetV1 {
    return {
        id: `terminal-url:${candidate.sourceId}`,
        source: 'terminal_url',
        sourceClass: {
            kind: 'terminal_url',
            sourceId: candidate.sourceId,
            addressLabel: candidate.addressLabel,
            ...(candidate.host ? { host: candidate.host } : {}),
            ...(typeof candidate.port === 'number' ? { port: candidate.port } : {}),
        },
        machineId,
        ...(candidate.workspaceId ? { workspaceId: candidate.workspaceId } : {}),
        ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
        title: candidate.title ?? candidate.addressLabel,
        subtitle: candidate.addressLabel,
        kind: candidate.kind ?? 'terminal_url',
        confidence: candidate.confidence ?? 'low',
        state: 'unavailable',
        unavailableReason: 'terminal_url_unresolved',
        actions: [],
    };
}

function targetFromWorkspaceFileAssetCandidate(
    candidate: LocalServiceWorkspaceFileAssetLaunchCandidate,
    machineId: string,
): LocalServiceLaunchTargetV1 {
    return {
        id: `workspace-file-asset:${candidate.assetRef}`,
        source: 'workspace_file_asset',
        sourceClass: {
            kind: 'workspace_file_asset',
            sourceId: candidate.sourceId,
            assetRef: candidate.assetRef,
            ...(candidate.mediaType ? { mediaType: candidate.mediaType } : {}),
        },
        machineId,
        ...(candidate.workspaceId ? { workspaceId: candidate.workspaceId } : {}),
        ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
        title: candidate.title,
        subtitle: candidate.mediaType,
        kind: candidate.kind ?? 'workspace_file_asset',
        confidence: candidate.confidence ?? 'medium',
        state: 'unavailable',
        unavailableReason: 'workspace_file_asset_preview_unavailable',
        actions: [],
    };
}

function targetFromInventoryEntry(
    entry: NormalizedLocalServiceInventoryEntry,
    preview: LocalServicePreviewResourceV1 | undefined,
    terminateDetectedEnabled: boolean,
    declarationTitle?: string,
): LocalServiceLaunchTargetV1 {
    const attributedSessionId = entry.provenance?.session?.id;
    if (entry.state !== 'listening') {
        return {
            id: `inventory:${entry.id}`,
            source: 'inventory_entry',
            sourceClass: {
                kind: 'inventory_entry',
                inventoryEntryId: entry.id,
            },
            machineId: entry.machineId,
            ...(attributedSessionId ? { sessionId: attributedSessionId } : {}),
            title: declarationTitle ?? entryTitle(entry),
            subtitle: addressLabel(entry),
            kind: entry.classification?.kind,
            commandPreview: entryCommandPreview(entry),
            confidence: entry.confidence,
            state: 'unavailable',
            unavailableReason: entry.state === 'stale' ? 'stale_service' : 'service_not_listening',
            actions: [],
        };
    }

    // Every viewer resolves the resource through the same private-preview access owner.
    const browserTarget = preview ? preview.browserTarget ?? buildLocalServicePreviewBrowserTarget(preview) : undefined;

    const actions: LocalServiceLaunchTargetActionV1[] = preview
        ? ['open_preview', 'register_preview']
        : ['register_preview'];
    if (resolveLocalServiceActionEligibility({
        action: 'terminate_detected',
        target: { kind: 'inventory_entry', entry },
        terminateEnabled: terminateDetectedEnabled,
    }).enabled) {
        actions.push('terminate_detected');
    }

    return {
        id: `inventory:${entry.id}`,
        source: 'inventory_entry',
        sourceClass: {
            kind: 'inventory_entry',
            inventoryEntryId: entry.id,
        },
        machineId: entry.machineId,
        ...(attributedSessionId ? { sessionId: attributedSessionId } : {}),
        title: declarationTitle ?? entryTitle(entry),
        subtitle: addressLabel(entry),
        kind: entry.classification?.kind,
        cwd: entry.provenance?.process?.cwd,
        commandPreview: entryCommandPreview(entry),
        confidence: entry.confidence,
        state: 'available',
        actions,
        ...(browserTarget ? { browserTarget } : {}),
    };
}

function targetFromRunTarget(target: LocalServiceLauncherRunTarget, machineId: string): LocalServiceLaunchTargetV1 {
    if ('declaration' in target) {
        if (target.packageScript) {
            return { id: target.id, source: 'package_script',
                sourceClass: { kind: 'package_script', runTargetId: target.id, packageName: target.packageScript.packageName,
                    scriptName: target.packageScript.scriptName, cwd: target.cwd },
                machineId, cwd: target.cwd, workspaceId: target.workspaceId, workspace: target.workspace, declaration: target.declaration,
                title: formatLocalServiceLauncherTitle(target.title), subtitle: target.cwd, kind: 'package_script',
                commandPreview: `${target.packageScript.packageManager} run ${target.packageScript.scriptName}`,
                confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] };
        }
        const command = target.displayMatch?.command?.trim();
        return { id: target.id, source: 'managed_service', machineId, cwd: target.cwd,
            workspaceId: target.workspaceId, workspace: target.workspace, declaration: target.declaration, title: formatLocalServiceLauncherTitle(target.title),
            ...(command ? { commandPreview: clipLauncherText(command, LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH) } : {}),
            subtitle: target.cwd, confidence: 'high', state: 'unavailable',
            unavailableReason: 'launch_unavailable', actions: [] };
    }
    return {
        id: `package:${target.id}`,
        source: 'package_script',
        sourceClass: {
            kind: 'package_script',
            runTargetId: target.id,
            packageName: target.packageName,
            scriptName: target.scriptName,
            cwd: target.cwd,
        },
        machineId,
        cwd: target.cwd,
        title: `${target.packageName}:${target.scriptName}`,
        subtitle: target.cwd,
        kind: 'package_script',
        commandPreview: `${target.packageManager} run ${target.scriptName}`,
        confidence: 'medium',
        state: 'unavailable',
        unavailableReason: 'launch_unavailable',
        actions: [],
    };
}

function matchesWorkspaceScope(
    candidatePath: string | undefined,
    scopePaths: readonly string[] | undefined,
): boolean {
    if (!scopePaths || scopePaths.length === 0) return true;
    if (!candidatePath) return false;
    return scopePaths.some((scopePath) => isWorkspacePathWithin(scopePath, candidatePath));
}

export function localServiceInventoryEntryMatchesWorkspaceScope(
    entry: NormalizedLocalServiceInventoryEntry,
    scopePaths: readonly string[] | undefined,
): boolean {
    if (!scopePaths || scopePaths.length === 0) return true;
    const candidatePath = entry.provenance?.workspace?.path ?? entry.provenance?.process?.cwd;
    return matchesWorkspaceScope(candidatePath, scopePaths);
}

export function buildLocalServiceLauncherSnapshot(
    input: BuildLocalServiceLauncherSnapshotInput,
): LocalServiceLauncherSnapshotV1 {
    const scopePaths = input.workspaceScopePaths;
    const runTargets = input.runTargets.filter(target => matchesWorkspaceScope(target.cwd, scopePaths));
    const previews = [...input.previewResources].sort((a, b) => a.previewId.localeCompare(b.previewId));
    const inventoryEntries = [...input.inventoryEntries]
        .filter(isLocalServiceWebServerV1)
        .filter((entry) => localServiceInventoryEntryMatchesWorkspaceScope(entry, scopePaths))
        .sort((a, b) => a.port - b.port || a.id.localeCompare(b.id));
    const terminalUrlCandidates = [...(input.terminalUrlCandidates ?? [])].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const workspaceFileAssetCandidates = [...(input.workspaceFileAssetCandidates ?? [])].sort((a, b) => a.assetRef.localeCompare(b.assetRef));
    const targets: LocalServiceLaunchTargetV1[] = [];
    const availableInventoryEntries = inventoryEntries.filter((entry) => entry.state === 'listening');
    const unavailableInventoryEntries = inventoryEntries.filter((entry) => entry.state !== 'listening');
    const previewByEntry = new Map(inventoryEntries.map(entry => [entry.id,
        selectLocalServicePreviewForInventoryEntry(previews, entry, input.accountId)]));
    // Registration grants access; it is not evidence of a running Service. Only
    // inventory and the managed supervisor produce Services, and carry their preview.

    for (const entry of availableInventoryEntries) {
        const preview = previewByEntry.get(entry.id);
        targets.push(targetFromInventoryEntry(entry, preview, input.terminateDetectedEnabled === true,
            declarationTitleForEntry(entry, runTargets)));
    }

    for (const target of runTargets) {
        targets.push(targetFromRunTarget(target, input.machineId));
    }

    for (const candidate of terminalUrlCandidates) {
        const matchesCurrentTarget = availableInventoryEntries.some((entry) => terminalUrlCandidateMatchesInventoryEntry(candidate, entry));
        if (!matchesCurrentTarget) {
            targets.push(targetFromTerminalUrlCandidate(candidate, input.machineId));
        }
    }

    for (const candidate of workspaceFileAssetCandidates) {
        targets.push(targetFromWorkspaceFileAssetCandidate(candidate, input.machineId));
    }

    for (const entry of unavailableInventoryEntries) {
        const preview = previewByEntry.get(entry.id);
        targets.push(targetFromInventoryEntry(entry, preview, input.terminateDetectedEnabled === true,
            declarationTitleForEntry(entry, runTargets)));
    }

    return {
        v: 1,
        machineId: input.machineId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        updatedAt: input.updatedAt,
        targets,
    };
}
