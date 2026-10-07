import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { t } from '@/text';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { sessionTagKey } from './sessionTagUtils';

const EMPTY_SEARCH_TEXT_BY_SESSION_KEY: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_SEARCH_TEXT_PROJECTION = Object.freeze({
    searchableTextBySessionKey: EMPTY_SEARCH_TEXT_BY_SESSION_KEY,
    primarySearchableTextBySessionKey: EMPTY_SEARCH_TEXT_BY_SESSION_KEY,
    searchableTextByWorkflowRunKey: EMPTY_SEARCH_TEXT_BY_SESSION_KEY,
});

export type SessionListSearchTextProjection = Readonly<{
    searchableTextBySessionKey: Readonly<Record<string, string>>;
    primarySearchableTextBySessionKey: Readonly<Record<string, string>>;
    searchableTextByWorkflowRunKey: Readonly<Record<string, string>>;
}>;

type SessionSearchKey = Readonly<{
    serverId: string;
    sessionId: string;
    key: string;
}>;

type WorkflowRunSearchKey = Readonly<{
    serverId: string;
    runId: string;
    key: string;
}>;

type SearchableSessionMetadata = Readonly<{
    name?: string | null;
    path?: string | null;
    sessionDirectoryV1?: unknown;
    host?: string | null;
    machineId?: string | null;
}>;

type SessionListSearchOrganization = Readonly<{
    sessionTags: Readonly<Record<string, ReadonlyArray<string>>>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>;

function appendText(parts: string[], value: string | null | undefined): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push(trimmed);
}

function appendSessionMetadataText(parts: string[], metadata: SearchableSessionMetadata | null | undefined): void {
    appendText(parts, metadata?.name);
    // A no-folder session is found as a chat; its private folder is never indexed.
    if (readSessionDirectoryKind(metadata) === 'managed') appendText(parts, t('session.folderless.chats'));
    else appendText(parts, metadata?.path);
    appendText(parts, metadata?.host);
    appendText(parts, metadata?.machineId);
}

function appendRenderableText(parts: string[], renderable: SessionListRenderableSession | null | undefined): void {
    appendSessionMetadataText(parts, renderable?.metadata ?? null);
}

export function buildCanonicalSessionListSearchText(input: Readonly<{
    sessionId: string;
    renderable?: SessionListRenderableSession | null;
    session?: Session | null;
    tags?: ReadonlyArray<string>;
    workspaceDisplayLabel?: string | null;
}>): string {
    const parts: string[] = [];
    appendText(parts, input.sessionId);
    appendRenderableText(parts, input.renderable);
    appendSessionMetadataText(parts, input.session ? readSessionOwnerMetadataView(input.session) : null);
    for (const tag of input.tags ?? []) appendText(parts, tag);
    appendText(parts, input.workspaceDisplayLabel);
    return parts.join('\n');
}

export function buildCanonicalSessionListPrimarySearchText(input: Readonly<{
    sessionId: string;
    renderable?: SessionListRenderableSession | null;
    session?: Session | null;
    workspaceDisplayLabel?: string | null;
}>): string {
    const parts: string[] = [];
    appendText(parts, input.sessionId);
    const renderableMetadata = input.renderable?.metadata ?? null;
    appendText(parts, renderableMetadata?.name);
    const ownerMetadata = input.session ? readSessionOwnerMetadataView(input.session) : null;
    appendText(parts, ownerMetadata?.name);
    appendText(parts, input.workspaceDisplayLabel);
    return parts.join('\n');
}

function collectSessionKeys(items: ReadonlyArray<SessionListIndexItem>): ReadonlyArray<SessionSearchKey> {
    const keys: SessionSearchKey[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = String(item.serverId ?? '').trim();
        const sessionId = String(item.sessionId ?? '').trim();
        if (!serverId || !sessionId) continue;
        const key = sessionTagKey(serverId, sessionId);
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({ serverId, sessionId, key });
    }
    return keys;
}

function collectWorkflowRunKeys(items: ReadonlyArray<SessionListIndexItem>): readonly WorkflowRunSearchKey[] {
    const keys: WorkflowRunSearchKey[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (item.type !== 'workflow_run' || !item.serverId || !item.runId) continue;
        const key = buildSessionListIndexNodeId(item);
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({ serverId: item.serverId, runId: item.runId, key });
    }
    return keys;
}

