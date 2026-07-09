import * as React from 'react';

import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

export type RetainedSessionListPaneState = Readonly<{
    storageKind: SessionListStorageFilter;
    pathname?: string;
    sourceScopeKey: string;
    surfaceRoutePathname?: string;
    paneState: VisibleSessionListPaneState;
}>;

type SessionListPaneRetentionIdentity = Pick<RetainedSessionListPaneState, 'storageKind' | 'pathname' | 'sourceScopeKey'>;

type SessionListPaneRetentionSelection = Readonly<{
    activeServerId?: string | null;
    allowedServerIds?: ReadonlyArray<string> | null;
    enabled?: boolean | null;
    presentation?: string | null;
    activeTarget?: Readonly<{
        kind?: string | null;
        id?: string | null;
        serverId?: string | null;
        groupId?: string | null;
        serverIds?: ReadonlyArray<string> | null;
    }> | null;
}>;

const retainedPaneStateByKey = new Map<string, RetainedSessionListPaneState>();

function normalizeRetentionStorageKind(storageKind: SessionListStorageFilter | null | undefined): string {
    const normalized = typeof storageKind === 'string' ? storageKind.trim() : '';
    return normalized || 'all';
}

function normalizeRetentionPathname(pathname: string | null | undefined): string {
    const normalized = typeof pathname === 'string' ? pathname.trim() : '';
    return normalized || '/';
}

function normalizeRetentionSourceScopeKey(sourceScopeKey: string | null | undefined): string {
    const normalized = typeof sourceScopeKey === 'string' ? sourceScopeKey.trim() : '';
    return normalized || 'source:default';
}

function normalizeSourceScopePart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function encodeSourceScopePart(value: unknown): string {
    const normalized = normalizeSourceScopePart(value);
    return `${normalized.length}:${normalized}`;
}

function encodeSourceScopeList(values: ReadonlyArray<string> | null | undefined): string {
    if (!Array.isArray(values)) return '0:';
    return values
        .map((value) => normalizeSourceScopePart(value))
        .filter((value) => value.length > 0)
        .map(encodeSourceScopePart)
        .join('');
}

function buildActiveTargetScopeKey(target: SessionListPaneRetentionSelection['activeTarget']): string {
    if (!target) return 'none';
    return [
        encodeSourceScopePart(target.kind),
        encodeSourceScopePart(target.id),
        encodeSourceScopePart(target.serverId),
        encodeSourceScopePart(target.groupId),
        encodeSourceScopeList(target.serverIds),
    ].join('');
}

function getRetentionKey(identity: SessionListPaneRetentionIdentity): string {
    return [
        normalizeRetentionStorageKind(identity.storageKind),
        normalizeRetentionPathname(identity.pathname),
        normalizeRetentionSourceScopeKey(identity.sourceScopeKey),
    ].join('\u0000');
}

export function buildSessionListPaneSourceScopeKey(params: Readonly<{
    accountScope?: ServerAccountScope | null;
    selection?: SessionListPaneRetentionSelection | null;
}>): string {
    const selection = params.selection;
    const accountScopeKey = params.accountScope
        ? serverAccountScopeKeySuffix(params.accountScope)
        : 'none';
    return [
        `account:${accountScopeKey}`,
        `selection:${selection?.enabled === true ? 'enabled' : 'single'}`,
        `active:${encodeSourceScopePart(selection?.activeServerId)}`,
        `allowed:${encodeSourceScopeList(selection?.allowedServerIds)}`,
        `presentation:${encodeSourceScopePart(selection?.presentation)}`,
        `target:${buildActiveTargetScopeKey(selection?.activeTarget)}`,
    ].join('|');
}

export function useSessionListPaneSourceScopeKey(): string {
    const selection = useSessionListSelectionState();
    const accountScope = useActiveServerAccountScope();
    return React.useMemo(
        () => buildSessionListPaneSourceScopeKey({
            accountScope,
            selection,
        }),
        [accountScope, selection],
    );
}

function isRetainablePaneState(paneState: VisibleSessionListPaneState): boolean {
    return !paneState.showLoading;
}

export function readRetainedSessionListPaneState(
    identity: SessionListPaneRetentionIdentity,
): RetainedSessionListPaneState | null {
    return retainedPaneStateByKey.get(getRetentionKey(identity)) ?? null;
}

export function retainSessionListPaneState(
    state: RetainedSessionListPaneState,
): RetainedSessionListPaneState | null {
    if (!isRetainablePaneState(state.paneState)) {
        return null;
    }
    retainedPaneStateByKey.set(getRetentionKey(state), state);
    return state;
}

export function updateRetainedSessionListPaneSurfaceRoutePathname(
    identity: SessionListPaneRetentionIdentity,
    surfaceRoutePathname: string | undefined,
): RetainedSessionListPaneState | null {
    const retained = readRetainedSessionListPaneState(identity);
    if (!retained) return null;
    if ((retained.surfaceRoutePathname ?? '') === (surfaceRoutePathname ?? '')) {
        return retained;
    }
    const next = {
        ...retained,
        surfaceRoutePathname,
    };
    retainedPaneStateByKey.set(getRetentionKey(identity), next);
    return next;
}

export function resetSessionListPaneRetentionForTests(): void {
    retainedPaneStateByKey.clear();
}
