import * as React from 'react';
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1, ProjectSourcesUpdateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectOrganizationUpdateOutputV1Schema } from '@happier-dev/protocol/projects/projectOrganizationV1';
import type { ProjectSessionDefaultsV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';
import type { ProjectSessionDefaultsGetInputV1, ProjectSessionDefaultsGetOutputV1, ProjectSessionDefaultsRowV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { getProjectSessionDefaults, executeProjectDefaultsAction, isProjectSessionDefaultsEditUnchanged } from '@/sync/ops/actions/projectSessionDefaultsActions';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';

type Snapshot = Readonly<{ data: ProjectSessionDefaultsGetOutputV1 | null; status: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error' | 'unavailable'; error: unknown }>;
const EMPTY: Snapshot = Object.freeze({ data: null, status: 'idle', error: null });

/** Selected record demand only; the incumbent scoped lifecycle owns push and cancellation. */
export function useProjectSessionDefaults(input: ProjectSessionDefaultsGetInputV1 & Readonly<{ demanded: boolean }>) {
    const serverId = input.projectRef?.serverId ?? input.sourceRef?.serverId ?? '';
    const resolution = useServerCredentialAccountScopeResolution(input.demanded ? serverId : null);
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const inputKey = JSON.stringify([input.projectRef, input.sourceRef, input.primaryTeamId, input.sharedTeamIds]);
    const selected = React.useMemo<ProjectSessionDefaultsGetInputV1>(() => ({
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...(input.primaryTeamId !== undefined ? { primaryTeamId: input.primaryTeamId } : {}),
        ...(input.sharedTeamIds ? { sharedTeamIds: input.sharedTeamIds } : {}),
    }), [inputKey]);
    const key = JSON.stringify([scope?.serverId, scope?.accountId, inputKey]);
    const [stored, setStored] = React.useState<Readonly<{ key: string; snapshot: Snapshot }>>({ key, snapshot: EMPTY });
    const snapshot = stored.key === key ? stored.snapshot : EMPTY;
    const lifecycle = React.useMemo(() => {
        const publish = (update: (previous: Snapshot) => Snapshot) => setStored(previous => {
            const previousSnapshot = previous.key === key ? previous.snapshot : EMPTY;
            return retainShallow(previous, { key, snapshot: retainShallow(previousSnapshot, update(previousSnapshot)) });
        });
        const rowKey = selected.projectRef && scope ? buildProjectAccountRowPhysicalKeyV1({
            kind: 'project-session-defaults', ...selected.projectRef, serverId: scope.serverId }) : null;
        const loader = createScopedSnapshotLoader<ScopedLoadTarget>({
            load: async (_target, context) => {
                if (!scope) return;
                publish(previous => ({ ...previous, status: previous.data ? 'refreshing' : 'loading', error: null }));
                try {
                    const data = await getProjectSessionDefaults(scope, selected, context.signal);
                    if (!context.signal.aborted) publish(previous => ({ data: retainDeep(previous.data ?? undefined, data),
                        status: context.isCurrent() ? 'ready' : 'refreshing', error: null }));
                } catch (error) {
                    if (!context.signal.aborted) publish(previous => ({ ...previous, status: 'error', error }));
                }
            },
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {},
            invalidateTarget: () => publish(previous => ({ ...previous, status: previous.data ? 'refreshing' : 'loading' })),
            prepareWake: event => !event.entityIds || event.entityIds.some(id => id === rowKey
                || id === HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 || id === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
                || Boolean(selected.sourceRef && id === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1)),
        });
        const target = scope ? { key, serverId: scope.serverId } : null;
        return { loader, target };
    }, [key, selected]);
    React.useEffect(() => {
        if (!input.demanded || !lifecycle.target) return;
        return lifecycle.loader.observe(lifecycle.target);
    }, [input.demanded, lifecycle]);
    const refresh = React.useCallback(async () => {
        if (input.demanded && lifecycle.target) await lifecycle.loader.invalidate(lifecycle.target);
    }, [input.demanded, lifecycle]);
    const applyDefaultsReceipt = React.useCallback((layer: 'personal-project' | 'project', row: ProjectSessionDefaultsRowV1) => {
        setStored(previous => {
            if (previous.key !== key || !previous.snapshot.data) return previous;
            const data = previous.snapshot.data;
            return { key, snapshot: { ...previous.snapshot, data: layer === 'personal-project'
                ? { ...data, personalDefaultsRow: row, context: { ...data.context, personalProjectDefaults: row.defaults } }
                : { ...data, sourceDefaultsRow: row, context: { ...data.context, projectDefaults: row.defaults } } } };
        });
    }, [key]);
    const visible: Snapshot = !input.demanded ? EMPTY : resolution.kind !== 'bound'
        ? { data: null, status: resolution.kind === 'resolving' ? 'loading' : 'unavailable', error: resolution }
        : snapshot;
    return { ...visible, input: selected, scope, refresh, applyDefaultsReceipt };
}

const NO_DEFAULTS: ProjectSessionDefaultsV1 = Object.freeze({});

/** Existing defaults editor adapter; the Source owner's settings authority supplies write access. */
export function useProjectSessionDefaultsEditor(input: Readonly<{
    read: ReturnType<typeof useProjectSessionDefaults>; scope: 'personal-project' | 'project';
}>) {
    const { read, scope } = input;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<unknown>(null);
    const editable = read.status === 'ready' && read.scope !== null && (scope === 'personal-project'
        ? Boolean(read.input.projectRef) : Boolean(read.input.sourceRef && read.data?.canManageSource));
    const save = React.useCallback(async (next: ProjectSessionDefaultsV1 | null) => {
        if (!editable || !read.scope || !read.data || busy) return;
        const current = scope === 'personal-project' ? read.data.personalDefaultsRow?.defaults : read.data.sourceDefaultsRow?.defaults;
        if (isProjectSessionDefaultsEditUnchanged(current, next)) return;
        setBusy(true); setError(null);
        try {
            if (scope === 'personal-project' && read.input.projectRef) {
                const result = ProjectOrganizationUpdateOutputV1Schema.parse(await executeProjectDefaultsAction(read.scope,
                    'projects.organization.update', { projectRef: read.input.projectRef, expectedRevision: 'absent',
                        sessionDefaults: { expectedRevision: read.data.personalDefaultsRow?.revision ?? 'absent', defaults: next } }));
                if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
                if ('sessionDefaults' in result) read.applyDefaultsReceipt(scope, result.sessionDefaults);
            } else if (read.input.sourceRef && read.data.source) {
                const result = ProjectSourcesUpdateOutputV1Schema.parse(await executeProjectDefaultsAction(read.scope,
                    'projects.sources.update', { ...read.input.sourceRef, expectedRevision: read.data.source.revision,
                        patch: { sessionDefaults: { expectedRevision: read.data.sourceDefaultsRow?.revision ?? 'absent', defaults: next } } }));
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error });
                if (result.sessionDefaults) read.applyDefaultsReceipt(scope, result.sessionDefaults);
            }
        } catch (failure) { setError(failure); throw failure; }
        finally { setBusy(false); }
    }, [read, scope, editable, busy]);
    return { defaults: (scope === 'personal-project' ? read.data?.personalDefaultsRow?.defaults : read.data?.sourceDefaultsRow?.defaults) ?? NO_DEFAULTS,
        save, access: editable ? { editable: true as const } : { editable: false as const, reason: 'project' as const }, busy, error };
}
