import * as React from 'react';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentReadDemandV1, DeploymentReadSnapshotV1 } from '@happier-dev/deployments';
import { useInboxArtifactRowDemand, useOptionalInboxArtifactSource } from '@/hooks/inbox/useInboxArtifactSource';
import { storage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { areServerAccountScopesEqual, serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { EnvironmentHealthNoticeEntries } from '@/sync/domains/artifacts/healthNoticeEnvironments';
import type { AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';

export type EnvironmentHealthNotices = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'partial' | 'unavailable';
    /** Condition activity at publication time, never the current Service health authority. */
    items: readonly AccountNoticeArtifact[];
    retry(): void;
}>;
const NO_ENTRIES: EnvironmentHealthNoticeEntries = Object.freeze({});
const NO_ITEMS: readonly AccountNoticeArtifact[] = Object.freeze([]);
const NO_RETRY = () => {};

/** Reuse the shell's one C1 acquisition; only the selected Environment's changed bucket wakes this page. */
export function useEnvironmentHealthNotices(scope: ServerAccountScope | null, environmentId: string | null,
    read: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>, demand: DeploymentReadDemandV1): EnvironmentHealthNotices {
    const source = useOptionalInboxArtifactSource();
    const active = demand.mounted && demand.visible && demand.focused;
    // Health notices are Inbox rows: an active Environment reads the full Inbox census.
    useInboxArtifactRowDemand(active);
    const current = areServerAccountScopesEqual(scope, source?.scope);
    const readable = read.value !== null;
    const key = scope && environmentId ? serverAccountScopedResourceKey(scope, environmentId) : null;
    const select = React.useCallback((state: StorageState) => active && current && readable && key
        ? state.artifactHealthNoticesByEnvironmentId[key] ?? NO_ENTRIES : NO_ENTRIES,
    [active, current, readable, key]);
    const subscription = React.useMemo(() => ({ artifactHealthNoticesByEnvironmentId:
        active && current && readable && key ? [key] : [] }), [active, current, readable, key]);
    const entries = storage(select, subscription);
    const items = React.useMemo(() => {
        const notices = Object.values(entries).flatMap(entry => entry.notice ? [entry.notice] : []);
        return notices.length ? notices.sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt
            || a.artifact.id.localeCompare(b.artifact.id)) : NO_ITEMS;
    }, [entries]);
    const retry = source?.retry ?? NO_RETRY;
    const phase = source?.phase;
    return React.useMemo(() => {
        const status: EnvironmentHealthNotices['status'] = !active ? 'idle'
            : !current || !source || read.status === 'unavailable' ? 'unavailable'
            : !readable || phase === 'loading' ? 'loading'
            : phase === 'failed' ? 'unavailable'
            : phase === 'partial' ? 'partial' : 'ready';
        return { status, items, retry };
    }, [active, current, source, read.status, readable, phase, items, retry]);
}
