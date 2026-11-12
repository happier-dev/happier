import {
    ForgeReleaseActionResultSchemasV1, type ForgeReleaseActionInputByOperationV1, type ForgeReleaseActionResultByOperationV1,
    type ForgeReleaseGeneratedNotesV1, type ForgeReleaseMountedIntentOperationV1,
    type ForgeReleaseMountedIntentResultV1, type ForgeReleaseMutationResultV1, type ForgeReleaseV1,
} from '@happier-dev/triage-protocol/releases/v1';
import { projectTriageSourceInvocationFailureV1, projectTriageSourceReadFailureV1 } from '@happier-dev/triage-sources/runtime';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { projectPluginActionControlExecutionV1, isPluginActionConfirmationDeclined, type PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';
import { reconcileReleaseV1, sameReleaseReviewFieldsV1 } from '../../releases/mapping.js';

export type ReleaseEditorOperationV1 = 'generateReleaseNotes' | 'createReleaseDraft' | 'editReleaseDraft' | 'publishReleaseDraft' | 'readRelease' | 'listAssets';
export type ReleaseEditorFieldsV1 = Readonly<{
    tagName: string; targetCommitish: string; name: string; body: string;
    previousTagName: string; configurationFilePath: string; prerelease: boolean;
}>;
export type ReleaseEditorSnapshotV1 = Readonly<{
    fields: ReleaseEditorFieldsV1; saved: ForgeReleaseV1 | null; dirty: boolean; preview: boolean;
    makeLatest: ForgeReleaseActionInputByOperationV1['publishReleaseDraft']['makeLatest'];
    proposal: ForgeReleaseGeneratedNotesV1 | null; proposalFor: ReleaseEditorFieldsV1 | null; conflict: ForgeReleaseV1 | null;
    review: ForgeReleaseV1 | null; busy: ReleaseEditorOperationV1 | null;
    failure: TriageSourceFailureV1 | null; outcome: ForgeReleaseMutationResultV1 | null;
    /** The unsaved-change guard is asking whether to discard local work before the editor closes. */
    closing: boolean;
}>;
/** Local work worth guarding: a saved draft with edits, or a new release that already has a name or notes. */
export function hasUnsavedReleaseWorkV1(snapshot: ReleaseEditorSnapshotV1 | null): boolean {
    return snapshot !== null && snapshot.dirty && (snapshot.saved !== null || snapshot.fields.body !== '' || snapshot.fields.name !== '');
}
const fromRelease = (release?: ForgeReleaseV1): ReleaseEditorFieldsV1 => ({
    tagName: release?.tagName ?? '', targetCommitish: release?.targetCommitish ?? '', name: release?.name ?? '',
    body: release?.body ?? '', previousTagName: '', configurationFilePath: '', prerelease: release?.prerelease ?? false,
});
const savedFields = ['tagName', 'targetCommitish', 'name', 'body', 'prerelease'] as const;
function fieldsMatch(fields: ReleaseEditorFieldsV1, release: ForgeReleaseV1 | null): boolean {
    if (!release) return false;
    const baseline = fromRelease(release);
    return savedFields.every(key => fields[key] === baseline[key]);
}

/** Mount-local controlled fields. It owns no timer, persistence or Session-output subscription. */
export function createReleaseEditorV1(options: Readonly<{
    target: ForgeReleaseActionInputByOperationV1['readLatestRelease']; initial?: ForgeReleaseV1;
    invoke: (operation: ReleaseEditorOperationV1, input: ForgeReleaseActionInputByOperationV1[ReleaseEditorOperationV1]) => Promise<PluginActionExecution<unknown>>;
    onSaved?: (release: ForgeReleaseV1, effect: 'created' | 'edited' | 'published') => void;
}>) {
    if (options.initial && (!sameScmHostingRepositoryIdentity(options.target.repository, options.initial.repository)
        || (options.target.repositoryId !== undefined && options.target.repositoryId !== options.initial.repositoryId)))
        throw new RangeError('github_release_editor_repository_mismatch');
    let state: ReleaseEditorSnapshotV1 | null = {
        fields: fromRelease(options.initial), saved: options.initial ?? null, dirty: !options.initial,
        preview: false, makeLatest: 'legacy', proposal: null, proposalFor: null, conflict: null, review: null,
        busy: null, failure: null, outcome: null, closing: false,
    };
    const listeners = new Set<() => void>();
    // The last explicitly submitted effect, not a receipt/lease or a second draft store.
    let writeIntent: Readonly<{ effect: 'created' | 'edited' | 'published'; fields: ReleaseEditorFieldsV1 }> | null = null;
    const publish = (patch: Partial<ReleaseEditorSnapshotV1>) => {
        if (!state) return;
        state = { ...state, ...patch };
        for (const listener of listeners) listener();
    };
    function settle<K extends ReleaseEditorOperationV1>(op: K, execution: PluginActionExecution<unknown>): ForgeReleaseActionResultByOperationV1[K] | null {
        try {
            if (!state) return null;
            if (execution.status === 'idle' || execution.status === 'pending' || isPluginActionConfirmationDeclined(execution)) return null;
            if (execution.status === 'error' || execution.status === 'outcomeUnknown') {
                const failure = projectTriageSourceReadFailureV1(execution, 'github_release_action_unavailable', 'github_release_action_not_dispatched');
                if (execution.status === 'outcomeUnknown'
                    && (op === 'createReleaseDraft' || op === 'editReleaseDraft' || op === 'publishReleaseDraft')) publish({ failure,
                    outcome: { kind: 'outcome_unknown', failure, ...(state.saved === null ? {} : { releaseId: state.saved.releaseId, webUrl: state.saved.webUrl }) } });
                else publish({ failure });
                return null;
            }
            const result = ForgeReleaseActionResultSchemasV1[op].parse(execution.result);
            if (result.kind === 'unavailable' || result.kind === 'rejected') publish({ failure: result.failure });
            return result as ForgeReleaseActionResultByOperationV1[K];
        } catch {
            // Admission/transport wrappers preserve uncertainty, even when an outer Action envelope was lost.
            if (!state) return null;
            const failure: TriageSourceFailureV1 = { class: 'transient', code: 'github_release_action_unavailable' };
            if (op === 'createReleaseDraft' || op === 'editReleaseDraft' || op === 'publishReleaseDraft') {
                const outcome: ForgeReleaseMutationResultV1 = { kind: 'outcome_unknown', failure,
                    ...(state.saved === null ? {} : { releaseId: state.saved.releaseId, webUrl: state.saved.webUrl }) };
                publish({ outcome, failure });
            } else publish({ failure });
            return null;

        }
    }
    async function execute<K extends ReleaseEditorOperationV1>(op: K, input: ForgeReleaseActionInputByOperationV1[K]): Promise<ForgeReleaseActionResultByOperationV1[K] | null> {
        if (!state || state.busy !== null) return null;
        publish({ busy: op, failure: null });
        try { return settle(op, await options.invoke(op, input)); }
        catch (error) {
            const failure = projectTriageSourceInvocationFailureV1(error, 'github_release_action_unavailable');
            return settle(op, { status: 'outcomeUnknown', code: failure.code, message: failure.code,
                ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }) });
        }
        finally { if (state) publish({ busy: null }); }
    }
    async function invoke(operation: ForgeReleaseMountedIntentOperationV1): Promise<ForgeReleaseMountedIntentResultV1> {
        if (!state) return { status: 'unavailable' };
        if (state.busy === 'publishReleaseDraft' && ['setField', 'setPrerelease', 'setMakeLatest', 'applyGenerated'].includes(operation.kind))
            return { status: 'unavailable' };
        if (state.saved && !state.saved.draft && ['setField', 'setPrerelease', 'setMakeLatest', 'applyGenerated'].includes(operation.kind))
            return { status: 'unavailable' };
        switch (operation.kind) {
            case 'setField': {
                if (state.fields[operation.field] === operation.value) break;
                const fields = { ...state.fields, [operation.field]: operation.value };
                publish({ fields, dirty: !fieldsMatch(fields, state.saved), review: null }); break;
            }
            case 'setPrerelease': {
                if (state.fields.prerelease === operation.value) break;
                const fields = { ...state.fields, prerelease: operation.value };
                publish({ fields, dirty: !fieldsMatch(fields, state.saved), review: null }); break;
            }
            case 'setPreview': if (state.preview !== operation.value) publish({ preview: operation.value }); break;
            case 'setMakeLatest': if (state.makeLatest !== operation.value) publish({ makeLatest: operation.value, review: null }); break;
            case 'applyGenerated': {
                if (!state.proposal) return { status: 'unavailable' };
                if (operation.mode === 'use' && (state.fields.name !== '' || state.fields.body !== '')) return { status: 'rejected' };
                const fields = { ...state.fields, ...state.proposal };
                publish({ fields, dirty: !fieldsMatch(fields, state.saved), proposal: null, proposalFor: null, review: null }); break;
            }
            case 'command': switch (operation.command) {
                case 'generate': {
                    if (state.busy !== null || !state.fields.tagName.trim() || state.outcome?.kind === 'outcome_unknown') return { status: 'unavailable' };
                    await generate();
                    return state?.proposal ? { status: 'applied' } : { status: 'unavailable' };
                }
                case 'keepEditing': if (!state.closing) return { status: 'rejected' }; publish({ closing: false }); break;
                case 'useRemote': if (!state.conflict) return { status: 'unavailable' }; acceptRemote(); break;
                default: return { status: 'unavailable' }; // Page commands: the page owns location and reads.
            } break;
            default: return { status: 'unavailable' }; // The page/Collection owns selection and paging.
        }
        return { status: 'applied' };
    }
    function receive(incoming: ForgeReleaseV1, reconciliation?: Readonly<{ reconcileOutcome?: boolean }>) {
        if (!state) return;
        if (!sameScmHostingRepositoryIdentity(options.target.repository, incoming.repository)
            || (options.target.repositoryId !== undefined && options.target.repositoryId !== incoming.repositoryId)) return;
        if (state.saved && incoming.releaseId !== state.saved.releaseId) return;
        if (reconciliation?.reconcileOutcome && state.outcome?.kind === 'outcome_unknown') {
            // Only the exact known target can establish this effect; an old draft or guessed create cannot.
            if (!writeIntent || !state.outcome.releaseId || state.outcome.releaseId !== incoming.releaseId
                || (state.saved && state.saved.repositoryId !== incoming.repositoryId)
                || incoming.draft !== (writeIntent.effect !== 'published') || !fieldsMatch(writeIntent.fields, incoming)) return;
            const effect = writeIntent.effect;
            writeIntent = null;
            const saved = reconcileReleaseV1(state.saved, incoming);
            publish({ saved, outcome: null, failure: null, conflict: null, review: null, dirty: !fieldsMatch(state.fields, saved) });
            options.onSaved?.(saved, effect);
            return;
        }
        const release = reconcileReleaseV1(state.saved, incoming);
        if (release === state.saved) return;
        if (state.dirty) { publish({ conflict: release, review: null }); return; }
        const fields = fieldsMatch(state.fields, release) ? state.fields
            : { ...state.fields, ...fromRelease(release), previousTagName: state.fields.previousTagName, configurationFilePath: state.fields.configurationFilePath };
        publish({ saved: release, fields, conflict: null, review: null, dirty: false });
    }
    async function generate() {
        if (!state) return;
        const fields = state.fields;
        const result = await execute('generateReleaseNotes', { ...options.target, tagName: fields.tagName,
            ...(fields.targetCommitish === '' ? {} : { targetCommitish: fields.targetCommitish }),
            ...(fields.previousTagName === '' ? {} : { previousTagName: fields.previousTagName }),
            ...(fields.configurationFilePath === '' ? {} : { configurationFilePath: fields.configurationFilePath }) });
        if (state && result?.kind === 'value') publish({ proposal: result.value, proposalFor: fields });
    }
    function prepareSave() {
        if (!state || state.busy !== null || !state.fields.tagName.trim() || !state.fields.targetCommitish.trim()) return null;
        if (state.outcome?.kind === 'outcome_unknown') return null;
        const submitted = state.fields;
        const { tagName, targetCommitish, name, body, prerelease } = submitted;
        const fields = { tagName, targetCommitish, name, body, prerelease };
        const saved = state.saved;
        if (saved && (!saved.draft || fieldsMatch(submitted, saved) || saved.updatedAt === undefined)) return null;
        writeIntent = { effect: saved ? 'edited' : 'created', fields: submitted };
        return saved ? { operation: 'editReleaseDraft' as const, input: { ...options.target, repositoryId: saved.repositoryId, releaseId: saved.releaseId,
            observedUpdatedAt: saved.updatedAt!, changes: Object.fromEntries(savedFields.filter(key => fields[key] !== fromRelease(saved)[key]).map(key => [key, fields[key]])) } }
            : { operation: 'createReleaseDraft' as const, input: { ...options.target, ...fields } };
    }
    function settleSave(result: ForgeReleaseMutationResultV1 | null) {
        if (!state || !result) return;
        publish({ outcome: result });
        if (result.kind === 'confirmed') {
            publish({ saved: result.release, dirty: !fieldsMatch(state.fields, result.release), conflict: null, review: null });
            options.onSaved?.(result.release, writeIntent?.effect === 'created' ? 'created' : 'edited');
        } else if (result.kind === 'conflict') publish({ conflict: result.release, review: null });
    }
    async function save() {
        const preparation = prepareSave();
        if (preparation) settleSave(await execute(preparation.operation, preparation.input));
    }
    const saveControl = {
        prepare({ signal }) {
            if (signal.aborted) return null;
            const preparation = prepareSave();
            if (!preparation) return null;
            publish({ busy: preparation.operation, failure: null });
            return { input: preparation.input };
        },
        onSettled(execution) {
            const operation = state?.busy;
            if (operation !== 'createReleaseDraft' && operation !== 'editReleaseDraft') return;
            settleSave(settle(operation, projectPluginActionControlExecutionV1(execution, (_key, fallback) => fallback ?? _key)));
            publish({ busy: null });
        },
    } satisfies PluginUiActionControlController;
    async function reviewPublish() {
        if (!state?.saved || state.dirty || !state.saved.draft || state.outcome?.kind === 'outcome_unknown') return;
        const saved = state.saved;
        const exact = await execute('readRelease', { ...options.target, repositoryId: saved.repositoryId, releaseId: saved.releaseId });
        if (!state || exact?.kind !== 'value') return;
        if (!sameReleaseReviewFieldsV1(saved, exact.value)) { publish({ conflict: exact.value, review: null }); return; }
        const rows: ForgeReleaseV1['assets']['rows'][number][] = [];
        let cursor: string | undefined;
        do {
            const assets = await execute('listAssets', { ...options.target, repositoryId: saved.repositoryId, releaseId: saved.releaseId, ...(cursor === undefined ? {} : { cursor }) });
            if (!state || assets?.kind !== 'value' || assets.value.incomplete !== null || assets.value.omittedRowCount !== 0 || assets.value.projectionTruncated) return;
            rows.push(...assets.value.rows); cursor = assets.value.continuation ?? undefined;
        } while (cursor !== undefined);
        if (state.dirty || state.saved !== saved) return;
        publish({ review: { ...exact.value, assets: { rows, omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } } });
    }
    function preparePublish() {
        if (!state?.review || state.busy !== null || state.dirty || state.outcome?.kind === 'outcome_unknown') return null;
        writeIntent = { effect: 'published', fields: fromRelease(state.review) };
        return { ...options.target, repositoryId: state.review.repositoryId, releaseId: state.review.releaseId,
            reviewed: state.review, makeLatest: state.makeLatest };
    }
    function settlePublish(result: ForgeReleaseMutationResultV1 | null) {
        if (!state || !result) return;
        publish({ outcome: result, review: null });
        if (result.kind === 'confirmed') { publish({ saved: result.release, dirty: !fieldsMatch(state.fields, result.release) }); options.onSaved?.(result.release, 'published'); }
        if (result.kind === 'conflict') publish({ conflict: result.release });
    }
    async function publishDraft() {
        const input = preparePublish();
        if (input) settlePublish(await execute('publishReleaseDraft', input));
    }
    const publishControl = {
        async prepare({ signal }) {
            if (signal.aborted) return null;
            await reviewPublish();
            if (signal.aborted) return null;
            const input = preparePublish();
            if (!input) return null;
            publish({ busy: 'publishReleaseDraft', failure: null });
            return { input };
        },
        onSettled(execution) {
            if (state?.busy !== 'publishReleaseDraft') return;
            settlePublish(settle('publishReleaseDraft', projectPluginActionControlExecutionV1(execution, (_key, fallback) => fallback ?? _key)));
            publish({ busy: null });
        },
    } satisfies PluginUiActionControlController;
    /** Explicitly adopt a freshly read exact target after reviewing the conflict and unsaved-change guard. */
    function acceptRemote() {
        if (!state?.conflict) return;
        const saved = state.conflict;
        publish({ saved, fields: fromRelease(saved), dirty: false, conflict: null, outcome: null, review: null, closing: false });
    }
    return {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        invoke, receive, generate, save, reviewPublish, publishDraft, saveControl, publishControl,
        /** Explicit discard/refresh is a host current-context command after its unsaved-change guard. */
        discard() { if (state) publish({ fields: fromRelease(state.saved ?? undefined), dirty: state.saved === null, proposal: null, proposalFor: null, conflict: null, review: null, closing: false }); },
        /** True when nothing needs guarding; otherwise the guard opens and the caller keeps the editor. */
        requestClose(): boolean {
            if (!state) return true;
            if (!hasUnsavedReleaseWorkV1(state)) return true;
            if (!state.closing) publish({ closing: true });
            return false;
        },
        acceptRemote,
        dispose() { state = null; writeIntent = null; listeners.clear(); },
    };
}
export type ReleaseEditorV1 = ReturnType<typeof createReleaseEditorV1>;
