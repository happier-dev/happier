import type {
    BrowserExternalUrlTargetV1,
    BrowserHttpUrlV1,
    BrowserLocalServicePreviewTargetV1,
    LocalServiceLauncherSnapshotV1,
    LocalServiceLaunchTargetActionV1,
    LocalServiceLaunchTargetV1,
    LocalServicePreviewResourceV1,
} from '@happier-dev/protocol';
import { BrowserHttpUrlV1Schema } from '@happier-dev/protocol';

import type { LocalServiceRunTarget } from '../managed/scripts';
import type { ManagedLocalServiceRuntimeState } from '../managed/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { buildLocalServiceEndpointUrl } from '../inventory/endpoint';
import { isWorkspacePathWithin } from '../inventory/provenance';
import { resolveLocalServiceActionEligibility } from '../actions/policy';

export type BuildLocalServiceLauncherSnapshotInput = Readonly<{
    machineId: string;
    sessionId?: string;
    /**
     * Workspace-PATH scope (D1). When present, inventory entries and run-targets are
     * kept only when their workspace path / cwd matches one of these paths. Scope is by
     * PATH, never by session: a service started by another session in the same workspace
     * stays visible. Absent → no scoping (full machine view).
     */
    workspaceScopePaths?: readonly string[];
    updatedAt: number;
    runTargets: readonly LocalServiceRunTarget[];
    inventoryEntries: readonly NormalizedLocalServiceInventoryEntry[];
    managedServices: readonly ManagedLocalServiceRuntimeState[];
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
    const command = entry.provenance?.process?.command;
    return command && command !== 'unknown' ? command : undefined;
}

function previewMatchesEntry(
    preview: LocalServicePreviewResourceV1,
    entry: NormalizedLocalServiceInventoryEntry,
): boolean {
    if (preview.machineId !== entry.machineId) return false;
    if (preview.target.port !== entry.port) return false;
    const host = preview.target.host.toLowerCase();
    const entryHost = entry.address.host.toLowerCase().replace(/^\[|\]$/gu, '');
    return host === entryHost
        || (entry.address.kind === 'wildcard' && (host === '127.0.0.1' || host === 'localhost' || host === '::1'))
        || (entry.address.kind === 'loopback' && host === 'localhost');
}

function hostMatchesCandidate(host: string, candidateHost: string): boolean {
    const normalizedHost = host.toLowerCase().replace(/^\[|\]$/gu, '');
    const normalizedCandidateHost = candidateHost.toLowerCase().replace(/^\[|\]$/gu, '');
    return normalizedHost === normalizedCandidateHost
        || (normalizedHost === 'localhost' && (normalizedCandidateHost === '127.0.0.1' || normalizedCandidateHost === '::1'))
        || (normalizedCandidateHost === 'localhost' && (normalizedHost === '127.0.0.1' || normalizedHost === '::1'));
}

function terminalUrlCandidateMatchesPreview(
    candidate: LocalServiceTerminalUrlLaunchCandidate,
    preview: LocalServicePreviewResourceV1,
): boolean {
    return typeof candidate.port === 'number'
        && candidate.port === preview.target.port
        && (!candidate.host || hostMatchesCandidate(preview.target.host, candidate.host));
}

function terminalUrlCandidateMatchesInventoryEntry(
    candidate: LocalServiceTerminalUrlLaunchCandidate,
    entry: NormalizedLocalServiceInventoryEntry,
): boolean {
    return typeof candidate.port === 'number'
        && candidate.port === entry.port
        && (!candidate.host || hostMatchesCandidate(entry.address.host, candidate.host));
}

/**
 * The ONE loopback-origin URL authority. The scanner owns scheme detection; callers
 * consume the endpoint fact instead of guessing `http://localhost:${port}`.
 */
function loopbackServiceUrl(entry: NormalizedLocalServiceInventoryEntry): BrowserHttpUrlV1 | null {
    const url = entry.endpoint ? buildLocalServiceEndpointUrl(entry.endpoint) : null;
    if (!url) return null;
    const parsed = BrowserHttpUrlV1Schema.safeParse(url);
    return parsed.success ? parsed.data : null;
}

