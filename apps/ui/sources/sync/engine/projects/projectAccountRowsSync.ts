import {
    ProjectAccountRowPayloadV1Schema, ProjectAccountOrganizationV1Schema, ProjectAccountWorkspaceRefV1Schema,
    buildProjectAccountRowPhysicalKeyV1, parseProjectAccountRowPhysicalKeyV1,
    type ProjectAccountRowListResponseV1, type ProjectAccountRowReadResponseV1,
    type ProjectAccountRowMutationRequestV1, type ProjectAccountRowMutationResponseV1,
    type ProjectAccountRowPayloadV1, type ProjectAccountRowV1, type ProjectAccountRowKeyV1,
    type ProjectAccountOrganizationV1, type ProjectAccountAuthoringSessionV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { assertProjectAccountSnapshotTransition, parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import type { ProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefByAddress, resolveWorkspaceRefById, resolveWorkspaceRefByScope, resolveWorkspaceRefRemoval, upsertWorkspaceRefByScope,
    workspaceRefResolutionContextV1, type WorkspaceRefAccountMutation, type WorkspaceRefAccountMutationResult } from '@/sync/domains/workspaces/workspaceRefs';
import { resolveWorkspaceGroupingV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { ProjectAccountRowsSnapshot, ProjectAccountRowsMaterialization } from '@/sync/store/domains/projectAccountRows';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type ProjectAccountRowsTransport = Readonly<{
    read(key: ProjectAccountRowKeyV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<ProjectAccountRowReadResponseV1>;
    list(options?: Readonly<{ signal?: AbortSignal }>): Promise<ProjectAccountRowListResponseV1>;
    mutate(input: ProjectAccountRowMutationRequestV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<ProjectAccountRowMutationResponseV1>;
}>;
type OpenedRow = Readonly<{ row: ProjectAccountRowV1; payload: ProjectAccountRowPayloadV1 | null }>;
function failure(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }

/** One Account/Home-owned materialization of the reserved physical rows. */
export function createProjectAccountRowsSync(options: Readonly<{
    scope: ServerAccountScope; transport: ProjectAccountRowsTransport; cipher: ProjectAccountRowCipherV1;
    isCurrent(): boolean; apply(snapshot: ProjectAccountRowsSnapshot, source: 'census' | 'projection', materialization?: ProjectAccountRowsMaterialization): void;
    onRefreshFailure?(error: unknown): void;
    readRecency?(ref: WorkspaceRefV1): number | undefined;
    writeRecency?(ref: WorkspaceRefV1, timestamp: number): Promise<void>;
    readLegacyLabel?(key: string): string | undefined;
    retireLegacyLabel?(key: string, label: string): Promise<void>;
}>) {
    let opened: readonly OpenedRow[] = [];
    // Last disclosed snapshot once a census admitted the topology; exact change hints keep it current.
    let held: ProjectAccountRowsSnapshot | null = null;
    let censused = false;
    const materializationWaiters = new Set<(error?: unknown, physicalKey?: string) => void>();
    function notifyMaterialization(error?: unknown, physicalKey?: string) {
        for (const waiter of materializationWaiters) waiter(error, physicalKey);
    }
    function disclose(snapshot: ProjectAccountRowsSnapshot, source: 'census' | 'projection', materialization?: ProjectAccountRowsMaterialization) {
        held = snapshot; if (source === 'census') censused = true;
        options.apply(snapshot, source, materialization);
    }
    let refreshInFlight: Promise<ProjectAccountRowsSnapshot> | null = null;
    let readRecency = options.readRecency;
    function assertCurrent() { if (!options.isCurrent()) throw failure('project_account_scope_retired'); }
    function project(rows: readonly OpenedRow[]): ProjectAccountRowsSnapshot {
        const workspaceRefs: WorkspaceRefV1[] = [];
        const relationships: ProjectAccountRowsSnapshot['relationships'][number][] = [];
        const organizations: ProjectAccountRowsSnapshot['organizations'][number][] = [];
        const revisionsByPhysicalKey: Record<string, number> = {};
        const authoringSessionsByPhysicalKey: Record<string, ProjectAccountAuthoringSessionV1> = {};
        for (const { row, payload } of rows) {
            const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
            if (identity in revisionsByPhysicalKey) throw failure('project_account_duplicate_row');
            revisionsByPhysicalKey[identity] = row.revision;
            if (!payload) {
                if (row.key.kind === 'relationship-graph') throw failure('project_account_graph_deleted');
                continue;
            }
            if (payload.key.kind === 'workspace-ref' && 'id' in payload.value) {
                if (row.authoringSession) authoringSessionsByPhysicalKey[identity] = row.authoringSession;
                const recent = readRecency?.(payload.value);
                workspaceRefs.push(recent === undefined ? payload.value : { ...payload.value, lastOpenedAtMs: recent });
            } else if (payload.key.kind === 'relationship-graph' && 'relationships' in payload.value) relationships.push(...payload.value.relationships);
            else if (payload.key.kind === 'project-organization' && !('id' in payload.value) && !('relationships' in payload.value)) {
                organizations.push({ key: payload.key, revision: row.revision, value: payload.value });
            } else throw failure('project_account_row_invalid');
        }
        const snapshot = parseProjectAccountSnapshotV1({ workspaceRefs, relationships });
        return { ...snapshot, scope: options.scope, status: 'ready', coverage: 'complete', organizations, revisionsByPhysicalKey, authoringSessionsByPhysicalKey };
    }
    function observe(rows: readonly ProjectAccountRowV1[], source: 'census' | 'projection' = 'projection', materialization?: ProjectAccountRowsMaterialization): ProjectAccountRowsSnapshot {
        assertCurrent();
        const merged = new Map(opened.map(item => [buildProjectAccountRowPhysicalKeyV1(item.row.key), item]));
        for (const key of materialization?.absentPhysicalKeys ?? []) merged.delete(key);
        const seen = new Set<string>();
        for (const row of rows) {
            const key = buildProjectAccountRowPhysicalKeyV1(row.key);
            if (seen.has(key)) throw failure('project_account_duplicate_row');
            seen.add(key);
            const prior = merged.get(key);
            if (!prior || row.revision >= prior.row.revision) {
                const payload = row.content === null ? null
                    : prior && areAccountSettingsJsonValuesEqual(prior.row.content, row.content)
                        ? prior.payload : options.cipher.open(row.key, row.content);
                // Legacy-shaped structural acknowledgements omit this server-owned leaf.
                // The relation changes only through its record operation, or checkout deletion.
                const authoringSession = row.content !== null ? row.authoringSession ?? prior?.row.authoringSession : undefined;
                merged.set(key, { row: authoringSession ? { ...row, authoringSession } : row, payload });
            }
        }
        const next = [...merged.values()];
        const snapshot = project(next); // Validate the complete admitted topology before disclosing any row.
        assertCurrent(); opened = next; disclose(snapshot, source, materialization);
        if (source === 'census') notifyMaterialization();
        else {
            for (const key of seen) notifyMaterialization(undefined, key);
            for (const key of materialization?.absentPhysicalKeys ?? []) notifyMaterialization(undefined, key);
        }
        return snapshot;
    }
    async function refresh(signal?: AbortSignal): Promise<ProjectAccountRowsSnapshot> {
        signal?.throwIfAborted();
        assertCurrent();
        if (refreshInFlight) return await refreshInFlight;
        const task = (async () => {
            const result = await options.transport.list({ signal }); assertCurrent(); signal?.throwIfAborted();
            if (result.status !== 'listed') throw failure(`project_account_rows_${result.status}`);
            return observe(result.rows, 'census');
        })();
        refreshInFlight = task;
        try { return await task; }
        catch (error: unknown) {
            notifyMaterialization(error);
            if (options.isCurrent()) options.onRefreshFailure?.(error);
            throw error;
        } finally { if (refreshInFlight === task) refreshInFlight = null; }
    }
    /** The held admitted rows; only the first read is a census. A long-lived owner stays current through `refreshKeys`. */
    async function read(signal?: AbortSignal): Promise<ProjectAccountRowsSnapshot> {
        signal?.throwIfAborted(); assertCurrent();
        return censused && held ? held : await refresh(signal);
    }
    /** An Open ACK commits a ref; its existing change hint completes the app's materialization. */
    async function waitForWorkspaceRef(address: WorkspaceAddressV1, signal?: AbortSignal): Promise<WorkspaceRefV1> {
        await read(signal);
        signal?.throwIfAborted(); assertCurrent();
        const key = { kind: 'workspace-ref' as const, serverId: address.serverId, id: address.workspaceId };
        const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
        return await new Promise<WorkspaceRefV1>((resolve, reject) => {
            const finish = (error?: unknown, ref?: WorkspaceRefV1) => {
                materializationWaiters.delete(observeMaterialization);
                signal?.removeEventListener('abort', abort);
                if (error !== undefined) reject(error); else resolve(ref!);
            };
            const abort = () => finish(signal?.reason ?? failure('cancelled'));
            const observeMaterialization = (error?: unknown, changedKey?: string) => {
                if (changedKey !== undefined && changedKey !== physicalKey) return;
                try {
                    assertCurrent(); signal?.throwIfAborted();
                    if (error !== undefined) { finish(error); return; }
                    const resolved = resolveWorkspaceRefByAddress(held?.workspaceRefs ?? [], address);
                    if (resolved.kind === 'resolved') { finish(undefined, resolved.ref); return; }
                    if (changedKey === physicalKey || rowFor(key)?.row.content === null)
                        finish(failure('workspace_ref_not_found'));
                } catch (error: unknown) { finish(error); }
            };
            materializationWaiters.add(observeMaterialization);
            signal?.addEventListener('abort', abort, { once: true });
            observeMaterialization();
        });
    }
    /** Exact change hints patch the admitted census; failed keys never become checkpoint proof. */
    async function refreshKeys(physicalKeys: readonly string[], signal?: AbortSignal): Promise<ReadonlySet<string>> {
        assertCurrent(); signal?.throwIfAborted();
        const results = await Promise.allSettled([...new Set(physicalKeys)].map(async physicalKey => {
            try {
                const key = parseProjectAccountRowPhysicalKeyV1(physicalKey);
                if (!key) throw failure('project_account_row_invalid');
                const result = await options.transport.read(key, { signal });
                if (result.status === 'present') return { physicalKey, row: result.row };
                if (result.status === 'deleted') return { physicalKey, row: { key, revision: result.revision, content: null } };
                if (result.status === 'absent') return { physicalKey, row: null };
                throw failure(`project_account_rows_${result.status}`);
            } catch (error: unknown) {
                notifyMaterialization(error, physicalKey);
                throw error;
            }
        }));
        assertCurrent(); signal?.throwIfAborted();
        const completed = new Set<string>();
        const rows: ProjectAccountRowV1[] = [];
        const absentPhysicalKeys: string[] = [];
        let failed = false;
        for (const result of results) {
            if (result.status === 'rejected') {
                failed = true;
                options.onRefreshFailure?.(result.reason);
            } else {
                completed.add(result.value.physicalKey);
                if (result.value.row) rows.push(result.value.row);
                else absentPhysicalKeys.push(result.value.physicalKey);
            }
        }
        // An auth/mode failure can retire the owner through its existing failure callback.
        assertCurrent();
        if (completed.size === 0) return completed;
        try {
            observe(rows, 'projection', { absentPhysicalKeys, refreshSucceeded: !failed });
        } catch (error: unknown) {
            notifyMaterialization(error);
            if (options.isCurrent()) options.onRefreshFailure?.(error);
            throw error;
        }
        return completed;
    }
    function rowFor(key: ProjectAccountRowKeyV1) { const id = buildProjectAccountRowPhysicalKeyV1(key); return opened.find(item => buildProjectAccountRowPhysicalKeyV1(item.row.key) === id); }
    function mutation(payload: ProjectAccountRowPayloadV1 | null, key: ProjectAccountRowKeyV1) {
        return { key, expectedRevision: rowFor(key)?.row.revision ?? 'absent' as const,
            content: payload === null ? null : options.cipher.seal(ProjectAccountRowPayloadV1Schema.parse(payload)) };
    }
    function assertAcknowledgement(request: ProjectAccountRowMutationRequestV1, result: Extract<ProjectAccountRowMutationResponseV1, { status: 'updated' }>) {
        if (result.rows.length !== request.mutations.length) throw failure('project_account_row_acknowledgement_invalid');
        for (const intent of request.mutations) {
            const acknowledged = result.rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(intent.key));
            if (!acknowledged || acknowledged.revision !== (intent.expectedRevision === 'absent' ? 0 : intent.expectedRevision + 1)
                || !areAccountSettingsJsonValuesEqual(acknowledged.content, intent.content)) throw failure('project_account_row_acknowledgement_invalid');
        }
    }
    async function commit(request: ProjectAccountRowMutationRequestV1, signal?: AbortSignal): Promise<'updated' | 'conflict'> {
        assertCurrent(); signal?.throwIfAborted();
        const result = await options.transport.mutate(request, { signal }); assertCurrent();
        if (result.status === 'conflict') return 'conflict';
        if (result.status !== 'updated') throw failure(`project_account_rows_${result.status}`);
        assertAcknowledgement(request, result);
        observe(result.rows);
        return 'updated';
    }
    /** Functional intents use the fresh row; explicit caller revisions never retry a stale decision. */
    async function mutateOrganizationAtRevision(input: Readonly<{
        serverId: string; projectKey: string; expectedRevision?: number | 'absent'; signal?: AbortSignal;
        mutate(value: ProjectAccountOrganizationV1): ProjectAccountOrganizationV1;
    }>) {
        if (input.serverId !== options.scope.serverId) throw failure('project_account_scope_mismatch');
        await refresh(input.signal);
        const key = { kind: 'project-organization' as const, serverId: input.serverId, projectKey: input.projectKey };
        const previous = rowFor(key);
        const observed = previous?.row.revision ?? 'absent';
        if (input.expectedRevision !== undefined && observed !== input.expectedRevision) return { status: 'conflict' as const, revision: observed === 'absent' ? -1 : observed };
        const payload = previous?.payload;
        const before = payload && !('id' in payload.value) && !('relationships' in payload.value) ? payload.value : {};
        const value = ProjectAccountOrganizationV1Schema.parse(input.mutate(before));
        assertCurrent(); input.signal?.throwIfAborted();
        if (previous?.payload && areAccountSettingsJsonValuesEqual(before, value)) {
            return { status: 'updated' as const, revision: previous.row.revision, value: before };
        }
        const request = { mutations: [mutation({ key, value }, key)], expectedRefs: [], topologyChange: false } satisfies ProjectAccountRowMutationRequestV1;
        const result = await options.transport.mutate(request, { signal: input.signal });
        if (result.status === 'conflict') return { status: 'conflict' as const, revision: result.revision };
        if (result.status !== 'updated') throw failure(`project_account_rows_${result.status}`);
        assertAcknowledgement(request, result);
        const row = result.rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
        if (!row?.content) throw failure('project_account_row_acknowledgement_invalid');
        // The acknowledgement matches the exact locally sealed intent above. Its
        // parsed value is also the receipt when a newer projection already won.
        // An accepted effect receipt remains true after navigation; only the current Home gets its projection.
        if (options.isCurrent()) {
            observe(result.rows);
        }
        return { status: 'updated' as const, revision: row.revision, value };
    }
    async function mutateWorkspaceMetadata(input: Readonly<{
        serverId: string; workspaceId: string; label?: string | null; pinned?: boolean; projectKey?: string; signal?: AbortSignal;
    }>) {
        if (!areServerProfileIdentifiersEquivalent(input.serverId, options.scope.serverId)) throw failure('project_account_scope_mismatch');
        while (true) {
            const before = await refresh(input.signal);
            const resolved = resolveWorkspaceRefById(before.workspaceRefs, input.workspaceId, input.serverId);
            if (resolved.kind !== 'resolved') throw failure(`workspace_ref_${resolved.kind}`);
            const ref = resolved.ref;
            const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
            const organizationKey = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id };
            const previous = rowFor(organizationKey)?.payload;
            const organization = previous && !('id' in previous.value) && !('relationships' in previous.value) ? previous.value : {};
            // The person's grouping (owner 11-08): the one owner decides the explicit key; nothing else is rewritten.
            const grouping = input.projectKey === undefined ? null
                : resolveWorkspaceGroupingV1(before.workspaceRefs, ref, input.projectKey, workspaceRefResolutionContextV1());
            if (grouping && !grouping.ok) throw failure(grouping.code);
            const labeled = input.label === undefined ? ref : { ...ref, label: input.label?.trim() || null };
            const nextRef = grouping ? { ...labeled, projectKey: grouping.projectKey } : labeled;
            const nextOrganization = input.pinned === undefined ? organization : { ...organization, pinned: input.pinned };
            const request: ProjectAccountRowMutationRequestV1 = { mutations: [], expectedRefs: [], topologyChange: false };
            if (nextRef.label !== ref.label || nextRef.projectKey !== ref.projectKey) {
                const { lastOpenedAtMs: _recency, ...structural } = nextRef;
                request.mutations.push(mutation({ key, value: ProjectAccountWorkspaceRefV1Schema.parse(structural) }, key));
            }
            if (!areAccountSettingsJsonValuesEqual(organization, nextOrganization)) {
                request.mutations.push(mutation({ key: organizationKey, value: ProjectAccountOrganizationV1Schema.parse(nextOrganization) }, organizationKey));
            }
            if (request.mutations.length === 0) return { workspaceRef: nextRef, organization: nextOrganization };
            assertProjectAccountSnapshotTransition(before, { ...before, workspaceRefs: before.workspaceRefs.map(item => item === ref ? nextRef : item) });
            input.signal?.throwIfAborted();
            if (await commit(request, input.signal) === 'conflict') continue;
            return { workspaceRef: nextRef, organization: nextOrganization };
        }
    }
    /** Accepted Source/SCM observations patch only the exact checkout already owned by this Account. */
    async function recordWorkspaceFacts(
        address: WorkspaceAddressV1, facts: Pick<WorkspaceRefV1, 'source' | 'repositoryIdentity'>, signal?: AbortSignal,
    ): Promise<Readonly<{ ok: true; workspaceRefId: string }> | Extract<WorkspaceRefAccountMutationResult, { ok: false }>> {
        if (!areServerProfileIdentifiersEquivalent(address.serverId, options.scope.serverId)) throw failure('project_account_scope_mismatch');
        while (true) {
            const before = await refresh(signal);
            const resolved = resolveWorkspaceRefByAddress(before.workspaceRefs, address);
            if (resolved.kind === 'missing') return { ok: false, code: 'workspace_ref_not_found' };
            if (resolved.kind === 'ambiguous') return { ok: false, code: 'workspace_ref_ambiguous' };
            if (resolved.kind === 'invalid') return { ok: false, code: 'workspace_ref_invalid' };
            const existing = resolved.ref;
            // Navigation never overwrites a retained identity. A new ordinary SCM
            // observation can fill a missing one; changed-identity decisions stay upstream.
            if (facts.repositoryIdentity && existing.repositoryIdentity) return { ok: true, workspaceRefId: existing.id };
            const { lastOpenedAtMs: _recency, ...accepted } = existing;
            const structural = ProjectAccountWorkspaceRefV1Schema.parse({ ...accepted, ...facts });
            if (areAccountSettingsJsonValuesEqual(accepted, structural)) return { ok: true, workspaceRefId: existing.id };
            assertProjectAccountSnapshotTransition(before, { ...before,
                workspaceRefs: before.workspaceRefs.map(ref => ref === existing ? { ...ref, ...facts } : ref),
            });
            const key = { kind: 'workspace-ref' as const, serverId: existing.serverId, id: existing.id };
            const request = { mutations: [mutation({ key, value: structural }, key)], expectedRefs: [], topologyChange: false } satisfies ProjectAccountRowMutationRequestV1;
            if (await commit(request, signal) === 'conflict') continue;
            return { ok: true, workspaceRefId: existing.id };
        }
    }
    async function mutateRef(intent: WorkspaceRefAccountMutation, signal?: AbortSignal): Promise<WorkspaceRefAccountMutationResult> {
        const home = intent.kind === 'upsert' || intent.kind === 'migrate_label' ? intent.scope.serverId : intent.serverId;
        if (!areServerProfileIdentifiersEquivalent(home, options.scope.serverId)) throw failure('project_account_scope_mismatch');
        while (true) {
            const before = await refresh(signal);
            const resolution = intent.kind === 'upsert' || intent.kind === 'migrate_label'
                ? resolveWorkspaceRefByScope(before.workspaceRefs, intent.scope)
                : resolveWorkspaceRefById(before.workspaceRefs, intent.workspaceRefId, intent.serverId);
            if (resolution.kind === 'ambiguous') return { ok: false, code: 'workspace_ref_ambiguous' };
            if (resolution.kind === 'invalid') return { ok: false, code: 'workspace_ref_invalid' };
            const existing = resolution.kind === 'resolved' ? resolution.ref : null;
            if (intent.kind === 'set_pinned' || intent.kind === 'set_label') {
                if (!existing) return { ok: false, code: 'workspace_ref_not_found' };
                await mutateWorkspaceMetadata({ serverId: existing.serverId, workspaceId: existing.id,
                    ...(intent.kind === 'set_pinned' ? { pinned: intent.pinned } : { label: intent.label }), signal });
                return { ok: true };
            }
            let nextRefs: readonly WorkspaceRefV1[];
            let target: WorkspaceRefV1 | null = existing;
            let rememberedOpen: number | undefined;
            if (intent.kind === 'upsert' || intent.kind === 'migrate_label') {
                if (intent.kind === 'migrate_label' && (options.readLegacyLabel?.(intent.legacyKey) !== intent.label || existing?.label)) return { ok: true, workspaceRefId: existing?.id, migrated: false };
                const patch = intent.kind === 'migrate_label' ? { label: intent.label } : intent.patch;
                const { lastOpenedAtMs, ...structuralPatch } = patch;
                nextRefs = upsertWorkspaceRefByScope(before.workspaceRefs, { scope: intent.scope, nowMs: intent.nowMs, patch: structuralPatch });
                const resolved = resolveWorkspaceRefByScope(nextRefs, intent.scope);
                target = resolved.kind === 'resolved' ? resolved.ref : null;
                if (!target) return { ok: false, code: 'workspace_ref_not_found' };
                if (lastOpenedAtMs != null) rememberedOpen = lastOpenedAtMs;
            } else {
                if (!existing) return { ok: true };
                const result = resolveWorkspaceRefRemoval(before.workspaceRefs, { serverId: existing.serverId, workspaceRefId: existing.id, relationships: before.relationships });
                if (!result.ok) return result;
                nextRefs = result.workspaceRefs; target = null;
            }
            assertProjectAccountSnapshotTransition(before, { workspaceRefs: nextRefs, relationships: before.relationships });
            const ref = target ?? existing!;
            const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
            const structural = target ? ProjectAccountWorkspaceRefV1Schema.parse((({ lastOpenedAtMs: _recency, ...value }) => value)(target)) : null;
            const topologyChange = !existing || target === null;
            const request: ProjectAccountRowMutationRequestV1 = { mutations: [mutation(structural ? { key, value: structural } : null, key)], expectedRefs: [], topologyChange };
            if (topologyChange) {
                const graph = { kind: 'relationship-graph' as const };
                request.mutations.push(mutation({ key: graph, value: { relationships: [...before.relationships] } }, graph));
                // The ref mutation already carries its CAS. The unchanged graph CAS
                // fences concurrent links without contending on unrelated labels.
            } else if (existing && structural && areAccountSettingsJsonValuesEqual(ProjectAccountWorkspaceRefV1Schema.parse((({ lastOpenedAtMs: _recency, ...value }) => value)(existing)), structural)) {
                if (rememberedOpen !== undefined) { await options.writeRecency?.(existing, rememberedOpen); disclose(project(opened), 'projection'); }
                return { ok: true, workspaceRefId: existing.id };
            }
            if (await commit(request, signal) === 'conflict') continue; // Re-read rows and re-admit this intent at the same semantic owner.
            if (rememberedOpen !== undefined) { await options.writeRecency?.(ref, rememberedOpen); disclose(project(opened), 'projection'); }
            if (intent.kind === 'migrate_label') { await options.retireLegacyLabel?.(intent.legacyKey, intent.label); return { ok: true, workspaceRefId: ref.id, migrated: true }; }
            return intent.kind === 'upsert' ? { ok: true, workspaceRefId: ref.id } : { ok: true };
        }
    }
    return { read, refresh, refreshKeys, waitForWorkspaceRef, mutateRef, mutateWorkspaceMetadata,
        recordWorkspaceSource: (address: WorkspaceAddressV1, source: NonNullable<WorkspaceRefV1['source']>, signal?: AbortSignal) =>
            recordWorkspaceFacts(address, { source }, signal),
        recordWorkspaceRepositoryIdentity: (address: WorkspaceAddressV1, repositoryIdentity: NonNullable<WorkspaceRefV1['repositoryIdentity']>, signal?: AbortSignal) =>
            recordWorkspaceFacts(address, { repositoryIdentity }, signal),
        mutateOrganizationAtRevision,
        refreshRecency: (reader?: typeof options.readRecency) => {
            assertCurrent();
            if (reader) readRecency = reader;
            disclose(project(opened), 'projection');
        } };
}
