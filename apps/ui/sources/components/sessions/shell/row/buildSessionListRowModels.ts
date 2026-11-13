import type {
    SessionListRowModel,
    SessionListRowPresentationSettings,
    SessionListRowSessionItem,
    SessionListRowStateSnapshot,
} from './sessionListRowModelTypes';
import { buildSessionListRowModel } from './buildSessionListRowModel';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { areSessionListRenderablesEqual } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    resolveSessionAttentionStanding,
    resolveSessionReminderPresentation,
} from '@/sync/domains/session/organization/attentionStanding';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { sessionTagKey } from '../sessionTagUtils';
import { areSessionAppearanceColorsEqual, sessionAppearanceColorKey } from '@/sync/domains/session/organization/appearanceColor';
import { READABLE_SESSION_ROLES, SessionRoleProfilesV1Schema } from '@happier-dev/protocol';

type CacheEntry = Readonly<{
    model: SessionListRowModel;
    inputSignature: string;
    itemRef: SessionListRowSessionItem;
    adjacency: Readonly<{ isFirst: boolean; isLast: boolean; isSingle: boolean }>;
    stableSettings: StablePresentationSettingsRefs;
    itemSessionRef: SessionListRowSessionItem['session'];
    sessionRef: SessionListRowStateSnapshot['session'];
    renderableRef: SessionListRowStateSnapshot['renderable'];
    messagesRef: SessionListRowStateSnapshot['messages'];
    pendingRef: SessionListRowStateSnapshot['pending'];
    draftPreview: string | null;
}>;

export type SessionListRowModelsCache = {
    entries: Map<string, CacheEntry>;
};

export type SessionListRowModelAdjacency = Readonly<{
    isFirst: boolean;
    isLast: boolean;
    isSingle: boolean;
}>;

const SESSION_LIST_ROW_MODEL_ADJACENCY_VALUES: ReadonlyArray<SessionListRowModelAdjacency> = Object.freeze([
    Object.freeze({ isFirst: false, isLast: false, isSingle: false }),
    Object.freeze({ isFirst: true, isLast: false, isSingle: false }),
    Object.freeze({ isFirst: false, isLast: true, isSingle: false }),
    Object.freeze({ isFirst: true, isLast: true, isSingle: true }),
]);

const SESSION_ROLE_PROFILES_DISPLAY_SIGNATURES = new WeakMap<object, string>();

type StablePresentationSettingsRefs = Readonly<{
    currentUserId: SessionListRowPresentationSettings['currentUserId'];
    sessionRoleProfilesV1: SessionListRowPresentationSettings['sessionRoleProfilesV1'];
    density: SessionListRowPresentationSettings['density'];
    baseDensity: SessionListRowPresentationSettings['baseDensity'];
    lineageAppearanceEnabled: SessionListRowPresentationSettings['lineageAppearanceEnabled'];
    lineageAppearancePresets: SessionListRowPresentationSettings['lineageAppearancePresets'];
    compact: SessionListRowPresentationSettings['compact'];
    compactMinimal: SessionListRowPresentationSettings['compactMinimal'];
    identityDisplay: SessionListRowPresentationSettings['identityDisplay'];
    appearancePresentationSupported: SessionListRowPresentationSettings['appearancePresentationSupported'];
    activeColorMode: SessionListRowPresentationSettings['activeColorMode'];
    workingIndicatorMode: SessionListRowPresentationSettings['workingIndicatorMode'];
    workingTextMode: SessionListRowPresentationSettings['workingTextMode'];
    backgroundWorkAttentionMode: SessionListRowPresentationSettings['backgroundWorkAttentionMode'];
    hideInactiveSessions: SessionListRowPresentationSettings['hideInactiveSessions'];
    showServerBadge: SessionListRowPresentationSettings['showServerBadge'];
    showPinnedServerBadge: SessionListRowPresentationSettings['showPinnedServerBadge'];
    agentActivityCountEnabled: SessionListRowPresentationSettings['agentActivityCountEnabled'];
    tagsEnabled: SessionListRowPresentationSettings['tagsEnabled'];
    sessionTagsByKey: SessionListRowPresentationSettings['sessionTagsByKey'];
    allKnownTags: SessionListRowPresentationSettings['allKnownTags'];
    pinnedSessionKeys: SessionListRowPresentationSettings['pinnedSessionKeys'];
    attentionStandingEnabled: SessionListRowPresentationSettings['attentionStandingEnabled'];
    attentionStandingPolicy: SessionListRowPresentationSettings['attentionStandingPolicy'];
    hasMultipleMachines: SessionListRowPresentationSettings['hasMultipleMachines'];
    reachableSessionDisplayByKey: SessionListRowPresentationSettings['reachableSessionDisplayByKey'];
    folderViewEnabled: SessionListRowPresentationSettings['folderViewEnabled'];
    statusColors: SessionListRowPresentationSettings['statusColors'];
}>;

