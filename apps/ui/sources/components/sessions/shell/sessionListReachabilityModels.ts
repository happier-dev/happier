import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sessionTagKey } from './sessionTagUtils';
import type { SessionOrganizationLabel } from '@happier-dev/protocol';
import { resolveServerWorkspaceDisplay } from '@/sync/domains/session/organization/workspaceDisplay';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: 'head' | 'tail';
}>;

export type SessionListReachabilityModels = Readonly<{
    reachableSessionDisplayByKey: Map<string, SessionReachableDisplay>;
    hasMultipleMachines: boolean;
}>;

type SessionListReachabilityCacheEntry = Readonly<{
    activeServerId: string | null | undefined;
    display: SessionReachableDisplay;
    machineKey: string;
    machineDisplaySignature: string;
    session: Extract<SessionListViewItem, { type: 'session' }>['session'];
    serverId: string | null;
    workspaceKey: string;
    workspaceLabel: string | null;
}>;

type RetainedSessionListReachabilityModels = Readonly<{
    activeServerId: string | null | undefined;
    entriesByKey: Map<string, SessionListReachabilityCacheEntry>;
    machineDisplaySignature: string;
    models: SessionListReachabilityModels;
    previousKeys: readonly string[];
}>;

export type SessionListReachabilityModelsCache = {
    entriesByKey: Map<string, SessionListReachabilityCacheEntry>;
    previousKeys: readonly string[];
    previousModels: SessionListReachabilityModels | null;
};

const EMPTY_REACHABILITY_MODELS: SessionListReachabilityModels = {
    reachableSessionDisplayByKey: new Map<string, SessionReachableDisplay>(),
    hasMultipleMachines: false,
};

// Phone navigation can remount the list while its retained item projection remains alive.
// Keying the existing reachability cache by that owned projection lets the next hook instance
// recover the same derived model without resolving every display target again. Selected labels
// are checked by exact server; unrelated label or colour changes preserve the retained model.
const retainedReachabilityModelsByItems = new WeakMap<
    ReadonlyArray<SessionListViewItem>,
    RetainedSessionListReachabilityModels
>();

function areSelectedWorkspaceLabelsEqual(
    entries: ReadonlyMap<string, SessionListReachabilityCacheEntry>,
    labels: Readonly<Record<string, SessionOrganizationLabel>>,
): boolean {
    for (const entry of entries.values()) {
        if (resolveServerWorkspaceDisplay(labels, entry.serverId, entry.workspaceKey).label !== entry.workspaceLabel) return false;
    }
    return true;
}

export function createSessionListReachabilityModelsCache(): SessionListReachabilityModelsCache {
    return {
        entriesByKey: new Map<string, SessionListReachabilityCacheEntry>(),
        previousKeys: [],
        previousModels: null,
    };
}

function resolveReachableDisplayRowKey(item: Extract<SessionListViewItem, { type: 'session' }>): string {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionId = String(item.session.id);
    return serverId ? sessionTagKey(serverId, sessionId) : sessionId;
}

function resolveMachineKey(display: SessionReachableDisplay): string {
    return display.machineId ?? display.machineLabel ?? '';
}

function buildReachabilityMachineDisplaySignature(machines: Readonly<Record<string, MachineDisplayRenderable>>): string {
    // Display target resolution follows replacement links; workspace presentation reads
    // names and home directories. Presence/heartbeat timestamps affect neither. Keep
    // this cache key local to display derivation, not the machine's live status projection.
    return JSON.stringify(Object.keys(machines).sort().map((key) => {
        const machine = machines[key];
        return [key, machine.id, machine.replacedByMachineId ?? null,
            machine.metadata?.displayName ?? null, machine.metadata?.host ?? null,
            machine.metadata?.homeDir ?? null];
    }));
}

function buildSessionReachableDisplay(input: Readonly<{
    item: Extract<SessionListViewItem, { type: 'session' }>;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsByLabelKey: Readonly<Record<string, SessionOrganizationLabel>>;
}>): Readonly<{
    display: SessionReachableDisplay;
    machineKey: string;
    workspaceKey: string;
    workspaceLabel: string | null;
}> {
    const target = readDisplayMachineTargetForSession({
        sessionId: input.item.session.id,
        serverId: input.item.serverId,
        metadata: input.item.session?.metadata ?? null,
    });
    const workspace = resolveSessionWorkspacePresentation({
        metadata: input.item.session?.metadata ?? null,
        machines: input.machinesById,
        target,
    });
    const { label } = resolveServerWorkspaceDisplay(input.workspaceLabelsByLabelKey, input.item.serverId, workspace.workspaceKey);
    const display = {
        machineId: workspace.machineId,
        machineLabel: workspace.machineLabel,
        workspaceSubtitle: label ?? workspace.displayTitle,
        workspaceSubtitleEllipsizeMode: label ? 'tail' : 'head',
    } satisfies SessionReachableDisplay;

    return {
        display,
        machineKey: resolveMachineKey(display),
        workspaceKey: workspace.workspaceKey,
        workspaceLabel: label,
    };
}

function canReuseReachabilityEntry(input: Readonly<{
    activeServerId?: string | null;
    cached: SessionListReachabilityCacheEntry | undefined;
    item: Extract<SessionListViewItem, { type: 'session' }>;
    machineDisplaySignature: string;
    workspaceLabelsByLabelKey: Readonly<Record<string, SessionOrganizationLabel>>;
}>): boolean {
    return input.cached != null
        && input.cached.activeServerId === input.activeServerId
        && input.cached.session === input.item.session
        && input.cached.machineDisplaySignature === input.machineDisplaySignature
        && input.cached.workspaceLabel === resolveServerWorkspaceDisplay(input.workspaceLabelsByLabelKey,
            input.item.serverId, input.cached.workspaceKey).label;
}