function entryHasLoopbackPreviewCandidate(entry: NormalizedLocalServiceInventoryEntry): boolean {
    return entry.address.kind === 'loopback' || entry.address.kind === 'wildcard';
}

function loopbackExternalUrlTarget(
    entry: NormalizedLocalServiceInventoryEntry,
): BrowserExternalUrlTargetV1 | null {
    const url = loopbackServiceUrl(entry); // ONE URL authority (IPv6/wildcard/scheme-safe)
    if (!url) return null; // not loopback/wildcard, or unbuildable
    return {
        kind: 'externalUrl',
        targetId: `inventory-loopback:${entry.id}`,
        url,
        display: { title: entryTitle(entry), addressLabel: addressLabel(entry) },
    };
}

function browserTargetForPreview(preview: LocalServicePreviewResourceV1): BrowserLocalServicePreviewTargetV1 {
    return preview.browserTarget ?? {
        kind: 'localServicePreview',
        targetId: preview.previewId,
        sessionId: preview.sessionId,
        machineId: preview.machineId,
        display: {
            title: preview.display.title,
            addressLabel: preview.display.addressLabel,
            folderLabel: preview.display.folderLabel,
            iconToken: preview.display.iconToken,
            tone: preview.display.tone,
        },
    };
}

function targetFromTerminalUrlCandidate(
    candidate: LocalServiceTerminalUrlLaunchCandidate,
    machineId: string,
    sessionId: string | undefined,
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
        ...(sessionId ? { sessionId } : {}),
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
    sessionId: string | undefined,
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
        ...(sessionId ? { sessionId } : {}),
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

function targetFromPreview(preview: LocalServicePreviewResourceV1): LocalServiceLaunchTargetV1 {
    return {
        id: `preview:${preview.previewId}`,
        source: 'registered_preview',
        sourceClass: {
            kind: 'registered_preview',
            previewId: preview.previewId,
        },
        machineId: preview.machineId,
        sessionId: preview.sessionId,
        title: preview.display.title,
        subtitle: preview.display.addressLabel,
        kind: preview.display.iconToken,
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: browserTargetForPreview(preview),
    };
}

function targetFromInventoryEntry(
    entry: NormalizedLocalServiceInventoryEntry,
    preview: LocalServicePreviewResourceV1 | undefined,
    sessionId: string | undefined,
    terminateDetectedEnabled: boolean,
): LocalServiceLaunchTargetV1 {
    // Attribution passthrough (D1): a terminal-registered entry carries its originating
    // session id on its provenance. Project that onto the target's sessionId so the UI
    // can group "this session" first. Fall back to the request session for un-attributed
    // entries (preserves prior behavior).
    const attributedSessionId = entry.provenance?.session?.id ?? sessionId;
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
            title: entryTitle(entry),
            subtitle: addressLabel(entry),
            kind: entry.classification?.kind,
            commandPreview: entryCommandPreview(entry),
            confidence: entry.confidence,
            state: 'unavailable',
            unavailableReason: entry.state === 'stale' ? 'stale_service' : 'service_not_listening',
            actions: [],
        };
    }

    // Local-open path (S-RC2): when there is no preview but a loopback target can be
    // formed, attach an externalUrl loopback target and advertise `open` — independent of
    // preview registration / exposure gating. Non-loopback entries stay register_preview only.
    const endpointUnknownReason = !preview
        && entryHasLoopbackPreviewCandidate(entry)
        && (!entry.endpoint || entry.endpoint.scheme === 'unknown')
        ? 'endpoint_scheme_unknown'
        : null;
    const loopbackTarget = preview ? undefined : loopbackExternalUrlTarget(entry);
    const browserTarget = preview ? browserTargetForPreview(preview) : loopbackTarget ?? undefined;

    const actions: LocalServiceLaunchTargetActionV1[] = preview
        ? ['open_preview', 'register_preview']
        : loopbackTarget ? ['open'] : endpointUnknownReason ? [] : ['register_preview'];
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
        title: entryTitle(entry),
        subtitle: addressLabel(entry),
        kind: entry.classification?.kind,
        cwd: entry.provenance?.process?.cwd,
        commandPreview: entryCommandPreview(entry),
        confidence: entry.confidence,
        state: 'available',
        ...(endpointUnknownReason ? { unavailableReason: endpointUnknownReason } : {}),
        actions,
        ...(browserTarget ? { browserTarget } : {}),
    };
}

