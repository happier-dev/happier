import {
    ProjectSourcesListOutputV1Schema, ProjectSourcesReadOutputV1Schema, ProjectSourcesCreateInputV1Schema,
    ProjectSourcesCreateOutputV1Schema, ProjectSourcesUpdateOutputV1Schema, ProjectSourcesDeleteOutputV1Schema,
    type ProjectSourceV1, type ProjectSourcesCreateInputV1, type ProjectSourcesUpdateInputV1,
    type ProjectSourcesListInputV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { randomUUID } from '@/platform/randomUUID';
import { ScmHostingRepositoryResolveAddressResponseV1Schema, type ScmHostingRepositoryResolveAddressResponseV1 } from '@happier-dev/protocol/scm/repositoryClone';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { formatProjectSourceAddress } from './projectSourceAddress';

export type ProjectSourceAddressMachines = Readonly<{
    machines: readonly Readonly<Pick<Machine, 'id' | 'active'> & Partial<Pick<Machine, 'activeAt' | 'kind' | 'revokedAt' | 'replacedByMachineId' | 'availability'>>>[];
    preferredMachineId?: string | null;
}>;
export type ProjectSourceAddressResolution =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'resolving'; address: string; machineId: string }>
    | Readonly<{ kind: 'no_reachable_machine' | 'unavailable'; address: string }>
    | (ScmHostingRepositoryResolveAddressResponseV1 & Readonly<{ address: string; machineId: string }>);