export type BuildCachedSessionListRowModelInput = Readonly<{
    item: SessionListRowSessionItem;
    snapshot: SessionListRowStateSnapshot;
    adjacency: Readonly<{ isFirst: boolean; isLast: boolean; isSingle: boolean }>;
    settings: SessionListRowPresentationSettings;
    cache: SessionListRowModelsCache;
}>;

export function createSessionListRowModelsCache(): SessionListRowModelsCache {
    return { entries: new Map() };
}

function isSessionItem(item: SessionListViewItem): item is SessionListRowSessionItem {
    return item.type === 'session';
}

function appendSignaturePart(parts: string[], value: unknown): void {
    const normalized = value == null ? '' : String(value);
    parts.push(`${normalized.length}:${normalized}`);
}

function appendSignatureList(parts: string[], values: readonly unknown[]): void {
    appendSignaturePart(parts, values.length);
    for (const value of values) {
        appendSignaturePart(parts, value);
    }
}

function resolveSessionRoleProfilesDisplaySignature(
    profiles: SessionListRowPresentationSettings['sessionRoleProfilesV1'],
): string {
    if (!profiles) return '';
    const cached = SESSION_ROLE_PROFILES_DISPLAY_SIGNATURES.get(profiles);
    if (cached !== undefined) return cached;

    const parsed = SessionRoleProfilesV1Schema.safeParse(profiles);
    const parts: string[] = [];
    if (parsed.success) {
        for (const role of READABLE_SESSION_ROLES) {
            appendSignaturePart(parts, parsed.data.displayNamesByRole?.[role]);
            appendSignaturePart(parts, parsed.data.colorsByRole?.[role]);
        }
        const customRoles = parsed.data.customRoles ?? [];
        appendSignaturePart(parts, customRoles.length);
        for (const role of customRoles) {
            appendSignaturePart(parts, role.id);
            appendSignaturePart(parts, role.name);
            appendSignaturePart(parts, role.color);
        }
    }
    const signature = parts.join('|');
    SESSION_ROLE_PROFILES_DISPLAY_SIGNATURES.set(profiles, signature);
    return signature;
}

function normalizeServerId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function resolveRowKey(item: SessionListRowSessionItem): string {
    const sessionId = String(item.session.id);
    const serverId = normalizeServerId(item.serverId);
    return serverId ? sessionTagKey(serverId, sessionId) : sessionId;
}

