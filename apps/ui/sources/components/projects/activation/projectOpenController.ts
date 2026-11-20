import { isActionOutcomeUnknownErrorCodeV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { OpenProjectResultV1Schema, type OpenProjectInputV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { isManagedWorkspaceRefV2, type WorkspaceAddressV2, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ProjectOpenDraftDocumentV2Schema, type OpenProjectDraftSelectionV1 } from '@happier-dev/protocol/projects/openProjectDraftV1';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areSessionDraftCurrentnessCapturesEqual, type SessionDraftRepository, type ProjectOpenDraftPatch } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildProjectOpenInput } from './projectOpenChoices';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

export type ProjectOpenOutcome = OpenProjectResultV1 | Extract<ActionExecuteResult, { ok: false }>;
export type ProjectOpenAttempt = Readonly<{ input: OpenProjectInputV1; result: ProjectOpenOutcome }>;
export type ProjectOpenSnapshot = Readonly<{
    draft: OpenProjectDraftSelectionV1 | null;
    pending: boolean;
    checking: boolean;
    canCheck: boolean;
    uncertainInput: OpenProjectInputV1 | null;
    result: ProjectOpenOutcome | null;
    retiredAttempt: ProjectOpenAttempt | null;
}>;
export type ProjectOpenControllerOptions = Readonly<{
    initialDraft?: OpenProjectDraftSelectionV1;
    seedIfMissing?: boolean;
    repository: Pick<SessionDraftRepository, 'getSessionDraftSnapshot' | 'subscribeSessionDraft' | 'writeProjectOpenDraft'
        | 'flushSessionDraftLocally' | 'flushProjectOpenDraftForAdmission' | 'captureSessionDraftCurrentness'>;
    scope: ServerAccountScope;
    draftId: string;
    executor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute' | 'executeConfirmed'>;
    captureLifetime(): ServerAccountScopeLifetime | null;
    getCheckouts?(): readonly WorkspaceRefV1[];
    onOpened(result: Extract<OpenProjectResultV1, { kind: 'opened' }>, isCurrent: () => boolean): void | Promise<void>;
}>;
export type ProjectOpenController = Readonly<{
    getSnapshot(): ProjectOpenSnapshot;
    subscribe(listener: () => void): () => void;
    setDraft(draft: OpenProjectDraftSelectionV1 | null): void;
    submit(): Promise<void>;
    check(): Promise<void>;
    cancel(): void;
    dispose(): void;
}>;

function matchesOpenDestination(input: OpenProjectInputV1, workspace: WorkspaceAddressV2): boolean {
    if (!areServerProfileIdentifiersEquivalent(workspace.serverId, input.serverId)) return false;
    const target = 'targetManaged' in input.materialization ? input.materialization.targetManaged : undefined;
    if (!target) return !isManagedWorkspaceRefV2(workspace) && workspace.machineId === input.machineId;
    return isManagedWorkspaceRefV2(workspace) && workspace.managedId === target.managedId
        && workspace.controller.machineId === target.controller.machineId
        && workspace.controller.installationId === target.controller.installationId;
}