function buildSearchTextProjection(
    state: StorageState,
    sessionKeys: ReadonlyArray<SessionSearchKey>,
    organization?: SessionListSearchOrganization,
): Pick<SessionListSearchTextProjection, 'searchableTextBySessionKey' | 'primarySearchableTextBySessionKey'> {
    const out: Record<string, string> = {};
    const primary: Record<string, string> = {};
    for (const entry of sessionKeys) {
        // Session ids are source-local. Contextual search consumes only the
        // exact server partition; bare-id global Session/renderable maps could
        // otherwise leak another Home's same-id metadata into this haystack.
        const renderable = readSessionListRowForServerId(
            state.sessionListRowsByServerId,
            entry.serverId,
            entry.sessionId,
        );
        const metadata = renderable?.metadata ?? null;
        const workspaceDisplayLabel = organization
            ? resolveSessionWorkspaceDisplayPresentation({
                serverId: entry.serverId,
                metadata,
                workspaceRefs: organization.workspaceRefs,
                workspacePathDisplayModeV1: organization.workspacePathDisplayModeV1,
            }).displayTitle
            : null;
        const text = buildCanonicalSessionListSearchText({
            sessionId: entry.sessionId,
            renderable,
            tags: organization?.sessionTags[entry.key],
            workspaceDisplayLabel,
        });
        if (text) out[entry.key] = text;
        const primaryText = buildCanonicalSessionListPrimarySearchText({
            sessionId: entry.sessionId,
            renderable,
            workspaceDisplayLabel,
        });
        if (primaryText) primary[entry.key] = primaryText;
    }

    return {
        searchableTextBySessionKey: Object.keys(out).length > 0 ? out : EMPTY_SEARCH_TEXT_BY_SESSION_KEY,
        primarySearchableTextBySessionKey: Object.keys(primary).length > 0 ? primary : EMPTY_SEARCH_TEXT_BY_SESSION_KEY,
    };
}

function buildWorkflowRunSearchText(
    state: StorageState,
    runKeys: readonly WorkflowRunSearchKey[],
    scope: ServerAccountScope | null,
    organization?: SessionListSearchOrganization,
): Readonly<Record<string, string>> {
    if (!scope || !areServerAccountScopesEqual(scope, state.profileScope)) return EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
    const out: Record<string, string> = {};
    for (const entry of runKeys) {
        // The caller supplies only rows from the current Account-owned window. A Run's bare id
        // resolves solely in that map and only for its exact active Home; Session partitions stay separate.
        if (!areServerProfileIdentifiersEquivalent(entry.serverId, scope.serverId)) continue;
        const row = state.workflowRunsById[entry.runId];
        if (!row) continue;
        const parts = [entry.runId];
        if (row.metadata?.kind === 'available') {
            appendText(parts, row.metadata.value.title);
            appendText(parts, row.metadata.value.description);
        }
        const where = row.summary?.where;
        appendText(parts, where?.directory);
        appendText(parts, where?.machineId);
        if (where && organization) appendText(parts, resolveSessionWorkspaceDisplayPresentation({
            serverId: entry.serverId,
            metadata: { machineId: where.machineId, path: where.directory },
            workspaceRefs: organization.workspaceRefs,
            workspacePathDisplayModeV1: organization.workspacePathDisplayModeV1,
        }).displayTitle);
        out[entry.key] = parts.join('\n');
    }
    return Object.keys(out).length > 0 ? out : EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
}

function reuseSearchTextMap(previous: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const keys = Object.keys(next);
    return keys.length === Object.keys(previous).length && keys.every((key) => previous[key] === next[key]) ? previous : next;
}