function buildStablePresentationSettingsRefs(
    settings: SessionListRowPresentationSettings,
): StablePresentationSettingsRefs {
    return {
        currentUserId: settings.currentUserId,
        sessionRoleProfilesV1: settings.sessionRoleProfilesV1,
        density: settings.density,
        baseDensity: settings.baseDensity,
        lineageAppearanceEnabled: settings.lineageAppearanceEnabled,
        lineageAppearancePresets: settings.lineageAppearancePresets,
        compact: settings.compact,
        compactMinimal: settings.compactMinimal,
        identityDisplay: settings.identityDisplay,
        appearancePresentationSupported: settings.appearancePresentationSupported,
        activeColorMode: settings.activeColorMode,
        workingIndicatorMode: settings.workingIndicatorMode,
        workingTextMode: settings.workingTextMode,
        backgroundWorkAttentionMode: settings.backgroundWorkAttentionMode,
        hideInactiveSessions: settings.hideInactiveSessions,
        showServerBadge: settings.showServerBadge,
        showPinnedServerBadge: settings.showPinnedServerBadge,
        agentActivityCountEnabled: settings.agentActivityCountEnabled,
        tagsEnabled: settings.tagsEnabled,
        sessionTagsByKey: settings.sessionTagsByKey,
        allKnownTags: settings.allKnownTags,
        pinnedSessionKeys: settings.pinnedSessionKeys,
        attentionStandingEnabled: settings.attentionStandingEnabled,
        attentionStandingPolicy: settings.attentionStandingPolicy,
        hasMultipleMachines: settings.hasMultipleMachines,
        reachableSessionDisplayByKey: settings.reachableSessionDisplayByKey,
        folderViewEnabled: settings.folderViewEnabled,
        statusColors: settings.statusColors,
    };
}

function areStablePresentationSettingsRefsEqual(
    previous: StablePresentationSettingsRefs,
    next: StablePresentationSettingsRefs,
): boolean {
    return previous.currentUserId === next.currentUserId
        && previous.sessionRoleProfilesV1 === next.sessionRoleProfilesV1
        && previous.density === next.density
        && previous.baseDensity === next.baseDensity
        && previous.lineageAppearanceEnabled === next.lineageAppearanceEnabled
        && previous.lineageAppearancePresets === next.lineageAppearancePresets
        && previous.compact === next.compact
        && previous.compactMinimal === next.compactMinimal
        && previous.identityDisplay === next.identityDisplay
        && previous.appearancePresentationSupported === next.appearancePresentationSupported
        && previous.activeColorMode === next.activeColorMode
        && previous.workingIndicatorMode === next.workingIndicatorMode
        && previous.workingTextMode === next.workingTextMode
        && previous.backgroundWorkAttentionMode === next.backgroundWorkAttentionMode
        && previous.hideInactiveSessions === next.hideInactiveSessions
        && previous.showServerBadge === next.showServerBadge
        && previous.showPinnedServerBadge === next.showPinnedServerBadge
        && previous.agentActivityCountEnabled === next.agentActivityCountEnabled
        && previous.tagsEnabled === next.tagsEnabled
        && previous.sessionTagsByKey === next.sessionTagsByKey
        && previous.allKnownTags === next.allKnownTags
        && previous.pinnedSessionKeys === next.pinnedSessionKeys
        && previous.attentionStandingEnabled === next.attentionStandingEnabled
        && previous.attentionStandingPolicy === next.attentionStandingPolicy
        && previous.hasMultipleMachines === next.hasMultipleMachines
        && previous.reachableSessionDisplayByKey === next.reachableSessionDisplayByKey
        && previous.folderViewEnabled === next.folderViewEnabled
        && previous.statusColors === next.statusColors;
}