export type ProjectSourceDraft = Omit<ProjectSourcesCreateInputV1, 'serverId' | 'requestKey'>;
export type ProjectSourceCreationDraft = Readonly<{
    name: string;
    address: string;
    defaultRef: string;
    subdir: string;
    audience: NonNullable<ProjectSourceDraft['audience']>;
    repository: ProjectSourceDraft['repository'] | null;
}>;
type CreationFields = Pick<ProjectSourceCreationDraft, 'name' | 'address' | 'defaultRef' | 'subdir' | 'audience'>;
export type ProjectSourcesState = Readonly<{
    rows: readonly ProjectSourceV1[];
    query: string;
    audience: ProjectSourcesListInputV1['audience'];
    catalogQuery: string;
    catalogAudience: ProjectSourcesListInputV1['audience'];
    coverage: Readonly<{ complete: boolean; nextCursor: string | null }>;
    status: 'initial' | 'loading' | 'ready' | 'offline' | 'refused';
    selectedId: string | null;
    current: ProjectSourceV1 | null;
    canManage: boolean;
    detailStatus: 'initial' | 'loading' | 'ready' | 'offline' | 'refused';
    draft: ProjectSourceDraft | null;
    creationDraft: ProjectSourceCreationDraft | null;
    conflict: ProjectSourceV1 | null;
    mutation: 'idle' | 'saving' | 'deleting';
    issue: string | null;
    uncertainCreate: boolean;
    addressResolution: ProjectSourceAddressResolution;
    addressSaveDisabledReason: 'projects.sources.saveNeedsAddress' | 'projects.sources.addressNoMachine' | 'projects.sources.backendUnavailable' | 'projects.sources.addressUnknown' | 'projects.sources.addressUnsupported' | 'projects.sources.addressInvalid' | 'projects.sources.loading' | null;
}>;
type Execute = (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => Promise<ActionExecuteResult>;
export type ProjectSourcesCatalog = Readonly<{
    getSnapshot(): ProjectSourcesState;
    subscribe(listener: () => void): () => void;
    load(query?: string, cursor?: string, audience?: ProjectSourcesListInputV1['audience']): Promise<void>;
    acknowledgeCatalog(source: ProjectSourceV1, created?: boolean): void;
    removeCatalogSource(sourceId: string, issue: string): void;
}>;
export type ReadProjectSourcesCatalog = (query: string, audience: ProjectSourcesListInputV1['audience']) => ProjectSourcesCatalog;

function catalogFields(state: ProjectSourcesState) {
    return { rows: state.rows, coverage: state.coverage, catalogQuery: state.catalogQuery,
        catalogAudience: state.catalogAudience, status: state.status };
}

function draftOf(source: ProjectSourceV1): ProjectSourceDraft {
    return { name: source.name, repository: source.repository, audience: source.audience,
        ...(source.defaultRef ? { defaultRef: source.defaultRef } : {}), ...(source.subdir ? { subdir: source.subdir } : {}) };
}

/** The editable create has one owner; the strict mutation is materialized only at submission. */
function materializeCreationDraft(draft: ProjectSourceCreationDraft | null): ProjectSourceDraft | null {
    if (!draft?.repository) return null;
    return { name: draft.name.trim() || draft.repository.repository.nameWithOwner.split('/').at(-1)!,
        repository: draft.repository, audience: draft.audience,
        ...(draft.defaultRef.trim() ? { defaultRef: draft.defaultRef.trim() } : {}),
        ...(draft.subdir.trim() ? { subdir: draft.subdir.trim() } : {}),
    };
}

function createIdentity(draft: ProjectSourceDraft) {
    const input = ProjectSourcesCreateInputV1Schema.omit({ serverId: true, requestKey: true }).parse({ ...draft, audience: draft.audience ?? [] });
    return JSON.stringify({ ...input, audience: [...(input.audience ?? [])].sort((left, right) =>
        JSON.stringify(left.principal).localeCompare(JSON.stringify(right.principal))) });
}

function editedFields(draft: ProjectSourceDraft, basis: ProjectSourceDraft): ProjectSourcesUpdateInputV1['patch'] {
    return {
        ...(draft.name !== basis.name ? { name: draft.name } : {}),
        ...(JSON.stringify(draft.repository) !== JSON.stringify(basis.repository) ? { repository: draft.repository } : {}),
        ...(draft.defaultRef !== basis.defaultRef ? { defaultRef: draft.defaultRef || null } : {}),
        ...(draft.subdir !== basis.subdir ? { subdir: draft.subdir || null } : {}),
        ...(JSON.stringify(draft.audience) !== JSON.stringify(basis.audience) ? { audience: draft.audience ?? [] } : {}),
    };
}

function carryDraft(draft: ProjectSourceDraft, basis: ProjectSourceDraft, source: ProjectSourceV1): ProjectSourceDraft {
    const edits = editedFields(draft, basis);
    return { ...draftOf(source),
        ...(edits.name !== undefined ? { name: edits.name } : {}),
        ...(edits.repository !== undefined ? { repository: edits.repository } : {}),
        ...(edits.audience !== undefined ? { audience: edits.audience } : {}),
        ...('defaultRef' in edits ? { defaultRef: edits.defaultRef ?? undefined } : {}),
        ...('subdir' in edits ? { subdir: edits.subdir ?? undefined } : {}),
    };
}

/** One demanded catalog/editor, captured under one authenticated Home/Account. */
export function createProjectSourcesController(scope: ServerAccountScope, execute: Execute,
    readAddressMachines: () => ProjectSourceAddressMachines = () => ({ machines: [] }),
    readCatalog?: ReadProjectSourcesCatalog) {
    let state: ProjectSourcesState = { rows: [], query: '', audience: undefined, catalogQuery: '', catalogAudience: undefined, coverage: { complete: false, nextCursor: null }, status: 'initial',
        selectedId: null, current: null, canManage: false, detailStatus: 'initial', draft: null, creationDraft: null, conflict: null,
        mutation: 'idle', issue: null, uncertainCreate: false, addressResolution: { kind: 'idle' }, addressSaveDisabledReason: null };
    let catalog = readCatalog?.('', undefined);
    if (catalog) state = { ...state, ...catalogFields(catalog.getSnapshot()) };
    let stopCatalog: (() => void) | null = null;
    const listeners = new Set<() => void>();
    const drafts = new Map<string | null, ProjectSourceDraft>();
    const draftBases = new Map<string, ProjectSourceDraft>();
    const details = new Map<string, Readonly<{ source: ProjectSourceV1; canManage: boolean }>>();
    const conflicts = new Map<string, ProjectSourceV1>();
    const uncertainSources = new Set<string>();
    let uncertainDraft: ProjectSourceDraft | null = null;
    // One interactive create intent uses the incumbent server RetryKey. A lost
    // acknowledgement retains both key and payload; newer typing stays a draft.
    let createIntent: Readonly<{ input: ProjectSourcesCreateInputV1; draft: ProjectSourceDraft }> | null = null;
    let inspectedCreateAbsence = false;
    let createRetryConfirmed = false;
    let listRequest: AbortController | null = null;
    let listSettlement: Promise<void> | null = null;
    let detailRequest: AbortController | null = null;
    let addressRequest: AbortController | null = null;
    let disposed = false;
    const publish = (patch: Partial<ProjectSourcesState>) => {
        if (disposed) return;
        if (Object.entries(patch).every(([key, value]) => Object.is(state[key as keyof ProjectSourcesState], value))) return;
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    async function invoke(actionId: ActionId, input: unknown, signal?: AbortSignal, actionRequestId?: string) {
        const outcome = await execute(actionId, input, { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
            ...(signal ? { signal } : {}), ...(actionRequestId ? { actionRequestId } : {}) });
        if (!outcome.ok) throw Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode });
        if (outcome.result && typeof outcome.result === 'object' && 'kind' in outcome.result && outcome.result.kind === 'approval_request_created') {
            throw Object.assign(new Error('approval_pending'), { code: 'approval_pending' });
        }
        return outcome.result;
    }
    function errorCode(error: unknown) {
        return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'source_save_failed';
    }
    function unavailable(code: string) {
        return code === 'source_unavailable' || code === 'source_access_denied'
            || code === 'action_home_signed_out' || code === 'action_forbidden';
    }
    function reconcileRows(incoming: readonly ProjectSourceV1[], append = false) {
        const previous = new Map(state.rows.map((row) => [row.id, row]));
        const merged = append ? new Map(previous) : new Map<string, ProjectSourceV1>();
        for (const row of incoming) merged.set(row.id, (previous.get(row.id)?.revision ?? 0) >= row.revision ? previous.get(row.id)! : row);
        const rows = [...merged.values()];
        return rows.length === state.rows.length && rows.every((row, index) => row === state.rows[index]) ? state.rows : rows;
    }
    function forgetUnavailable(sourceId: string, issue: string) {
        catalog?.removeCatalogSource(sourceId, issue);
        details.delete(sourceId);
        drafts.delete(sourceId);
        draftBases.delete(sourceId);
        conflicts.delete(sourceId);
        uncertainSources.delete(sourceId);
        if (state.selectedId === sourceId) resetAddress();
        publish({ rows: state.rows.filter((row) => row.id !== sourceId), ...(state.selectedId === sourceId ? {
            current: null, canManage: false, detailStatus: 'refused' as const, draft: null, conflict: null, issue,
        } : {}) });
    }
    function forgetCatalog() {
        resetAddress();
        details.clear(); drafts.clear(); draftBases.clear(); conflicts.clear(); uncertainSources.clear();
        createIntent = null; uncertainDraft = null; createRetryConfirmed = false; inspectedCreateAbsence = false;
        return { rows: [], current: null, canManage: false, draft: null, creationDraft: null, conflict: null, uncertainCreate: false,
            detailStatus: 'refused' as const };
    }
    function resetAddress() {
        addressRequest?.abort(); addressRequest = null;
        publish({ addressResolution: { kind: 'idle' }, addressSaveDisabledReason: null });
    }
    function domainFailure(result: Readonly<{ error: string; current?: ProjectSourceV1 }>, sourceId?: string, detailRead = false) {
        if (sourceId && unavailable(result.error)) {
            forgetUnavailable(sourceId, result.error);
        } else {
            if (sourceId && result.current) conflicts.set(sourceId, result.current);
            if (!sourceId || state.selectedId === sourceId) publish({ issue: result.error, conflict: result.current ?? null,
                ...(result.error === 'source_backend_unavailable' ? { detailStatus: 'offline' as const }
                    : detailRead ? { detailStatus: 'refused' as const } : {}) });
        }
    }
    function acknowledge(source: ProjectSourceV1, canManage: boolean, created = false) {
        catalog?.acknowledgeCatalog(source, created);
        if (created && listRequest) {
            // The pending catalog predates our acknowledged row. Retire that
            // projection and ask the incumbent list Action for the current catalog.
            listRequest.abort(); listRequest = null;
            void controller.load(state.query, undefined, state.audience);
        }
        const previous = details.get(source.id)?.source;
        if (previous?.revision === source.revision) source = previous;
        details.set(source.id, { source, canManage });
        conflicts.delete(source.id);
        uncertainSources.delete(source.id);
        const listed = state.rows.some((row) => row.id === source.id);
        if (listed || (created && state.catalogQuery === '' && state.catalogAudience === undefined)) {
            publish({ rows: listed ? reconcileRows(state.rows.map((row) => row.id === source.id ? source : row))
                : [...state.rows, source] });
        }
        if (state.selectedId === source.id) publish({ current: source, canManage, detailStatus: 'ready', conflict: null, issue: null });
    }
    function mutationFailure(error: unknown, sourceId: string | null, draft?: ProjectSourceDraft) {
        const code = errorCode(error);
        if (code === 'outcome_unknown') {
            if (sourceId) uncertainSources.add(sourceId);
            else { uncertainDraft = createIntent?.draft ?? draft ?? null; inspectedCreateAbsence = false; createRetryConfirmed = false; }
        } else if (!sourceId && code !== 'approval_pending') {
            if (!uncertainDraft) createIntent = null;
            createRetryConfirmed = false;
        }
        if (sourceId && unavailable(code)) forgetUnavailable(sourceId, code);
        publish({ mutation: 'idle', uncertainCreate: uncertainDraft !== null,
            ...(state.selectedId === sourceId ? { issue: code,
                ...(code === 'home_unreachable' || code === 'source_save_failed' ? { detailStatus: 'offline' as const } : {}) } : {}) });
    }
    const controller = {
        scope: Object.freeze({ ...scope }),
        getSnapshot: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener); connectCatalog();
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) { stopCatalog?.(); stopCatalog = null; }
            };
        },
        dispose() { disposed = true; stopCatalog?.(); stopCatalog = null; listRequest?.abort(); detailRequest?.abort(); addressRequest?.abort(); listeners.clear(); },
        resume() { disposed = false; connectCatalog(); },
        acknowledgeCatalog(source: ProjectSourceV1, created = false) { acknowledge(source, false, created); },
        removeCatalogSource(sourceId: string, issue: string) {
            const refresh = Boolean(listRequest);
            listRequest?.abort(); listRequest = null;
            forgetUnavailable(sourceId, issue);
            if (refresh) void controller.load(state.query, undefined, state.audience);
        },
        retireCatalog(issue = 'action_home_signed_out') { publish({ ...forgetCatalog(), status: 'refused', issue, coverage: { complete: false, nextCursor: null } }); },
        async resolveAddress(text: string, options = readAddressMachines()) {
            if (disposed) return;
            if (!state.selectedId) {
                if (!state.creationDraft) controller.beginCreate();
                controller.editCreation({ address: text });
                publish({ creationDraft: { ...state.creationDraft!, repository: null } });
            }
            addressRequest?.abort(); addressRequest = null;
            const address = text.trim();
            // Unchanged retained selectors never need a reachable detector.
            const retained = state.draft?.repository ?? state.current?.repository;
            if (state.current && retained && address === formatProjectSourceAddress(retained)) { resetAddress(); return; }
            if (!address) {
                publish({ addressResolution: { success: true, kind: 'invalid', address, machineId: '' }, addressSaveDisabledReason: 'projects.sources.addressInvalid' });
                return;
            }
            const reachable = options.machines.filter(machine => isMachineVisibleForLaunchSelection(machine)
                && machine.availability?.kind !== 'locked' && isMachineOnline(machine));
            const machine = reachable.find(candidate => candidate.id === options.preferredMachineId) ?? reachable[0];
            if (!machine) {
                publish({ addressResolution: { kind: 'no_reachable_machine', address }, addressSaveDisabledReason: 'projects.sources.addressNoMachine' });
                return;
            }
            const request = new AbortController(); addressRequest = request;
            publish({ addressResolution: { kind: 'resolving', address, machineId: machine.id }, addressSaveDisabledReason: 'projects.sources.loading' });
            try {
                const outcome = await execute('scm.hostingRepository.resolveAddress', { address }, {
                    surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
                    externalActionTarget: { kind: 'machine', machineId: machine.id }, signal: request.signal,
                });
                if (disposed || addressRequest !== request || request.signal.aborted) return;
                if (!outcome.ok) throw new Error(outcome.errorCode);
                const result = ScmHostingRepositoryResolveAddressResponseV1Schema.parse(outcome.result);
                publish({ addressResolution: { ...result, address, machineId: machine.id }, addressSaveDisabledReason: result.kind === 'resolved' ? null
                    : result.kind === 'invalid' ? 'projects.sources.addressInvalid'
                        : result.kind === 'unknown' ? 'projects.sources.addressUnknown' : 'projects.sources.addressUnsupported' });
                if (result.kind === 'resolved') {
                    if (!state.selectedId && state.creationDraft) publish({ creationDraft: { ...state.creationDraft, repository: result.selector } });
                    else controller.edit({ repository: result.selector });
                }
            } catch {
                if (!disposed && addressRequest === request && !request.signal.aborted) publish({
                    addressResolution: { kind: 'unavailable', address }, addressSaveDisabledReason: 'projects.sources.backendUnavailable',
                });
            } finally { if (addressRequest === request) addressRequest = null; }
        },
        async load(query = state.query, cursor?: string, audience?: ProjectSourcesListInputV1['audience']) {
            if (disposed) return;
            if (uncertainDraft) { createRetryConfirmed = false; inspectedCreateAbsence = false; publish({ uncertainCreate: true }); }
            if (readCatalog) {
                publish({ query, audience });
                const next = readCatalog(query, audience);
                if (next !== catalog) { stopCatalog?.(); stopCatalog = null; catalog = next; }
                connectCatalog();
                await catalog.load(query, cursor, audience);
                return;
            }
            if (uncertainDraft) createRetryConfirmed = false;
            const append = Boolean(cursor) && query === state.catalogQuery && JSON.stringify(audience) === JSON.stringify(state.catalogAudience);
            if (listRequest && !listRequest.signal.aborted && !cursor && query === state.query && JSON.stringify(audience) === JSON.stringify(state.audience)) {
                await listSettlement;
                return;
            }
            listRequest?.abort();
            const request = new AbortController();
            listRequest = request;
            const changedFilter = query !== state.catalogQuery || JSON.stringify(audience) !== JSON.stringify(state.catalogAudience);
            publish({ status: 'loading', query, audience, ...(uncertainDraft ? { uncertainCreate: true } : {}),
                ...(!append && changedFilter ? { coverage: { complete: false, nextCursor: null } } : {}) });
            listSettlement = (async () => { try {
                const result = ProjectSourcesListOutputV1Schema.parse(await invoke('projects.sources.list', { serverId: scope.serverId, query, ...(cursor ? { cursor } : {}), ...(audience ? { audience } : {}) }, request.signal));
                if (disposed || listRequest !== request || request.signal.aborted) return;
                if (result.ok) {
                    const rows = reconcileRows(result.sources, append);
                    if (!cursor && query === '' && audience === undefined && result.coverage.complete) {
                        // This server result contains every Source admitted by the
                        // same current read predicate. Filtered/paged absence is not revocation.
                        const visible = new Set(rows.map(row => row.id));
                        for (const sourceId of details.keys()) if (!visible.has(sourceId)) forgetUnavailable(sourceId, 'source_unavailable');
                    }
                    if (uncertainDraft && query === '' && audience === undefined && result.coverage.complete) {
                        const expected = createIdentity(uncertainDraft);
                        inspectedCreateAbsence = !rows.some((row) => createIdentity(draftOf(row)) === expected);
                    }
                    publish({ rows, coverage: result.coverage, catalogQuery: query, catalogAudience: audience,
                        status: 'ready', issue: uncertainDraft ? 'outcome_unknown' : null });
                } else {
                    const revoked = unavailable(result.error);
                    publish({ ...(revoked ? forgetCatalog() : {}),
                        status: result.error === 'source_backend_unavailable' ? 'offline' : 'refused',
                        issue: result.error, coverage: { complete: false, nextCursor: null } });
                }
            } catch (error) {
                if (!disposed && listRequest === request && !request.signal.aborted) {
                    const code = errorCode(error);
                    const revoked = unavailable(code);
                    publish({ ...(revoked ? { ...forgetCatalog(), coverage: { complete: false, nextCursor: null } } : {}),
                        status: revoked ? 'refused' : 'offline', issue: code });
                }
            } finally { if (listRequest === request) { listRequest = null; listSettlement = null; } } })();
            await listSettlement;
        },
        async select(sourceId: string) {
            if (disposed) return;
            resetAddress();
            detailRequest?.abort();
            const request = new AbortController();
            detailRequest = request;
            const cached = details.get(sourceId);
            publish({ selectedId: sourceId, current: cached?.source ?? null, canManage: cached?.canManage ?? false,
                detailStatus: 'loading', draft: drafts.get(sourceId) ?? null, conflict: conflicts.get(sourceId) ?? null, issue: null });
            try {
                const result = ProjectSourcesReadOutputV1Schema.parse(await invoke('projects.sources.read', { serverId: scope.serverId, sourceId }, request.signal));
                if (disposed || detailRequest !== request || request.signal.aborted) return;
                if (result.ok) {
                    if (result.source.id !== sourceId) {
                        domainFailure({ error: 'source_invalid' }, sourceId, true);
                        return;
                    }
                    if (state.draft && cached && cached.source.revision !== result.source.revision) {
                        conflicts.set(sourceId, result.source);
                        publish({ detailStatus: 'ready', canManage: result.canManage, conflict: result.source, issue: 'source_conflict' });
                        uncertainSources.delete(sourceId);
                    } else acknowledge(result.source, result.canManage);
                } else domainFailure(result, sourceId, true);
            } catch (error) {
                if (!disposed && detailRequest === request && !request.signal.aborted) {
                    const code = errorCode(error);
                    if (unavailable(code)) forgetUnavailable(sourceId, code);
                    else publish({ detailStatus: 'offline', issue: code });
                }
            } finally { if (detailRequest === request) detailRequest = null; }
        },
        beginCreate(draft: Partial<ProjectSourceDraft> & Readonly<{ address?: string }> = {}) {
            detailRequest?.abort(); detailRequest = null;
            resetAddress();
            const repository = draft.repository ?? null;
            publish({ selectedId: null, current: null, canManage: true, detailStatus: 'ready', draft: null,
                creationDraft: { name: draft.name ?? '', address: draft.address ?? (repository ? formatProjectSourceAddress(repository) : ''),
                    defaultRef: draft.defaultRef ?? '', subdir: draft.subdir ?? '', audience: draft.audience ?? [], repository }, conflict: null,
                addressSaveDisabledReason: repository ? null : 'projects.sources.saveNeedsAddress',
                issue: uncertainDraft ? 'outcome_unknown' : null });
        },
        editCreation(patch: Partial<CreationFields>) {
            if (!state.creationDraft || state.selectedId) return;
            const changedAddress = patch.address !== undefined && patch.address !== state.creationDraft.address;
            if (changedAddress) resetAddress();
            publish({ creationDraft: { ...state.creationDraft, ...patch, ...(changedAddress ? { repository: null } : {}) },
                ...(changedAddress ? { addressSaveDisabledReason: 'projects.sources.saveNeedsAddress' as const } : {}) });
        },
        edit(patch: Partial<ProjectSourceDraft>) {
            if (!state.selectedId && state.creationDraft) {
                publish({ creationDraft: { ...state.creationDraft,
                    ...(patch.name !== undefined ? { name: patch.name } : {}),
                    ...('defaultRef' in patch ? { defaultRef: patch.defaultRef ?? '' } : {}),
                    ...('subdir' in patch ? { subdir: patch.subdir ?? '' } : {}),
                    ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
                    ...(patch.repository ? { repository: patch.repository, address: formatProjectSourceAddress(patch.repository) } : {}),
                } });
                return;
            }
            const draft = state.draft ?? (state.current ? draftOf(state.current) : null);
            if (draft) {
                if (!state.draft && state.current) draftBases.set(state.current.id, draftOf(state.current));
                const next = { ...draft, ...patch }; drafts.set(state.selectedId, next); publish({ draft: next });
            }
        },
        discard() {
            resetAddress();
            drafts.delete(state.selectedId);
            if (state.selectedId) { conflicts.delete(state.selectedId); draftBases.delete(state.selectedId); }
            else if (!uncertainDraft) createIntent = null;
            publish({ draft: null, conflict: null, ...(!state.selectedId ? { creationDraft: null } : {}) });
        },
        acceptCurrentRevision() {
            if (state.conflict) acknowledge(state.conflict, state.canManage);
        },
        confirmCreateRetryAfterInspection() {
            if (!uncertainDraft || !inspectedCreateAbsence || state.status !== 'ready' || !state.coverage.complete || state.catalogQuery !== '' || state.catalogAudience !== undefined) return false;
            createRetryConfirmed = true;
            publish({ uncertainCreate: false, issue: null });
            return true;
        },
        async save() {
            const draft = state.selectedId ? state.draft : materializeCreationDraft(state.creationDraft);
            if (disposed || !draft || state.addressSaveDisabledReason || state.mutation !== 'idle' || state.conflict || (!state.selectedId && uncertainDraft && !createRetryConfirmed) || (state.selectedId && uncertainSources.has(state.selectedId))) return;
            const current = state.current;
            const target = state.selectedId;
            if (target && (!current || !state.canManage)) return;
            publish({ mutation: 'saving', issue: null });
            try {
                if (!current && !createIntent) createIntent = { draft, input: ProjectSourcesCreateInputV1Schema.parse({ serverId: scope.serverId, ...draft, requestKey: randomUUID() }) };
                const submittedDraft = current ? draft : createIntent!.draft;
                const basis = current ? draftBases.get(current.id) ?? draftOf(current) : submittedDraft;
                const result = current
                    ? ProjectSourcesUpdateOutputV1Schema.parse(await invoke('projects.sources.update', { serverId: scope.serverId, sourceId: current.id, expectedRevision: current.revision,
                        patch: editedFields(draft, basis) }))
                    : ProjectSourcesCreateOutputV1Schema.parse(await invoke('projects.sources.create', createIntent!.input, undefined, createIntent!.input.requestKey));
                if (disposed) return;
                if (result.ok) {
                    const latest = target ? drafts.get(target) : materializeCreationDraft(state.creationDraft);
                    // Newer typing can still be invalid; it must not invalidate
                    // the admitted create acknowledgement or its saved identity.
                    const changed = latest && (target ? latest !== submittedDraft : Object.keys(editedFields(latest, submittedDraft)).length > 0);
                    const retained = latest && changed ? carryDraft(latest, submittedDraft, result.source) : null;
                    drafts.delete(target);
                    if (target) draftBases.delete(target);
                    if (retained) { drafts.set(result.source.id, retained); draftBases.set(result.source.id, draftOf(result.source)); }
                    if (state.selectedId === target) publish({ selectedId: result.source.id, draft: retained });
                    if (!current) { createIntent = null; uncertainDraft = null; inspectedCreateAbsence = false; createRetryConfirmed = false; publish({ uncertainCreate: false, creationDraft: null }); }
                    acknowledge(result.source, result.canManage, !current);
                    publish({ mutation: 'idle' });
                    return result.source;
                } else {
                    if (!current) { if (!uncertainDraft) createIntent = null; createRetryConfirmed = false; publish({ uncertainCreate: uncertainDraft !== null }); }
                    domainFailure(result, current?.id);
                }
                publish({ mutation: 'idle' });
            } catch (error) { if (!disposed) mutationFailure(error, current?.id ?? null, draft); }
        },
        async remove() {
            const current = state.current;
            if (disposed || !current || !state.canManage || state.mutation !== 'idle' || state.conflict || uncertainSources.has(current.id)) return;
            publish({ mutation: 'deleting', issue: null });
            try {
                const result = ProjectSourcesDeleteOutputV1Schema.parse(await invoke('projects.sources.delete', { serverId: scope.serverId, sourceId: current.id, expectedRevision: current.revision }));
                if (disposed) return;
                if (result.ok) {
                    forgetUnavailable(current.id, 'source_deleted');
                    if (state.selectedId === current.id) publish({ selectedId: null, detailStatus: 'initial', issue: null });
                } else domainFailure(result, current.id);
                publish({ mutation: 'idle' });
            } catch (error) { if (!disposed) mutationFailure(error, current.id); }
        },
        async updateSource(patch: ProjectSourcesUpdateInputV1['patch'], target?: Pick<ProjectSourceV1, 'id' | 'revision'>) {
            // Catalog gestures carry their own captured target. Editor selection
            // is presentation state, never authority to retarget an attachment.
    const current = target ?? state.current;
            if (disposed || !current || state.mutation !== 'idle' || uncertainSources.has(current.id)
                || conflicts.has(current.id) || (!target && (!state.canManage || state.conflict))) return null;
            publish({ mutation: 'saving', issue: null });
            try {
                const result = ProjectSourcesUpdateOutputV1Schema.parse(await invoke('projects.sources.update', { serverId: scope.serverId, sourceId: current.id, expectedRevision: current.revision, patch }));
                if (disposed) return null;
                if (result.ok) acknowledge(result.source, result.canManage);
                else domainFailure(result, current.id);
                publish({ mutation: 'idle' });
                return result;
            } catch (error) { if (!disposed) mutationFailure(error, current.id); return null; }
        },
        async refresh(options: Readonly<{ detailOnly?: boolean }> = {}): Promise<void> {
            if (disposed) return;
            const selected = state.selectedId;
            if (options.detailOnly) {
                if (selected) await controller.select(selected);
                return;
            }
            await Promise.all([controller.load(state.query, undefined, state.audience),
                ...(selected ? [controller.select(selected)] : [])]);
        },
    };
    function connectCatalog() {
        if (!catalog || stopCatalog || disposed) return;
        const read = () => {
            if (!catalog) return;
            const next = catalog.getSnapshot();
            if (next.issue === 'action_home_signed_out') {
                publish({ ...forgetCatalog(), ...catalogFields(next), issue: next.issue });
                return;
            }
            if (uncertainDraft && next.status === 'ready' && next.catalogQuery === '' && next.catalogAudience === undefined && next.coverage.complete) {
                const expected = createIdentity(uncertainDraft);
                inspectedCreateAbsence = !next.rows.some(row => createIdentity(draftOf(row)) === expected);
            }
            // Complete unfiltered absence is authoritative; paging/filtering is not revocation.
            if (next.status === 'refused' || (next.status === 'ready' && next.coverage.complete && next.catalogQuery === '' && !next.catalogAudience)) {
                const visible = new Set(next.rows.map(row => row.id));
                for (const id of details.keys()) if (!visible.has(id)) {
                    // Do not publish a removal back to the catalog while observing it.
                    details.delete(id); drafts.delete(id); draftBases.delete(id); conflicts.delete(id); uncertainSources.delete(id);
                    if (state.selectedId === id) publish({ current: null, canManage: false, draft: null, conflict: null,
                        detailStatus: 'refused', issue: next.issue ?? 'source_unavailable' });
                }
            }
            publish({ ...catalogFields(next), ...(!state.selectedId && !state.creationDraft ? { issue: uncertainDraft ? 'outcome_unknown' : next.issue } : {}) });
        };
        stopCatalog = catalog.subscribe(read);
        read();
    }
    return controller;
}
export type ProjectSourcesController = ReturnType<typeof createProjectSourcesController>;