function createSessionListSearchTextProjectionSelector(
    items: ReadonlyArray<SessionListIndexItem>,
    enabled: boolean,
    organization?: SessionListSearchOrganization,
    workflowRunScope: ServerAccountScope | null = null,
): (state: StorageState) => SessionListSearchTextProjection {
    const sessionKeys = collectSessionKeys(items);
    const runKeys = collectWorkflowRunKeys(items);
    let previousState: StorageState | null = null;
    let previousDeltaRevision: number | null = null;
    let previousResult: SessionListSearchTextProjection | null = null;

    return (state) => {
        if (!enabled || (sessionKeys.length === 0 && runKeys.length === 0)) return EMPTY_SEARCH_TEXT_PROJECTION;
        if (previousResult && previousState === state) return previousResult;
        const renderableDelta = state.sessionListRenderableDelta;
        const sessionsUnchanged = previousResult !== null && (previousState?.sessionListRowsByServerId === state.sessionListRowsByServerId || (
            previousResult
            && renderableDelta
            && previousDeltaRevision !== null
            && renderableDelta.revision !== previousDeltaRevision
            && renderableDelta.rebuiltSessionListIndex !== true
            && renderableDelta.changedSessionIds.length === 0
            && renderableDelta.removedSessionIds.length === 0
        ));
        const runsUnchanged = previousState !== null
            && (previousState.profileScope === state.profileScope || areServerAccountScopesEqual(previousState.profileScope, state.profileScope))
            && runKeys.every(({ runId }) => (
                previousState!.workflowRunsById?.[runId]?.metadata === state.workflowRunsById?.[runId]?.metadata
                && previousState!.workflowRunsById?.[runId]?.summary?.where === state.workflowRunsById?.[runId]?.summary?.where
                && Boolean(previousState!.workflowRunsById?.[runId]) === Boolean(state.workflowRunsById?.[runId])
            ));
        if (previousResult && sessionsUnchanged && runsUnchanged) {
            previousState = state;
            previousDeltaRevision = renderableDelta?.revision ?? null;
            return previousResult;
        }

        const sessions = sessionsUnchanged && previousResult
            ? previousResult
            : buildSearchTextProjection(state, sessionKeys, organization);
        const searchableTextBySessionKey = previousResult
            ? reuseSearchTextMap(previousResult.searchableTextBySessionKey, sessions.searchableTextBySessionKey)
            : sessions.searchableTextBySessionKey;
        const primarySearchableTextBySessionKey = previousResult
            ? reuseSearchTextMap(previousResult.primarySearchableTextBySessionKey, sessions.primarySearchableTextBySessionKey)
            : sessions.primarySearchableTextBySessionKey;
        const nextRuns = runsUnchanged && previousResult ? previousResult.searchableTextByWorkflowRunKey
            : buildWorkflowRunSearchText(state, runKeys, workflowRunScope, organization);
        const searchableTextByWorkflowRunKey = previousResult
            ? reuseSearchTextMap(previousResult.searchableTextByWorkflowRunKey, nextRuns) : nextRuns;
        previousResult = previousResult
            && previousResult.searchableTextBySessionKey === searchableTextBySessionKey
            && previousResult.primarySearchableTextBySessionKey === primarySearchableTextBySessionKey
            && previousResult.searchableTextByWorkflowRunKey === searchableTextByWorkflowRunKey
            ? previousResult
            : { searchableTextBySessionKey, primarySearchableTextBySessionKey, searchableTextByWorkflowRunKey };
        previousState = state;
        previousDeltaRevision = renderableDelta?.revision ?? null;
        return previousResult;
    };
}

export function createSessionListSearchTextSelector(
    items: ReadonlyArray<SessionListIndexItem>,
    enabled: boolean,
    organization?: SessionListSearchOrganization,
): (state: StorageState) => Readonly<Record<string, string>> {
    const projectionSelector = createSessionListSearchTextProjectionSelector(items, enabled, organization);
    return (state) => projectionSelector(state).searchableTextBySessionKey;
}

export function useSessionListSearchTextByKey(
    items: ReadonlyArray<SessionListIndexItem>,
    enabled: boolean,
    organization?: SessionListSearchOrganization,
): SessionListSearchTextProjection {
    const searchRuns = enabled && items.some((item) => item.type === 'workflow_run');
    const workflowRunScope = getStorage()(useShallow((state) => searchRuns ? state.profileScope ?? null : null));
    const selector = React.useMemo(
        () => createSessionListSearchTextProjectionSelector(items, enabled, organization, workflowRunScope),
        [enabled, items, organization, workflowRunScope],
    );
    return getStorage()(useShallow(selector));
}