function buildInputSignature(input: Readonly<{
    item: SessionListRowSessionItem;
    rowKey: string;
    adjacency: Readonly<{ isFirst: boolean; isLast: boolean; isSingle: boolean }>;
    snapshot: SessionListRowStateSnapshot;
    settings: SessionListRowPresentationSettings;
}>): string {
    const { item, rowKey, settings } = input;
    const parts: string[] = [];
    const rowTags = settings.sessionTagsByKey[rowKey] ?? [];
    const reachableDisplay = settings.reachableSessionDisplayByKey[rowKey];
    appendSignaturePart(parts, rowKey);
    appendSignaturePart(parts, item.section);
    appendSignaturePart(parts, item.groupKey);
    appendSignaturePart(parts, item.groupKind);
    appendSignaturePart(parts, item.folderId);
    appendSignaturePart(parts, item.folderDepth);
    appendSignaturePart(parts, item.parentSessionId);
    appendSignaturePart(parts, item.nestingDepth);
    appendSignaturePart(parts, item.hasChildren);
    appendSignaturePart(parts, item.childrenCollapsed);
    appendSignaturePart(parts, item.identityOverride);
    appendSignaturePart(parts, item.pinned === true ? 1 : 0);
    appendSignaturePart(parts, (item as SessionListRowSessionItem & { selected?: boolean }).selected === true ? 1 : 0);
    // Placement reasons decide what the row SAYS about itself (why it is in the
    // attention band, whether its working indicator is paused), and promotion
    // within a group changes them while leaving every other input identical.
    appendSignaturePart(parts, item.attentionPromotionReason);
    appendSignaturePart(parts, item.workingPlacementReason);
    appendSignaturePart(parts, item.variant);
    appendSignaturePart(parts, item.session.archiving === true ? 1 : 0);
    appendSignaturePart(parts, item.serverId);
    appendSignaturePart(parts, item.serverName);
    appendSignaturePart(parts, input.adjacency.isFirst ? 1 : 0);
    appendSignaturePart(parts, input.adjacency.isLast ? 1 : 0);
    appendSignaturePart(parts, input.adjacency.isSingle ? 1 : 0);
    appendSignaturePart(parts, settings.currentUserId);
    appendSignaturePart(parts, resolveSessionRoleProfilesDisplaySignature(settings.sessionRoleProfilesV1));
    appendSignaturePart(parts, settings.density);
    appendSignaturePart(parts, settings.baseDensity);
    appendSignaturePart(parts, settings.lineageAppearanceEnabled ? 1 : 0);
    appendSignaturePart(parts, settings.lineageAppearancePresets?.parent?.density);
    appendSignaturePart(parts, settings.lineageAppearancePresets?.parent?.avatarStyle);
    appendSignaturePart(parts, settings.lineageAppearancePresets?.child?.density);
    appendSignaturePart(parts, settings.lineageAppearancePresets?.child?.avatarStyle);
    appendSignaturePart(parts, settings.compact ? 1 : 0);
    appendSignaturePart(parts, settings.compactMinimal ? 1 : 0);
    appendSignaturePart(parts, settings.identityDisplay);
    appendSignaturePart(parts, settings.appearancePresentationSupported ? 1 : 0);
    appendSignaturePart(parts, settings.activeColorMode);
    appendSignaturePart(parts, settings.workingIndicatorMode);
    appendSignaturePart(parts, settings.workingTextMode);
    appendSignaturePart(parts, settings.backgroundWorkAttentionMode);
    appendSignaturePart(parts, settings.hideInactiveSessions ? 1 : 0);
    appendSignaturePart(parts, settings.showServerBadge ? 1 : 0);
    appendSignaturePart(parts, settings.showPinnedServerBadge ? 1 : 0);
    appendSignaturePart(parts, settings.agentActivityCountEnabled ? 1 : 0);
    appendSignaturePart(parts, settings.tagsEnabled ? 1 : 0);
    appendSignatureList(parts, rowTags);
    appendSignatureList(parts, settings.allKnownTags);
    appendSignaturePart(parts, settings.pinnedSessionKeys.includes(rowKey) ? 1 : 0);
    // Standing is resolved per row (an explicit override beats the account
    // default), so the signature carries the RESOLVED value rather than the
    // policy: a row whose standing did not change must not rebuild when an
    // unrelated session's override lands.
    appendSignaturePart(parts, settings.attentionStandingEnabled ? 1 : 0);
    appendSignaturePart(parts, resolveSessionAttentionStanding(settings.attentionStandingPolicy, rowKey, settings.runtimeNowMs) ? 1 : 0);
    const reminder = resolveSessionReminderPresentation(
        settings.attentionStandingPolicy.overridesBySessionKey[rowKey],
        settings.runtimeNowMs,
    );
    appendSignaturePart(parts, reminder?.state);
    appendSignaturePart(parts, reminder?.remindAt);
    appendSignaturePart(parts, settings.hasMultipleMachines ? 1 : 0);
    appendSignaturePart(parts, reachableDisplay?.workspaceSubtitle);
    appendSignaturePart(parts, reachableDisplay?.machineLabel);
    appendSignaturePart(parts, reachableDisplay?.workspaceSubtitleEllipsizeMode);
    appendSignaturePart(parts, settings.folderViewEnabled ? 1 : 0);
    appendSignaturePart(parts, settings.statusColors.connected);
    appendSignaturePart(parts, settings.statusColors.connecting);
    appendSignaturePart(parts, settings.statusColors.actionRequired);
    appendSignaturePart(parts, settings.statusColors.disconnected);
    appendSignaturePart(parts, settings.statusColors.error);
    appendSignaturePart(parts, settings.statusColors.default);
    appendSignaturePart(parts, input.snapshot.messages?.messagesVersion ?? null);
    appendSignaturePart(parts, input.snapshot.pending?.messages.length ?? null);
    appendSignaturePart(parts, input.snapshot.draft?.preview ?? null);
    appendSignaturePart(parts, sessionAppearanceColorKey(input.snapshot.appearanceColor));
    return parts.join('|');
}