function areReachabilityModelKeysAndDisplaysEqual(input: Readonly<{
    previousKeys: readonly string[];
    previousModels: SessionListReachabilityModels | null;
    nextKeys: readonly string[];
    nextDisplayByKey: ReadonlyMap<string, SessionReachableDisplay>;
}>): boolean {
    if (!input.previousModels) return false;
    if (input.previousKeys.length !== input.nextKeys.length) return false;
    for (let index = 0; index < input.nextKeys.length; index += 1) {
        const key = input.nextKeys[index];
        if (input.previousKeys[index] !== key) return false;
        if (input.previousModels.reachableSessionDisplayByKey.get(key) !== input.nextDisplayByKey.get(key)) {
            return false;
        }
    }
    return true;
}

export function buildSessionListReachabilityModels(input: Readonly<{
    /** The hook supplies the canonical active Home because it owns access to active overlays. */
    activeServerId?: string | null;
    items: ReadonlyArray<SessionListViewItem> | null | undefined;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsByLabelKey: Readonly<Record<string, SessionOrganizationLabel>>;
    cache?: SessionListReachabilityModelsCache;
}>): SessionListReachabilityModels {
    const items = input.items;
    if (!items || items.length === 0) {
        if (input.cache) {
            input.cache.entriesByKey = new Map();
            input.cache.previousKeys = [];
            input.cache.previousModels = EMPTY_REACHABILITY_MODELS;
        }
        return EMPTY_REACHABILITY_MODELS;
    }

    const machineDisplaySignature = buildReachabilityMachineDisplaySignature(input.machinesById);
    const retained = retainedReachabilityModelsByItems.get(items);
    if (
        input.cache
        && retained
        && retained.activeServerId === input.activeServerId
        && retained.machineDisplaySignature === machineDisplaySignature
        && areSelectedWorkspaceLabelsEqual(retained.entriesByKey, input.workspaceLabelsByLabelKey)
    ) {
        input.cache.entriesByKey = retained.entriesByKey;
        input.cache.previousKeys = retained.previousKeys;
        input.cache.previousModels = retained.models;
        return retained.models;
    }

    const reachableSessionDisplayByKey = new Map<string, SessionReachableDisplay>();
    const machineIds = new Set<string>();
    const nextCacheEntriesByKey = input.cache ? new Map<string, SessionListReachabilityCacheEntry>() : null;
    const nextKeys: string[] = [];

    for (const item of items) {
        if (item.type !== 'session') continue;
        const key = resolveReachableDisplayRowKey(item);
        const cached = input.cache?.entriesByKey.get(key);
        const canReuse = canReuseReachabilityEntry({
            activeServerId: input.activeServerId,
            cached,
            item,
            machineDisplaySignature,
            workspaceLabelsByLabelKey: input.workspaceLabelsByLabelKey,
        });
        const entry: SessionListReachabilityCacheEntry = canReuse && cached
            ? cached
            : (() => {
                const result = buildSessionReachableDisplay({
                    item,
                    machinesById: input.machinesById,
                    workspaceLabelsByLabelKey: input.workspaceLabelsByLabelKey,
                });
                return {
                    activeServerId: input.activeServerId,
                    display: result.display,
                    machineKey: result.machineKey,
                    machineDisplaySignature,
                    session: item.session,
                    serverId: item.serverId?.trim() || null,
                    workspaceKey: result.workspaceKey,
                    workspaceLabel: result.workspaceLabel,
                } satisfies SessionListReachabilityCacheEntry;
            })();

        reachableSessionDisplayByKey.set(key, entry.display);
        nextCacheEntriesByKey?.set(key, entry);
        nextKeys.push(key);
        if (entry.machineKey) machineIds.add(entry.machineKey);
    }

    if (reachableSessionDisplayByKey.size === 0) {
        if (input.cache) {
            input.cache.entriesByKey = new Map();
            input.cache.previousKeys = [];
            input.cache.previousModels = EMPTY_REACHABILITY_MODELS;
        }
        return EMPTY_REACHABILITY_MODELS;
    }

    if (input.cache) {
        if (areReachabilityModelKeysAndDisplaysEqual({
            previousKeys: input.cache.previousKeys,
            previousModels: input.cache.previousModels,
            nextKeys,
            nextDisplayByKey: reachableSessionDisplayByKey,
        })) {
            if (nextCacheEntriesByKey) input.cache.entriesByKey = nextCacheEntriesByKey;
            return input.cache.previousModels as SessionListReachabilityModels;
        }
    }

    const models = {
        reachableSessionDisplayByKey,
        hasMultipleMachines: machineIds.size > 1,
    } satisfies SessionListReachabilityModels;

    if (input.cache) {
        if (nextCacheEntriesByKey) input.cache.entriesByKey = nextCacheEntriesByKey;
        input.cache.previousKeys = nextKeys;
        input.cache.previousModels = models;
        retainedReachabilityModelsByItems.set(items, {
            activeServerId: input.activeServerId,
            entriesByKey: input.cache.entriesByKey,
            machineDisplaySignature,
            models,
            previousKeys: nextKeys,
        });
    }

    return models;
}