/** Only confirmation admits the Action; the incumbent draft owns recovery across mounts. */
export function createProjectOpenController(options: ProjectOpenControllerOptions): ProjectOpenController {
    const { repository, scope, draftId } = options;
    const address = { kind: 'projectOpen' as const, draftId };
    const read = () => {
        const parsed = ProjectOpenDraftDocumentV2Schema.safeParse(repository.getSessionDraftSnapshot(scope, address)?.document);
        return parsed.success ? parsed.data : null;
    };
    let unavailable = repository.getSessionDraftSnapshot(scope, address) !== null && read() === null;
    if (!repository.getSessionDraftSnapshot(scope, address)) {
        if (options.seedIfMissing === false) unavailable = true;
        else try { repository.writeProjectOpenDraft({ scope, draftId,
            patch: { selection: options.initialDraft ?? { serverId: scope.serverId } }, materializationIntent: 'seeded' }); }
        catch { unavailable = true; }
    }
    const document = read();
    const unknownEvidence = (latest = read()): Extract<OpenProjectResultV1, { kind: 'outcomeUnknown' }> => {
        const result = latest?.result.value;
        const retired = latest?.retiredAttempt.value?.result;
        return result?.kind === 'outcomeUnknown' ? result : retired?.kind === 'outcomeUnknown' ? retired : { kind: 'outcomeUnknown' as const };
    };
    let snapshot: ProjectOpenSnapshot = { draft: document?.selection.value ?? null, pending: false, checking: false, canCheck: false, uncertainInput: null,
        result: unavailable ? { ok: false, errorCode: 'project_open_draft_unavailable', error: 'project_open_draft_unavailable' }
            : document?.result.value ?? null, retiredAttempt: document?.retiredAttempt.value ?? null };
    const listeners = new Set<() => void>();
    let active: { retire(): void; promise: Promise<void> } | null = null;
    let disposed = false;
    const publish = (next: ProjectOpenSnapshot) => {
        const latest = read();
        const inputs = latest?.uncertainInputs.value;
        const uncertainInput = inputs?.length === 1 ? inputs[0]! : null;
        const evidence = unknownEvidence(latest);
        snapshot = { ...next, uncertainInput, canCheck: Boolean(uncertainInput && evidence.operationId),
            // Retired unknown evidence must remain inspectable without exposing
            // an old opened address as the new selection's result.
            result: next.result ?? (inputs?.length ? evidence : null) };
        for (const listener of listeners) listener();
    };
    publish(snapshot);
    const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    const refresh = () => {
        const latest = read();
        if (!latest) return;
        unavailable = false;
        publish({ ...snapshot, draft: latest.selection.value, result: latest.result.value,
            retiredAttempt: latest.retiredAttempt.value });
    };
    const write = (patch: ProjectOpenDraftPatch) => {
        // Repository notifications own change detection, including writes made
        // before a view subscribes or while an unsubscribed attempt settles.
        const unsubscribeWrite = unsubscribe ? null : repository.subscribeSessionDraft(scope, address, refresh);
        try { repository.writeProjectOpenDraft({ scope, draftId, patch }); }
        finally { unsubscribeWrite?.(); }
    };
    const selectionCurrentness = () => repository.captureSessionDraftCurrentness({ scope, address, fieldIds: ['selection'] });
    let unsubscribe: (() => void) | null = null;
    return {
        getSnapshot: () => snapshot,
        subscribe: listener => {
            listeners.add(listener);
            if (!unsubscribe) { unsubscribe = repository.subscribeSessionDraft(scope, address, refresh); refresh(); }
            return () => { listeners.delete(listener); if (listeners.size === 0) { unsubscribe?.(); unsubscribe = null; } };
        },
        setDraft: draft => {
            active?.retire();
            if (unavailable) { publish({ ...snapshot, result: failure('project_open_draft_unavailable') }); return; }
            try { write({ selection: draft, result: (read()?.uncertainInputs.value.length ?? 0) > 0
                ? unknownEvidence() : null }); }
            catch { publish({ ...snapshot, result: failure('project_open_draft_unavailable') }); return; }
        },
        cancel: () => {
            active?.retire();
            if (snapshot.pending || snapshot.checking) publish({ ...snapshot, pending: false, checking: false });
        },
        dispose: () => { disposed = true; active?.retire(); unsubscribe?.(); unsubscribe = null; listeners.clear(); },
        check: () => {
            if (active) return active.promise;
            const original = read()?.uncertainInputs.value;
            const evidence = unknownEvidence();
            if (disposed || original?.length !== 1 || !evidence.operationId) return Promise.resolve();
            const input = original[0]!;
            const operationId = evidence.operationId;
            const lifetime = options.captureLifetime();
            if (!lifetime?.isCurrent() || lifetime.scope.accountId !== scope.accountId
                || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, input.serverId)) return Promise.resolve();
            const capture = selectionCurrentness();
            const selected = snapshot.draft ? buildProjectOpenInput(snapshot.draft, options.getCheckouts?.() ?? []) : null;
            const selectionIsOriginal = selected !== null
                && createCanonicalJsonSigningInput(selected) === createCanonicalJsonSigningInput(input);
            const abort = new AbortController();
            let retired = false;
            const retire = () => { retired = true; abort.abort(); };
            const retirement = lifetime.onRetire(retire);
            const isCurrent = () => !disposed && !retired && lifetime.isCurrent()
                && areSessionDraftCurrentnessCapturesEqual(capture, selectionCurrentness());
            const attempt = { retire, promise: Promise.resolve() };
            active = attempt;
            publish({ ...snapshot, checking: true });
            attempt.promise = (async () => {
                try {
                    const readResult = await options.executor.execute('action.operations.get', {
                        serverId: input.serverId, machineId: input.machineId, operationId,
                    }, { surface: 'ui', authority: 'present_user', serverId: input.serverId,
                        expectedAccountId: lifetime.scope.accountId, signal: abort.signal });
                    if (!isCurrent() || !readResult.ok) return;
                    const found = ActionOperationGetV1ResponseSchema.safeParse(readResult.result);
                    if (!found.success || found.data.kind !== 'found') return;
                    const operation = found.data.operation;
                    if (operation.operationId !== operationId || operation.actionId !== 'projects.open'
                        || operation.scope.accountId !== scope.accountId || operation.scope.machineId !== input.machineId
                        || operation.state !== 'succeeded') return;
                    const settlement = OpenProjectResultV1Schema.safeParse(operation.result);
                    if (!settlement.success || !['opened', 'refused', 'outcomeUnknown'].includes(settlement.data.kind)) return;
                    const result = settlement.data;
                    if (result.kind === 'outcomeUnknown') return; // Observation is not confirmation of an effect.
                    if (result.kind === 'opened' && !matchesOpenDestination(input, result.workspace)) return;
                    write({ uncertainInputs: [], ...(selectionIsOriginal ? { result } : { result: null, retiredAttempt: { input, result } }) });
                    await repository.flushSessionDraftLocally({ scope });
                    if (isCurrent() && selectionIsOriginal && result.kind === 'opened') await options.onOpened(result, isCurrent);
                } catch {
                    // A missing/retired/unavailable observation never authorizes replay or deletion.
                } finally {
                    retirement.dispose();
                    if (active === attempt) active = null;
                    publish({ ...snapshot, checking: false });
                }
            })();
            return attempt.promise;
        },
        submit: () => {
            if (active) return active.promise;
            if (disposed) return Promise.resolve();
            // Unfinished edits and Source metadata changes are not reconciliation.
            if ((read()?.uncertainInputs.value.length ?? 0) > 0) {
                publish({ ...snapshot, result: unknownEvidence() });
                return Promise.resolve();
            }
            const accepted = read()?.result.value;
            if (accepted?.kind === 'opened') {
                const lifetime = options.captureLifetime();
                const capture = selectionCurrentness();
                let retired = false;
                const isCurrent = () => !disposed && !retired && Boolean(lifetime?.isCurrent())
                    && Boolean(lifetime && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, accepted.workspace.serverId))
                    && lifetime?.scope.accountId === scope.accountId
                    && areSessionDraftCurrentnessCapturesEqual(capture, selectionCurrentness());
                if (!isCurrent()) return Promise.resolve();
                const attempt = { retire: () => { retired = true; }, promise: Promise.resolve() };
                active = attempt;
                publish({ ...snapshot, pending: true });
                attempt.promise = Promise.resolve().then(() => {
                    if (isCurrent()) return options.onOpened(accepted, isCurrent);
                }).finally(() => {
                    if (active === attempt) active = null;
                    publish({ ...snapshot, pending: false });
                });
                return attempt.promise;
            }
            const input = snapshot.draft ? buildProjectOpenInput(snapshot.draft, options.getCheckouts?.() ?? []) : null;
            if (!input) {
                publish({ ...snapshot, result: failure('invalid_parameters') });
                return Promise.resolve();
            }
            const lifetime = options.captureLifetime();
            if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, input.serverId)
                || lifetime.scope.accountId !== scope.accountId) {
                publish({ ...snapshot, result: failure('action_account_scope_changed') });
                return Promise.resolve();
            }
            const capture = selectionCurrentness();
            const abort = new AbortController();
            let retired = false;
            const retire = () => { retired = true; abort.abort(); };
            const retirement = lifetime.onRetire(retire);
            const attempt = { retire, promise: Promise.resolve() };
            active = attempt;
            publish({ ...snapshot, pending: true, result: null });
            attempt.promise = (async () => {
                let result: ProjectOpenOutcome;
                let issued = false;
                try {
                    write({ uncertainInputs: [input], result: { kind: 'outcomeUnknown' } });
                    await repository.flushProjectOpenDraftForAdmission({ scope, draftId });
                    if (retired || !lifetime.isCurrent()
                        || !areSessionDraftCurrentnessCapturesEqual(capture, selectionCurrentness())) {
                        result = failure('cancelled');
                    } else {
                        issued = true;
                        const executed = await options.executor.executeConfirmed('projects.open', input, {
                            surface: 'ui', authority: 'present_user', serverId: input.serverId,
                            expectedAccountId: lifetime.scope.accountId, signal: abort.signal,
                        });
                        if (executed.ok) result = OpenProjectResultV1Schema.parse(executed.result);
                        else if (isActionOutcomeUnknownErrorCodeV1(executed.errorCode)) {
                            const details = executed.details;
                            const operationId = details && typeof details === 'object' && 'operationId' in details
                                && typeof details.operationId === 'string' ? details.operationId.trim() : '';
                            result = { kind: 'outcomeUnknown', ...(operationId ? { operationId } : {}) };
                        } else result = executed;
                    }
                } catch {
                    result = issued ? { kind: 'outcomeUnknown' } : failure('project_open_draft_unavailable');
                }
                if ('kind' in result && result.kind === 'opened' && !matchesOpenDestination(input, result.workspace)) {
                    result = { kind: 'outcomeUnknown' };
                }
                const isCurrent = () => !disposed && !retired && lifetime.isCurrent()
                    && areSessionDraftCurrentnessCapturesEqual(capture, selectionCurrentness());
                const unknown = 'kind' in result && result.kind === 'outcomeUnknown';
                try {
                    write({ ...(!unknown ? { uncertainInputs: [] } : {}),
                        ...(isCurrent() ? { result: 'kind' in result ? result : null }
                            : 'kind' in result ? { retiredAttempt: { input, result } } : {}) });
                    await repository.flushSessionDraftLocally({ scope });
                } catch {
                    if (issued) {
                        result = { kind: 'outcomeUnknown' };
                        // The in-memory repository must retain the same recovery fence
                        // as the earlier durable capture when settlement cannot commit.
                        try { write({ uncertainInputs: [input], result }); } catch {
                            // The earlier admitted durable capture already owns recovery.
                        }
                    }
                    else result = failure('project_open_draft_unavailable');
                }
                if (!isCurrent()) {
                    try { write({ result: null, retiredAttempt: { input, result: 'kind' in result ? result : { kind: 'outcomeUnknown' } } }); } catch {
                        // Never disclose a retired outcome through the next selection.
                    }
                    publish({ ...snapshot, pending: false, retiredAttempt: { input, result } });
                    retirement.dispose();
                    if (active === attempt) active = null;
                    return;
                }
                publish({ ...snapshot, pending: false, result });
                try {
                    if ('kind' in result && result.kind === 'opened') await options.onOpened(result, isCurrent);
                } finally {
                    retirement.dispose();
                    if (active === attempt) active = null;
                    publish({ ...snapshot, pending: false });
                }
            })();
            return attempt.promise;
        },
    };
}