function isCachedActivityFresh(model: SessionListRowModel, relativeNowMs: number): boolean {
    const timestamp = model.activity.timestamp;
    if (typeof timestamp !== 'number' || timestamp <= 0) {
        return model.activity.label === '';
    }
    return formatShortRelativeTimeAt(timestamp, relativeNowMs) === model.activity.label;
}

function isCachedRuntimeFresh(model: SessionListRowModel, runtimeNowMs: number): boolean {
    const nextRuntimeFreshnessAtMs = model.nextRuntimeFreshnessAtMs;
    return nextRuntimeFreshnessAtMs === null || runtimeNowMs < nextRuntimeFreshnessAtMs;
}

function resolveCacheSessionRef(snapshot: SessionListRowStateSnapshot): SessionListRowStateSnapshot['session'] {
    return snapshot.renderable ? undefined : snapshot.session;
}

function canReuseItemSession(entry: CacheEntry, item: SessionListRowSessionItem): boolean {
    return entry.itemSessionRef === item.session
        || areSessionListRenderablesEqual(entry.itemSessionRef, item.session);
}

function canReuseEntry(
    entry: CacheEntry | undefined,
    snapshot: SessionListRowStateSnapshot,
    item: SessionListRowSessionItem,
    inputSignature: string,
    settings: SessionListRowPresentationSettings,
): entry is CacheEntry {
    return entry !== undefined
        && entry.inputSignature === inputSignature
        && canReuseItemSession(entry, item)
        && entry.sessionRef === resolveCacheSessionRef(snapshot)
        && entry.renderableRef === snapshot.renderable
        && entry.messagesRef === snapshot.messages
        && entry.pendingRef === snapshot.pending
        && entry.draftPreview === (snapshot.draft?.preview ?? null)
        && areSessionAppearanceColorsEqual(entry.model.appearanceColor, snapshot.appearanceColor)
        && isCachedActivityFresh(entry.model, settings.relativeNowMs)
        && isCachedRuntimeFresh(entry.model, settings.runtimeNowMs);
}

