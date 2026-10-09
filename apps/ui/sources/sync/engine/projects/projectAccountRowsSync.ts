import {
    ProjectAccountRowPayloadV1Schema, ProjectAccountOrganizationV1Schema, ProjectAccountWorkspaceRefV1Schema,
    buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowListResponseV1,
    type ProjectAccountRowMutationRequestV1, type ProjectAccountRowMutationResponseV1,
    type ProjectAccountRowPayloadV1, type ProjectAccountRowV1, type ProjectAccountRowKeyV1,
    type ProjectAccountOrganizationV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { assertProjectAccountSnapshotTransition, parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import type { ProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefByAddress, resolveWorkspaceRefById, resolveWorkspaceRefByScope, resolveWorkspaceRefRemoval, upsertWorkspaceRefByScope,
    type WorkspaceRefAccountMutation, type WorkspaceRefAccountMutationResult } from '@/sync/domains/workspaces/workspaceRefs';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { ProjectAccountRowsSnapshot } from '@/sync/store/domains/projectAccountRows';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type ProjectAccountRowsTransport = Readonly<{
    list(options?: Readonly<{ signal?: AbortSignal }>): Promise<ProjectAccountRowListResponseV1>;
    mutate(input: ProjectAccountRowMutationRequestV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<ProjectAccountRowMutationResponseV1>;
}>;
type OpenedRow = Readonly<{ row: ProjectAccountRowV1; payload: ProjectAccountRowPayloadV1 | null }>;
function failure(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }

/** One Account/Home-owned materialization of the reserved physical rows. */
export function createProjectAccountRowsSync(options: Readonly<{
    scope: ServerAccountScope; transport: ProjectAccountRowsTransport; cipher: ProjectAccountRowCipherV1;
    isCurrent(): boolean; apply(snapshot: ProjectAccountRowsSnapshot): void;
    readRecency?(ref: WorkspaceRefV1): number | undefined;
    writeRecency?(ref: WorkspaceRefV1, timestamp: number): Promise<void>;
    readLegacyLabel?(key: string): string | undefined;
    retireLegacyLabel?(key: string, label: string): Promise<void>;
}>) {
    let opened: readonly OpenedRow[] = [];
    let refreshInFlight: Promise<ProjectAccountRowsSnapshot> | null = null;
    let readRecency = options.readRecency;
    function assertCurrent() { if (!options.isCurrent()) throw failure('project_account_scope_retired'); }
    function project(rows: readonly OpenedRow[]): ProjectAccountRowsSnapshot {
        const workspaceRefs: WorkspaceRefV1[] = [];
        const relationships: ProjectAccountRowsSnapshot['relationships'][number][] = [];
        const organizations: ProjectAccountRowsSnapshot['organizations'][number][] = [];
        const revisionsByPhysicalKey: Record<string, number> = {};
        for (const { row, payload } of rows) {
            const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
            if (identity in revisionsByPhysicalKey) throw failure('project_account_duplicate_row');
            revisionsByPhysicalKey[identity] = row.revision;
            if (!payload) {
                if (row.key.kind === 'relationship-graph') throw failure('project_account_graph_deleted');
                continue;
            }
            if (payload.key.kind === 'workspace-ref' && 'id' in payload.value) {
                const recent = readRecency?.(payload.value);
                workspaceRefs.push(recent === undefined ? payload.value : { ...payload.value, lastOpenedAtMs: recent });
            } else if (payload.key.kind === 'relationship-graph' && 'relationships' in payload.value) relationships.push(...payload.value.relationships);
            else if (payload.key.kind === 'project-organization' && !('id' in payload.value) && !('relationships' in payload.value)) {
                organizations.push({ key: payload.key, revision: row.revision, value: payload.value });
            } else throw failure('project_account_row_invalid');
        }
        const snapshot = parseProjectAccountSnapshotV1({ workspaceRefs, relationships });
        return { ...snapshot, scope: options.scope, status: 'ready', coverage: 'complete', organizations, revisionsByPhysicalKey };
    }
    function observe(rows: readonly ProjectAccountRowV1[]): ProjectAccountRowsSnapshot {
        assertCurrent();
        const incoming = rows.map(row => ({ row, payload: row.content === null ? null : options.cipher.open(row.key, row.content) }));
        const merged = new Map(opened.map(item => [buildProjectAccountRowPhysicalKeyV1(item.row.key), item]));
        const seen = new Set<string>();
        for (const item of incoming) {
            const key = buildProjectAccountRowPhysicalKeyV1(item.row.key);
            if (seen.has(key)) throw failure('project_account_duplicate_row');
            seen.add(key);
            const prior = merged.get(key);
            if (!prior || item.row.revision >= prior.row.revision) merged.set(key, item);
        }
        const next = [...merged.values()];
        const snapshot = project(next); // Open and validate the whole census before disclosing any row.
        assertCurrent(); opened = next; options.apply(snapshot); return snapshot;
    }
    async function refresh(signal?: AbortSignal): Promise<ProjectAccountRowsSnapshot> {
        signal?.throwIfAborted();
        assertCurrent();
        if (refreshInFlight) return await refreshInFlight;
        const task = (async () => {
            const result = await options.transport.list({ signal }); assertCurrent(); signal?.throwIfAborted();
            if (result.status !== 'listed') throw failure(`project_account_rows_${result.status}`);
            return observe(result.rows);
        })();
        refreshInFlight = task;
        try { return await task; } finally { if (refreshInFlight === task) refreshInFlight = null; }
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
        const changed = new Map(result.rows.map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row]));
        observe([...opened.map(item => changed.get(buildProjectAccountRowPhysicalKeyV1(item.row.key)) ?? item.row),
            ...result.rows.filter(row => !rowFor(row.key))]);
        return 'updated';
    }
    /** Caller-revision organization intents (Hide/Show and context) do not retry a stale decision. */
    async function mutateOrganizationAtRevision(input: Readonly<{
        serverId: string; projectKey: string; expectedRevision: number | 'absent'; signal?: AbortSignal;
        mutate(value: ProjectAccountOrganizationV1): ProjectAccountOrganizationV1;
    }>) {
        if (input.serverId !== options.scope.serverId) throw failure('project_account_scope_mismatch');
        await refresh(input.signal);
        const key = { kind: 'project-organization' as const, serverId: input.serverId, projectKey: input.projectKey };
        const previous = rowFor(key);
        const observed = previous?.row.revision ?? 'absent';
        if (observed !== input.expectedRevision) return { status: 'conflict' as const, revision: observed === 'absent' ? -1 : observed };
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
        const acknowledged = options.cipher.open(key, row.content);
        if (acknowledged.key.kind !== 'project-organization' || 'id' in acknowledged.value || 'relationships' in acknowledged.value) throw failure('project_account_row_acknowledgement_invalid');
        // An accepted effect receipt remains true after navigation; only the current Home gets its projection.
        if (options.isCurrent()) {
            const changed = new Map(result.rows.map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row]));
            observe([...opened.map(item => changed.get(buildProjectAccountRowPhysicalKeyV1(item.row.key)) ?? item.row), ...result.rows.filter(row => !rowFor(row.key))]);
        }
        return { status: 'updated' as const, revision: row.revision, value: acknowledged.value };
    }
    async function mutateWorkspaceMetadata(input: Readonly<{
        serverId: string; workspaceId: string; label?: string | null; pinned?: boolean; signal?: AbortSignal;
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
            const nextRef = input.label === undefined ? ref : { ...ref, label: input.label?.trim() || null };
            const nextOrganization = input.pinned === undefined ? organization : { ...organization, pinned: input.pinned };
            const request: ProjectAccountRowMutationRequestV1 = { mutations: [], expectedRefs: [], topologyChange: false };
            if (nextRef.label !== ref.label) {
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
    /** Source creation records provenance only on the exact checkout already accepted by this Account. */
    async function recordWorkspaceSource(
        address: WorkspaceAddressV1, source: NonNullable<WorkspaceRefV1['source']>, signal?: AbortSignal,
    ): Promise<Readonly<{ ok: true; workspaceRefId: string }> | Extract<WorkspaceRefAccountMutationResult, { ok: false }>> {
        if (!areServerProfileIdentifiersEquivalent(address.serverId, options.scope.serverId)) throw failure('project_account_scope_mismatch');
        while (true) {
            const before = await refresh(signal);
            const resolved = resolveWorkspaceRefByAddress(before.workspaceRefs, address);
            if (resolved.kind === 'missing') return { ok: false, code: 'workspace_ref_not_found' };
            if (resolved.kind === 'ambiguous') return { ok: false, code: 'workspace_ref_ambiguous' };
            if (resolved.kind === 'invalid') return { ok: false, code: 'workspace_ref_invalid' };
            const existing = resolved.ref;
            const { lastOpenedAtMs: _recency, ...accepted } = existing;
            const structural = ProjectAccountWorkspaceRefV1Schema.parse({ ...accepted, source });
            if (areAccountSettingsJsonValuesEqual(accepted, structural)) return { ok: true, workspaceRefId: existing.id };
            assertProjectAccountSnapshotTransition(before, { ...before,
                workspaceRefs: before.workspaceRefs.map(ref => ref === existing ? { ...ref, source: structural.source } : ref),
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
                if (rememberedOpen !== undefined) { await options.writeRecency?.(existing, rememberedOpen); options.apply(project(opened)); }
                return { ok: true, workspaceRefId: existing.id };
            }
            if (await commit(request, signal) === 'conflict') continue; // Re-read rows and re-admit this intent at the same semantic owner.
            if (rememberedOpen !== undefined) { await options.writeRecency?.(ref, rememberedOpen); options.apply(project(opened)); }
            if (intent.kind === 'migrate_label') { await options.retireLegacyLabel?.(intent.legacyKey, intent.label); return { ok: true, workspaceRefId: ref.id, migrated: true }; }
            return intent.kind === 'upsert' ? { ok: true, workspaceRefId: ref.id } : { ok: true };
        }
    }
    return { refresh, mutateRef, mutateWorkspaceMetadata, recordWorkspaceSource, mutateOrganizationAtRevision,
        refreshRecency: (reader?: typeof options.readRecency) => {
            assertCurrent();
            if (reader) readRecency = reader;
            options.apply(project(opened));
        } };
}