function targetFromRunTarget(target: LocalServiceRunTarget, machineId: string, sessionId: string | undefined): LocalServiceLaunchTargetV1 {
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
        ...(sessionId ? { sessionId } : {}),
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

function targetFromManagedService(service: ManagedLocalServiceRuntimeState, machineId: string, sessionId: string | undefined): LocalServiceLaunchTargetV1 {
    const available = service.phase === 'running';
    const unavailable = service.phase === 'stopped' || service.phase === 'failed';
    return {
        id: `managed:${service.id}`,
        source: 'managed_service',
        sourceClass: {
            kind: 'managed_service',
            managedServiceId: service.id,
            ...(service.inventoryId ? { inventoryEntryId: service.inventoryId } : {}),
        },
        machineId,
        ...(sessionId ? { sessionId } : {}),
        title: service.routeName,
        subtitle: service.port ? `localhost:${service.port}` : undefined,
        confidence: service.minimumConfidence,
        state: available ? 'available' : unavailable ? 'unavailable' : 'starting',
        ...(unavailable ? { unavailableReason: `managed_${service.phase}` } : {}),
        actions: available ? ['manage'] : [],
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

function entryMatchesWorkspaceScope(
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
    const previews = [...input.previewResources].sort((a, b) => a.previewId.localeCompare(b.previewId));
    const inventoryEntries = [...input.inventoryEntries]
        .filter((entry) => entryMatchesWorkspaceScope(entry, scopePaths))
        .sort((a, b) => a.port - b.port || a.id.localeCompare(b.id));
    const terminalUrlCandidates = [...(input.terminalUrlCandidates ?? [])].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const workspaceFileAssetCandidates = [...(input.workspaceFileAssetCandidates ?? [])].sort((a, b) => a.assetRef.localeCompare(b.assetRef));
    const inventoryIds = new Set(input.inventoryEntries.map((entry) => entry.id));
    const targets: LocalServiceLaunchTargetV1[] = [];

    for (const preview of previews) {
        targets.push(targetFromPreview(preview));
    }

    const availableInventoryEntries = inventoryEntries.filter((entry) => entry.state === 'listening');
    const unavailableInventoryEntries = inventoryEntries.filter((entry) => entry.state !== 'listening');

    for (const entry of availableInventoryEntries) {
        const preview = previews.find((candidate) => previewMatchesEntry(candidate, entry));
        targets.push(targetFromInventoryEntry(entry, preview, input.sessionId, input.terminateDetectedEnabled === true));
    }

    for (const target of input.runTargets) {
        if (!matchesWorkspaceScope(target.cwd, scopePaths)) continue;
        targets.push(targetFromRunTarget(target, input.machineId, input.sessionId));
    }

    for (const candidate of terminalUrlCandidates) {
        const matchesCurrentTarget = previews.some((preview) => terminalUrlCandidateMatchesPreview(candidate, preview))
            || availableInventoryEntries.some((entry) => terminalUrlCandidateMatchesInventoryEntry(candidate, entry));
        if (!matchesCurrentTarget) {
            targets.push(targetFromTerminalUrlCandidate(candidate, input.machineId, input.sessionId));
        }
    }

    for (const candidate of workspaceFileAssetCandidates) {
        targets.push(targetFromWorkspaceFileAssetCandidate(candidate, input.machineId, input.sessionId));
    }

    for (const entry of unavailableInventoryEntries) {
        const preview = previews.find((candidate) => previewMatchesEntry(candidate, entry));
        targets.push(targetFromInventoryEntry(entry, preview, input.sessionId, input.terminateDetectedEnabled === true));
    }

    for (const service of input.managedServices) {
        if (service.inventoryId && inventoryIds.has(service.inventoryId)) {
            continue;
        }
        targets.push(targetFromManagedService(service, input.machineId, input.sessionId));
    }

    return {
        v: 1,
        machineId: input.machineId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        updatedAt: input.updatedAt,
        targets,
    };
}