function canReuseEntryWithoutSignature(input: Readonly<{
    entry: CacheEntry;
    snapshot: SessionListRowStateSnapshot;
    item: SessionListRowSessionItem;
    adjacency: Readonly<{ isFirst: boolean; isLast: boolean; isSingle: boolean }>;
    settings: SessionListRowPresentationSettings;
    stableSettings: StablePresentationSettingsRefs;
}>): boolean {
    const entry = input.entry;
    return entry.itemRef === input.item
        && entry.adjacency.isFirst === input.adjacency.isFirst
        && entry.adjacency.isLast === input.adjacency.isLast
        && entry.adjacency.isSingle === input.adjacency.isSingle
        && entry.sessionRef === resolveCacheSessionRef(input.snapshot)
        && entry.renderableRef === input.snapshot.renderable
        && entry.messagesRef === input.snapshot.messages
        && entry.pendingRef === input.snapshot.pending
        && entry.draftPreview === (input.snapshot.draft?.preview ?? null)
        && areSessionAppearanceColorsEqual(entry.model.appearanceColor, input.snapshot.appearanceColor)
        && areStablePresentationSettingsRefsEqual(entry.stableSettings, input.stableSettings)
        && isCachedActivityFresh(entry.model, input.settings.relativeNowMs)
        && isCachedRuntimeFresh(entry.model, input.settings.runtimeNowMs);
}

export function resolveSessionListRowModelAdjacency(
    items: ReadonlyArray<SessionListViewItem>,
    index: number,
): SessionListRowModelAdjacency {
    const item = items[index];
    const prev = index > 0 ? items[index - 1] : null;
    const next = index < items.length - 1 ? items[index + 1] : null;
    const shareVisualGroup = (left: SessionListViewItem | null | undefined, right: SessionListViewItem | null | undefined): boolean => {
        if (!left || !right || !isSessionItem(left) || !isSessionItem(right)) return false;
        const leftGroupKey = String(left.groupKey ?? '').trim();
        const rightGroupKey = String(right.groupKey ?? '').trim();
        if (leftGroupKey && leftGroupKey === rightGroupKey) return true;
        const leftNestingDepth = Math.max(0, Math.trunc(left.nestingDepth ?? 0));
        const rightNestingDepth = Math.max(0, Math.trunc(right.nestingDepth ?? 0));
        // Placement emits each family as one depth-first run. Original section/group keys remain
        // useful facts, but they must not insert a tail margin inside that projected family.
        return rightNestingDepth > 0 && (leftNestingDepth > 0 || left.hasChildren === true);
    };
    const isFirst = !shareVisualGroup(prev, item);
    const isLast = !shareVisualGroup(item, next);
    return SESSION_LIST_ROW_MODEL_ADJACENCY_VALUES[(isFirst ? 1 : 0) | (isLast ? 2 : 0)];
}

export function buildCachedSessionListRowModel(input: BuildCachedSessionListRowModelInput): SessionListRowModel {
    const rowKey = resolveRowKey(input.item);
    const cached = input.cache.entries.get(rowKey);
    const stableSettings = buildStablePresentationSettingsRefs(input.settings);
    if (cached && canReuseEntryWithoutSignature({
        entry: cached,
        snapshot: input.snapshot,
        item: input.item,
        adjacency: input.adjacency,
        settings: input.settings,
        stableSettings,
    })) {
        return cached.model;
    }

    const inputSignature = buildInputSignature({
        item: input.item,
        rowKey,
        adjacency: input.adjacency,
        snapshot: input.snapshot,
        settings: input.settings,
    });
    const canReuseCachedModel = canReuseEntry(
        cached,
        input.snapshot,
        input.item,
        inputSignature,
        input.settings,
    );
    const model = canReuseCachedModel
        ? cached.model
        : buildSessionListRowModel({
            item: input.item,
            state: input.snapshot,
            isFirst: input.adjacency.isFirst,
            isLast: input.adjacency.isLast,
            isSingle: input.adjacency.isSingle,
            settings: input.settings,
        });
    input.cache.entries.set(rowKey, {
        model,
        inputSignature,
        itemRef: input.item,
        adjacency: input.adjacency,
        stableSettings,
        itemSessionRef: input.item.session,
        sessionRef: resolveCacheSessionRef(input.snapshot),
        renderableRef: input.snapshot.renderable,
        messagesRef: input.snapshot.messages,
        pendingRef: input.snapshot.pending,
        draftPreview: input.snapshot.draft?.preview ?? null,
    });
    return model;
}
