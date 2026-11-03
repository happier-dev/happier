import type {
    ComposerStagedMediaContentV1,
    ComposerSnapshotV1,
    ComposerTransactionV1,
    ComposerTransactionResultV1,
} from '@happier-dev/protocol';
import { createActionExecutor, PluginContributesV2Schema, buildComposerReferenceMentionPayloadV1, readHappierStructuredInputV1FromMeta, type PluginProjectionV2, type ActionExecutorDeps } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { act } from 'react-test-renderer';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import { storage } from '@/sync/domains/state/storage';
import {
    getSessionDraftSnapshot,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { releaseComposerContent, claimComposerContent } from '@/sync/domains/transfers/runtime/transferRuntime';
import type { PluginUiComposerAttachmentProjection } from '@/sync/domains/plugins/ui/projection';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook, requireComposerDraftDocument } from '@/dev/testkit';
import { planComposerReferenceInsertion, readRecentComposerReferenceInsertions } from '@/components/sessions/composer/composerReferenceInsertion';
import { buildComposerRecentReferenceSuggestions } from '@/components/sessions/composer/composerRecentReferences';
import { ComposerEntityDropTarget } from '@/components/sessions/composer/ComposerEntityDropTarget';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { formatWidgetInstanceRefKeyV1 } from '@happier-dev/protocol/widgets';
import { buildMentionRefForKindV1, MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

const persistentValues = vi.hoisted(() => new Map<string, string>());
const activeScopeState = vi.hoisted(() => ({
    value: null as Readonly<{ serverId: string; accountId: string }> | null,
}));
const releaseComposerContentSpy = vi.hoisted(() => (
    vi.fn<typeof releaseComposerContent>(async () => ({ success: true } as const))
));
const claimComposerContentSpy = vi.hoisted(() => (
    vi.fn<typeof claimComposerContent>(async () => ({ status: 'claimed', newlyAcquired: true } as const))
));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return persistentValues.get(key);
        }

        set(key: string, value: string) {
            persistentValues.set(key, value);
        }

        delete(key: string) {
            persistentValues.delete(key);
        }
    }

    return { MMKV };
});

// Only the active-scope read is stubbed; the module's real lifetime capture and
// retirement logic stays live for every other consumer in this graph.
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>();
    return { ...actual, getActiveServerAccountScope: () => activeScopeState.value ?? actual.getActiveServerAccountScope() };
});

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    releaseComposerContent: releaseComposerContentSpy,
    claimComposerContent: claimComposerContentSpy,
}));

import {
    applyComposerPresentationTransaction,
    applyMountedComposerPresentationTransaction,
    removeMountedComposerAttachmentReferences,
    readMountedComposerPresentationSnapshot,
    requestRegisteredComposerAttachmentPicker,
    createComposerPresentationTransactionApplier,
    flushPendingRegisteredSessionComposerActionChip,
    notifyComposerPresentationTargetChanged,
    readSessionComposerActionChipAvailable,
    requestRegisteredSessionComposerActionChip,
    readComposerPresentationSnapshot,
    readComposerPresentationTarget,
    readSessionComposerPresentationTargetAtAddress,
    registerComposerPresentationTarget,
    registerSessionComposerPresentationTarget,
    requestRegisteredSessionComposerFocus,
    requestRegisteredComposerPromptPicker,
    subscribeComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
    useStableComposerPresentationTarget,
} from './sessionComposerPresentationTargets';
import { applyCurrentSessionPresentationCommand } from './applyCurrentSessionPresentationCommand';
import { executePromptPickerOpenAction } from '@/components/sessions/agentInput/commandMenu/promptPickerActionRuntime';
import { executeComposerIngressAction } from '@/sync/ops/actions/composerIngressActionRuntime';
import { askAboutRanges } from '@/components/ui/code/selection/askAboutRanges';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ReviewCommentsV1Schema } from '@happier-dev/protocol/messages/structured/reviewCommentsV1';
import { buildFileReferenceOperation, resolveComposerEntityDrop, type ComposerEntityDropContext } from '@/components/sessions/composer/composerEntityDrop';
import { buildComposerSnapshotStructuredInputMetaOverrides, placePositionlessComposerReferences } from '@/components/sessions/composer/composerScopeAdapters';
import { createPluginUiClientExecutableRegistrationIndex } from '@/components/plugins/reactNative/clientExecutableContributions';
import { triageEntryDragSourceRuntime, TriageEntryDragReferenceV1Schema } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-entity-drag-drop-native';
import { TriageConfiguredSourceInstanceV1Schema, TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
// Cross-owner regression fixtures keep both real implementations live; only
// configured Source transport answers are supplied at the external boundary.
import { resolveTriageEntryForDispatch, type TriageEntryDispatchDepsV1 } from '../../../../../../packages/plugins/triage/src/composer/resolveForDispatch';
import { createTestkitCorpusCollections } from '../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support';
import { toCorpusStoredValue } from '../../../../../../packages/plugins/triage/src/corpus/collections/rowCodec';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../../../../../packages/plugins/triage/src/corpus/collections/ids';
import { testkitSnapshot, testkitViewer } from '../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support';

function createAttachmentProjectionEntry(input: Readonly<{
    pluginId: string;
    localId: string;
    typeLabel: string;
    occurrenceId?: string;
    cardinality?: 'one' | 'many';
    valueValidator?: (value: unknown) => boolean;
}>): PluginUiComposerAttachmentProjection {
    return {
        id: `${input.pluginId}/${input.localId}`,
        pluginId: input.pluginId,
        identity: { pluginId: input.pluginId, localId: input.localId },
        occurrenceId: input.occurrenceId ?? `${input.pluginId}-generation`,
        definition: {
            id: input.localId,
            title: input.typeLabel,
            icon: 'file',
            cardinality: input.cardinality ?? 'many',
            valueSchema: { type: 'object' },
        },
        valueValidator: input.valueValidator ?? (() => true),
    };
}

function createAttachmentTransactionApplier(
    ...entries: readonly PluginUiComposerAttachmentProjection[]
) {
    return createComposerPresentationTransactionApplier({
        composerAttachmentsById: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    });
}

function admittedContributor(input: Readonly<{
    pluginId: string;
    occurrenceId?: string;
}>) {
    return {
        identity: { pluginId: input.pluginId, localId: 'control' },
        occurrenceId: input.occurrenceId ?? `${input.pluginId}-generation`,
    };
}

function createStagedMediaContent(): ComposerStagedMediaContentV1 {
    return {
        kind: 'stagedMedia',
        handle: {
            v: 1,
            id: 'stage-42',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'acme.issues', localId: 'issue' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'issue-42.png',
            sizeBytes: 12,
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
    };
}

function createSnapshot(overrides: Partial<ComposerSnapshotV1> = {}): ComposerSnapshotV1 {
    return {
        revision: 1,
        ref: { kind: 'session', sessionId: 'session-1' },
        text: '',
        references: [],
        attachments: [],
        layout: 'wrap',
        capabilities: {
            text: true,
            references: true,
            attachments: true,
            submit: true,
        },
        state: {
            focused: false,
            editable: true,
            submittable: true,
            submitting: false,
            running: false,
        },
        ...overrides,
    };
}

function createDocumentTarget(
    initial: ComposerSnapshotV1,
    createAttachmentInstanceId: () => string = () => 'host-created-issue-42',
): ComposerPresentationTarget & Required<Pick<
    ComposerPresentationTarget,
    'readSnapshot' | 'commitDocument'
>> & Readonly<{
    readCurrent: () => ComposerSnapshotV1;
}> {
    let current = initial;
    return {
        readRevision: () => current.revision,
        replace: (text, expectedRevision) => {
            if (current.revision !== expectedRevision) return current.revision;
            current = { ...current, text, revision: current.revision + 1 };
            return current.revision;
        },
        readSnapshot: () => current,
        commitDocument: vi.fn((input: Readonly<{
            expectedRevision: number;
            mutation: ComposerPresentationDocumentMutation;
        }>): ComposerTransactionResultV1 => {
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', currentRevision: current.revision };
            }
            current = {
                ...current,
                ...input.mutation,
                references: [...input.mutation.references],
                attachments: [...input.mutation.attachments],
                revision: current.revision + 1,
            };
            return { status: 'applied', revision: current.revision };
        }),
        createAttachmentInstanceId,
        readCurrent: () => current,
    };
}

describe('composer presentation targets', () => {
    const cleanups: Array<() => void | Promise<void>> = [];

    it('records only successful workflow and qualified widget Action publications in this Home Recent', async () => {
        const scope = { serverId: 'publication-home', accountId: 'publication-account' };
        activeScopeState.value = scope;
        const ref = { kind: 'newSession', instanceId: 'publication-input' } as const;
        const workspace = { serverId: scope.serverId, machineId: 'publication-machine', rootPath: '/repo' };
        let editable = true;
        const document = createDocumentTarget(createSnapshot({ ref, text: 'Before after', selection: { start: 7, end: 7 } }));
        cleanups.push(registerComposerPresentationTarget(ref, { ...document, readScope: () => scope,
            readReferenceWorkspace: () => workspace,
            readSnapshot: () => ({ ...document.readCurrent(), state: { ...document.readCurrent().state, editable } }) }));
        const executor = createActionExecutor({ composerIngress: executeComposerIngressAction,
            isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
        const execute = (input: unknown) => executor.execute('composer.transaction.apply', input,
            { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        const recent = () => buildComposerRecentReferenceSuggestions({ inserted: readRecentComposerReferenceInsertions(scope),
            files: [], sessions: [], kinds: ['composerReference'], group: 'Recent' });
        for (const [item, label] of [
            [{ kind: 'workflow', scope, workflowId: 'review-flow' }, 'Review workflow'],
            [{ kind: 'work-board-widget', scope, boardId: 'board-1', instanceId: 'widget-1' }, 'Build status'],
        ] as const) {
            const admission = resolveComposerEntityDrop(item, { scope, ref, snapshot: document.readCurrent(), sessions: [],
                workspace: null, itemLabel: label, preview: { verb: 'Mention', target: 'Composer' }, reason: code => code });
            expect(admission.status).toBe('allowed');
            if (admission.status !== 'allowed') throw new Error('Expected a reusable reference');
            expect(recent().some(row => row.label === label)).toBe(false);
            editable = false;
            expect(await execute(admission.effect.input)).toMatchObject({ ok: true, result: { status: 'notEditable' } });
            expect(recent().some(row => row.label === label)).toBe(false);
            editable = true;
            expect(await execute(admission.effect.input)).toMatchObject({ ok: true, result: { status: 'applied' } });
            expect(recent()[0]).toMatchObject({ label });
            expect(await execute(admission.effect.input)).toMatchObject({ ok: true, result: { status: 'conflict' } });
        }
        expect(recent().map(row => row.label)).toEqual(['Build status', 'Review workflow']);
        const widget = document.readCurrent().references.find(reference => reference.kind === MENTION_KIND_V1.widget);
        expect(recent()[0]?.structuredInput).toMatchObject({ ref: widget?.ref });
        const admission = resolveComposerEntityDrop({ kind: 'repository-file', scope, machineId: workspace.machineId, path: '/repo/src/a.ts' },
            { scope, ref, snapshot: document.readCurrent(), sessions: [], workspace, preview: { verb: 'Mention', target: 'Composer' }, reason: code => code });
        if (admission.status !== 'allowed') throw new Error('Expected a file reference');
        expect(await execute(admission.effect.input)).toMatchObject({ ok: true, result: { status: 'applied' } });
        expect(readRecentComposerReferenceInsertions(scope, workspace)[0]?.reference).toMatchObject({ ref: 'file:src/a.ts' });
        expect(readRecentComposerReferenceInsertions(scope, { ...workspace, rootPath: '/another-repo' })
            .some(item => item.reference.ref === 'file:src/a.ts')).toBe(false);
        expect(readRecentComposerReferenceInsertions({ ...scope, accountId: 'another-account' })).toEqual([]);
    });

    it('refuses Action text edits inside bound tokens without publishing a partial reference', async () => {
        const scope = { serverId: 'atomic-action-home', accountId: 'atomic-action-account' };
        activeScopeState.value = scope;
        const ref = { kind: 'newSession', instanceId: 'atomic-action-input' } as const;
        const token = formatInlineReferenceTokenV1({ label: 'Auth', ref: 'session:auth' });
        const initial = createSnapshot({ ref, text: `See ${token} now`, references: [{
            kind: MENTION_KIND_V1.session, ref: 'session:auth', label: 'Auth', token, start: 4, end: 4 + token.length,
        }] });
        const target = createDocumentTarget(initial);
        cleanups.push(registerComposerPresentationTarget(ref, { ...target, readScope: () => scope }));
        const executor = createActionExecutor({ composerIngress: executeComposerIngressAction,
            isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
        const execute = (operations: ComposerTransactionV1['operations']) => executor.execute('composer.transaction.apply', {
            scope, ref, transaction: { expectedRevision: target.readCurrent().revision, operations },
        }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        for (const operation of [
            { kind: 'text.insert', position: { offset: 6 }, text: 'x' },
            { kind: 'text.replaceRange', range: { start: 6, end: 7 }, text: 'x' },
            { kind: 'text.replaceRange', range: { start: 0, end: 7 }, text: '' },
            { kind: 'text.set', text: `${initial.text.slice(0, 6)}x${initial.text.slice(6)}` },
        ] satisfies ComposerTransactionV1['operations']) {
            expect(await execute([operation])).toMatchObject({ ok: true, result: { status: 'invalidOperation', operationIndex: 0 } });
            expect(target.readCurrent()).toBe(initial);
        }
        expect(await execute([{ kind: 'text.insert', position: { offset: 4 }, text: 'before ' },
            { kind: 'text.insert', position: { offset: 4 + token.length }, text: ' after' }]))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
        expect(target.readCurrent().references).toEqual([{ ...initial.references[0], start: 11, end: 11 + token.length }]);
        expect(await execute([{ kind: 'text.replaceRange', range: { start: 11, end: 11 + token.length }, text: 'plain' }]))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
        expect(target.readCurrent()).toMatchObject({ text: 'See before plain after now', references: [] });
    });

    it('removes upload-draft chips through the exact mounted document in the same removal action', async () => {
        const { useAttachmentDraftManager } = await import('@/components/sessions/attachments/useAttachmentDraftManager');
        const scope = { serverId: 'upload-home', accountId: 'upload-account' };
        activeScopeState.value = scope;
        const ref = { kind: 'session', sessionId: 'upload-session' } as const;
        const token = '[Photo](happier-ref:attachment:upload-1)';
        const target = createDocumentTarget(createSnapshot({ ref, text: `See ${token}`,
            references: [{ kind: 'happier.attachment', ref: 'attachment:upload-1', token, start: 4, end: 4 + token.length }] }));
        cleanups.push(registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId },
            { ...target, readScope: () => scope }));
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            initialDrafts: [{ id: 'upload-1', source: { kind: 'memory', name: 'photo.png', bytes: new Uint8Array([1]) }, status: 'pending' }],
            onRemoveDraft: (attachmentId) => removeMountedComposerAttachmentReferences({ ref, scope, attachmentId }),
        }));
        await act(async () => {
            hook.getCurrent().removeDraft('upload-1');
            expect(target.readCurrent()).toMatchObject({ text: 'See ', references: [], revision: 2 });
            expect(hook.getCurrent().getDraftsSnapshot()).toEqual([]);
        });
    });

    it('admits anchored Ask through the real composer Action and plugin transaction without attachment authority', async () => {
        const scope = { serverId: 'review-ask-home', accountId: 'review-ask-account' };
        activeScopeState.value = scope;
        const ref = { kind: 'session', sessionId: 'review-ask-session' } as const;
        const previousSessions = storage.getState().sessions;
        const previousDrafts = storage.getState().reviewCommentsDraftsByWorkspaceCacheKey;
        const previousMachines = storage.getState().machineListByServerId;
        storage.setState({ sessions: { ...previousSessions, [ref.sessionId]: createSessionFixture({ id: ref.sessionId, serverId: scope.serverId }) },
            reviewCommentsDraftsByWorkspaceCacheKey: {}, machineListByServerId: { ...previousMachines, [scope.serverId]: [createMachineFixture()] } });
        cleanups.push(() => { storage.setState({ sessions: previousSessions, reviewCommentsDraftsByWorkspaceCacheKey: previousDrafts,
            machineListByServerId: previousMachines }); });
        const workspaceScope = { serverId: scope.serverId, machineId: 'machine-1', rootPath: '/Users/tester/project' };
        const workspaceKey = buildWorkspaceCacheKey(workspaceScope);
        const document = createDocumentTarget(createSnapshot({ ref, text: 'My question' }));
        cleanups.push(registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId }, {
            ...document, readScope: () => scope,
        }));
        const uiAsk = await askAboutRanges({ workspaceScope, sessionTarget: { sessionId: ref.sessionId },
            filePath: 'src/a.ts', savedText: 'first\nsecond\nlast', text: 'inserted\nfirst\nchanged second\nlast',
            ranges: [{ startLine: 2, endLine: 3, text: 'irst\nchanged sec', body: 'Explain this' }] });
        const comment = uiAsk.drafts[0];
        if (!comment) throw new Error('Expected UI Ask to produce an anchored comment');
        expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[workspaceKey]).toEqual([comment]);
        storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: {} });
        const settings = normalizeActionsSettingsV1({ v: 1 });
        for (const surface of ['ui', 'agent', 'mcp', 'cli', 'plugin'] as const) {
            expect(isApprovalRequiredByActionsSettings('composer.transaction.apply', settings, { surface })).toBe(false);
            expect(isApprovalRequiredByActionsSettings('composer.transaction.apply', normalizeActionsSettingsV1({ v: 1,
                actions: { 'composer.transaction.apply': { approvalRequiredSurfaces: [surface] } },
            }), { surface })).toBe(true);
        }
        const isActionApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, context, input) => (
            isApprovalRequiredByActionsSettings(id, context.actionsSettings ?? settings, context, undefined, undefined, input)
        );
        const executor = createActionExecutor({ composerIngress: executeComposerIngressAction,
            isActionApprovalRequired,
        } as unknown as ActionExecutorDeps);
        const result = await executor.execute('composer.transaction.apply', { scope, ref, transaction: {
            expectedRevision: 1, operations: [{ kind: 'reviewComment.add', comment }],
        } }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result, JSON.stringify(result)).toMatchObject({ result: { status: 'applied' } });
        expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[workspaceKey]).toEqual([comment]);
        expect(document.readCurrent()).toMatchObject({ text: 'My question', attachments: [] });
        const pluginComment = { ...comment, id: 'plugin-question', body: 'Follow up' };
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({ pluginId: 'acme.issues', localId: 'issue', typeLabel: 'Issue' }));
        expect(applier.apply({ ref, admittedContributor: admittedContributor({ pluginId: 'acme.issues' }), transaction: {
            expectedRevision: document.readRevision(), operations: [{ kind: 'reviewComment.add', comment: pluginComment }],
        } })).toMatchObject({ status: 'applied' });
        expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[workspaceKey]).toEqual([comment, pluginComment]);
        const forged = applier.apply({ ref, admittedContributor: admittedContributor({ pluginId: 'acme.issues' }), transaction: {
            expectedRevision: document.readRevision(), operations: [{ kind: 'reviewComment.add', comment: { ...comment, id: 'must-not-land' } },
                { kind: 'attachment.add', attachmentLocalId: 'review-comments', value: { key: 'forged', value: {}, presentation: { label: 'Host' } } }],
        } });
        expect(forged).toMatchObject({ status: 'invalidOperation', reason: 'attachment_authority_mismatch' });
        expect(applyMountedComposerPresentationTransaction({ scope, ref, transaction: {
            expectedRevision: 1, operations: [{ kind: 'reviewComment.add', comment: { ...comment, id: 'stale-question' } }],
        } })).toMatchObject({ status: 'conflict' });
        activeScopeState.value = { ...scope, accountId: 'other-account' };
        expect(applyMountedComposerPresentationTransaction({ scope, ref, transaction: {
            expectedRevision: document.readRevision(), operations: [{ kind: 'reviewComment.add', comment: { ...comment, id: 'foreign-question' } }],
        } })).toEqual({ status: 'composerUnavailable' });
        activeScopeState.value = scope;
        expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[workspaceKey]).toEqual([comment, pluginComment]);
        expect(document.readCurrent().attachments).toEqual([]);
        expect(await executor.execute('composer.transaction.apply', { scope, ref, transaction: {
            expectedRevision: document.readRevision(), operations: [{ kind: 'reviewComment.add', comment: { ...comment, id: 'needs-approval' } }],
        } }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId,
            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'composer.transaction.apply': { approvalRequiredSurfaces: ['agent'] } } }),
        })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(ReviewCommentsV1Schema.parse({ sessionId: ref.sessionId,
            comments: storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[workspaceKey],
        }).comments).toEqual([comment, pluginComment]);
    });

    it('admits the real Triage drag value through its current occurrence, stores a host-minted attachment and resolves current context at dispatch', async () => {
        const scope = { serverId: 'triage-home', accountId: 'triage-account' };
        activeScopeState.value = scope;
        const pluginId = 'happier.triage';
        const occurrenceId = 'triage-live';
        const index = createPluginUiClientExecutableRegistrationIndex();
        const target = { artifactId: 'triage-runtime', exportName: 'activate', platform: 'web' as const };
        const contributes = PluginContributesV2Schema.parse({ dragSources: [{ id: 'entry-reference', title: 'Entry',
            composerAttachment: 'entry', referenceSchema: TriageEntryDragReferenceV1Schema.jsonSchema,
            client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] }] });
        const controller = new AbortController();
        const registration = index.createScope({ pluginId, contributes, target, occurrenceId, pluginVersion: '0.0.0',
            executionOrigin: null,
            lifecycle: { signal: controller.signal, isCurrent: () => !controller.signal.aborted } });
        registration.api.dragSources.register('entry-reference', triageEntryDragSourceRuntime);
        registration.commit();
        cleanups.push(() => { void registration.unwind(); });
        const entry = createAttachmentProjectionEntry({ pluginId, localId: 'entry', typeLabel: 'Entry', occurrenceId });
        const composition = { composerAttachmentsById: { [entry.id]: entry } };
        const document = createDocumentTarget(createSnapshot({ ref: { kind: 'newSession', instanceId: 'triage-input' },
            text: 'Investigate this', selection: { start: 12, end: 12 }, capabilities: { text: true, references: true, attachments: true, submit: true } }));
        cleanups.push(registerComposerPresentationTarget(document.readCurrent().ref, { ...document, readScope: () => scope, readAttachmentComposition: () => composition }));
        const source = { id: `${pluginId}/entry-reference`, pluginId, pluginVersion: '0.0.0', occurrenceId, definition: contributes.dragSources[0]! };
        const projection: PluginProjectionV2 = { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {},
            resourcesById: {}, settingsById: {}, diagnostics: [], familiesById: { dragSources: { family: 'dragSources', entriesById: { [source.id]: source } } } };
        const reference = { entryRef: { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '42' },
            sourceInstance: { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
            lastKnownLocator: { v: 1 as const, displayPath: 'example/repository #42' }, title: 'Attached title', subtitle: 'example/repository' };
        const item = { kind: 'plugin', scope, contribution: { pluginId, localId: 'entry-reference' }, reference } as const;
        const context: ComposerEntityDropContext = { scope, ref: document.readCurrent().ref, snapshot: document.readCurrent(), sessions: [], workspace: null,
            referenceHost: { projection, pluginUiProjection: normalizePluginUiProjection(projection, 'web'), machineId: 'machine-a', serverId: scope.serverId, isCurrent: () => true },
            attachmentComposition: composition, dragSourceReader: index, platform: 'web', preview: { verb: 'Attach', target: 'Composer' }, reason: code => code };
        const admission = resolveComposerEntityDrop(item, context);
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') return;
        expect(admission.effect.input).toMatchObject({ attachmentContributor: entry.identity, transaction: { expectedRevision: 1,
            operations: [{ kind: 'attachment.add', attachmentLocalId: 'entry', mentionAt: { start: 12, end: 12 } }] } });
        expect(await executeComposerIngressAction({ actionId: 'composer.transaction.apply', input: admission.effect.input,
            context: { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId } })).toMatchObject({ status: 'applied' });
        expect(document.readCurrent()).toMatchObject({ text: 'Investigate [Attached title](happier-ref:attachment:host-created-issue-42) this',
            references: [{ kind: 'attachment', ref: 'attachment:host-created-issue-42', start: 12,
                token: '[Attached title](happier-ref:attachment:host-created-issue-42)' }],
            attachments: [{ instanceId: 'host-created-issue-42', attachment: entry.identity, value: { v: 1, entryRef: reference.entryRef, sourceInstance: reference.sourceInstance } }] });
        const corpus = createTestkitCorpusCollections();
        corpus.control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43), sourceQualifiedId: 'happier.example.source/example-forge', lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            configured: TriageConfiguredSourceInstanceV1Schema.parse({ v: 1, instance: reference.sourceInstance, localInstanceKey: 'example/repository',
                binding: { purpose: 'triage-source', account: { service: { pluginId: 'happier.example.source', localId: 'accounts' }, accountId: 'connected-account' } },
                configuration: { v: 1, token: 'fixture-routing-token' }, locator: { v: 1, displayLabel: 'example/repository' } }) }));
        const getHandle = Object.freeze({ transport: 'source-get' });
        // Branded targeted-operation handles are created outside this process;
        // this fixture supplies that boundary while keeping resolution real.
        const admitted = [{ contributor: { pluginId: 'happier.example.source', contributionId: 'example-forge', immutableGenerationId: 'source-current' },
            descriptor: TriageSourceDescriptorV1Schema.parse({ v: 1, purpose: 'triage-source', displayName: 'Example forge', kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] }),
            operations: { listInstances: {}, scan: {}, get: getHandle } }] as unknown as Awaited<ReturnType<TriageEntryDispatchDepsV1['readAdmittedSources']>>;
        let title = 'Changed before send';
        const dispatchDeps: TriageEntryDispatchDepsV1 = { sourceInstances: corpus.collections.sourceInstances, sessionLinks: corpus.collections.sessionLinks,
            readAdmittedSources: async () => admitted,
            executeGet: async (operation, input) => {
                expect(operation).toBe(getHandle);
                expect(input.instance.instance).toEqual(reference.sourceInstance);
                return { kind: 'present', localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '42' },
                    locator: reference.lastKnownLocator, snapshot: testkitSnapshot({ title }), viewer: testkitViewer() };
            } };
        expect((await resolveTriageEntryForDispatch({ attachments: document.readCurrent().attachments }, dispatchDeps)).attachments[0])
            .toMatchObject({ status: 'ready', context: expect.stringContaining(title) });
        title = 'Changed before retry';
        expect((await resolveTriageEntryForDispatch({ attachments: document.readCurrent().attachments }, dispatchDeps)).attachments[0])
            .toMatchObject({ status: 'ready', context: expect.stringContaining(title) });
        expect(resolveComposerEntityDrop(item, { ...context, attachmentComposition: { composerAttachmentsById: { [entry.id]: { ...entry, occurrenceId: 'replacement' } } } }).status).toBe('refused');
        expect(resolveComposerEntityDrop({ ...item, reference: { ...reference, actionId: 'session.send' } }, context).status).toBe('refused');
        controller.abort();
        expect(resolveComposerEntityDrop(item, context).status).toBe('refused');
        activeScopeState.value = { ...scope, accountId: 'replacement-account' };
        expect(await executeComposerIngressAction({ actionId: 'composer.transaction.apply', input: admission.effect.input,
            context: { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId } })).toEqual({ status: 'composerUnavailable' });
        expect(document.readCurrent().attachments).toHaveLength(1);
    });

    it('admits attachment selection only from the exact mounted current composition without changing text or selection', async () => {
        const scope = { serverId: 'attachment-home', accountId: 'attachment-account' };
        activeScopeState.value = scope;
        const entry = createAttachmentProjectionEntry({ pluginId: 'acme.issues', localId: 'issue', typeLabel: 'Issue', valueValidator: value => !!value && typeof value === 'object' && 'issueId' in value });
        const document = createDocumentTarget(createSnapshot({ ref: { kind: 'newSession', instanceId: 'attachment-input' }, text: 'Keep this text', selection: { start: 2, end: 5 } }));
        let composition: Readonly<{ composerAttachmentsById: Readonly<Record<string, PluginUiComposerAttachmentProjection>> }> | null = { composerAttachmentsById: { [entry.id]: entry } };
        const hook = await renderHook(() => useStableComposerPresentationTarget(document.readCurrent().ref, {
            ...document, readScope: () => scope, readAttachmentComposition: () => composition,
        }));
        cleanups.push(() => hook.unmount());
        cleanups.push(registerComposerPresentationTarget(document.readCurrent().ref, hook.getCurrent()));
        const input = { scope, ref: document.readCurrent().ref, attachmentContributor: entry.identity, transaction: { expectedRevision: 1, operations: [{
            kind: 'attachment.add', attachmentLocalId: 'issue', value: { key: 'issue-42', value: { issueId: '42' }, presentation: { label: 'Issue 42' } },
        }] } };
        const execute = (value: unknown) => executeComposerIngressAction({ actionId: 'composer.transaction.apply', input: value,
            context: { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId } });
        expect(await execute(input)).toEqual({ status: 'applied', revision: 2, attachmentInstanceIds: ['host-created-issue-42'] });
        expect(document.readCurrent()).toMatchObject({ text: 'Keep this text', selection: { start: 2, end: 5 }, attachments: [{
            instanceId: 'host-created-issue-42', attachment: entry.identity, value: { issueId: '42' },
        }] });
        composition = null;
        expect(await execute({ ...input, transaction: { ...input.transaction, expectedRevision: 2 } })).toMatchObject({ status: 'invalidOperation' });
        expect(document.readCurrent().revision).toBe(2);
    });

    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()?.();
        releaseComposerContentSpy
            .mockReset()
            .mockImplementation(async () => ({ success: true } as const));
        claimComposerContentSpy
            .mockReset()
            .mockImplementation(async () => ({ status: 'claimed', newlyAcquired: true } as const));
    });

    it('applies Actions only at the current presented mounted document and opens its incumbent attachment picker', async () => {
        const scope = { serverId: 'home-actions', accountId: 'account-actions' };
        activeScopeState.value = scope;
        const document = createDocumentTarget(createSnapshot({ ref: { kind: 'newSession', instanceId: 'action-input' }, text: 'draft' }));
        const ref = document.readCurrent().ref;
        let presented = true;
        let editable = true;
        let pickerOpened = false;
        const target: ComposerPresentationTarget = { ...document,
            readScope: () => scope,
            isPresented: () => presented,
            readSnapshot: () => ({ ...document.readCurrent(), state: { ...document.readCurrent().state, editable } }),
            openAttachmentPicker: () => { pickerOpened = true; return true; },
        };
        const request = { scope, ref, transaction: { expectedRevision: 1, operations: [{ kind: 'text.insert', position: { offset: 5 }, text: ' context' }] } };
        expect(applyMountedComposerPresentationTransaction(request)).toEqual({ status: 'composerUnavailable' });
        const release = registerComposerPresentationTarget(ref, target);
        cleanups.push(release);
        expect(applyMountedComposerPresentationTransaction({ ...request, scope: { ...scope, accountId: 'other' } })).toEqual({ status: 'composerUnavailable' });
        presented = false;
        expect(applyMountedComposerPresentationTransaction(request)).toEqual({ status: 'composerUnavailable' });
        expect(requestRegisteredComposerAttachmentPicker({ scope, ref })).toEqual({ status: 'unavailable' });
        presented = true;
        editable = false;
        expect(applyMountedComposerPresentationTransaction(request)).toEqual({ status: 'notEditable' });
        expect(requestRegisteredComposerAttachmentPicker({ scope, ref })).toEqual({ status: 'notEditable' });
        expect(pickerOpened).toBe(false);
        editable = true;
        expect(requestRegisteredComposerAttachmentPicker({ scope, ref })).toEqual({ status: 'opened' });
        expect(pickerOpened).toBe(true);
        expect(document.readCurrent().text).toBe('draft');
        // The mounted UI is the host boundary; Protocol admission and the incumbent document executor remain real.
        const executor = createActionExecutor({ composerIngress: executeComposerIngressAction,
            isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
        expect(await executor.execute('composer.transaction.apply', request, {
            surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId,
        }))
            .toEqual({ ok: true, result: { status: 'applied', revision: 2 } });
        expect(document.readCurrent().text).toBe('draft context');
        release();
        expect(applyMountedComposerPresentationTransaction({ ...request, transaction: { ...request.transaction, expectedRevision: 2 } })).toEqual({ status: 'composerUnavailable' });
    });

    it('keeps same-id Session Action transactions on the exact Home mount', () => {
        const scope = { serverId: 'action-home-a', accountId: 'account-a' };
        activeScopeState.value = scope;
        const ref = { kind: 'session', sessionId: 'action-same-id' } as const;
        const first = createDocumentTarget(createSnapshot({ ref, text: 'Home A' }));
        const second = createDocumentTarget(createSnapshot({ ref, text: 'Home B' }));
        let presented = true;
        cleanups.push(registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId }, {
            ...first, isPresented: () => presented,
        }));
        cleanups.push(registerSessionComposerPresentationTarget({ serverId: 'action-home-b', sessionId: ref.sessionId }, second));
        expect(readMountedComposerPresentationSnapshot({ scope, ref })?.text).toBe('Home A');
        presented = false;
        expect(readMountedComposerPresentationSnapshot({ scope, ref })).toBeNull();
        presented = true;
        expect(applyMountedComposerPresentationTransaction({ scope, ref, transaction: {
            expectedRevision: 1, operations: [{ kind: 'text.insert', position: { offset: 6 }, text: ' context' }],
        } })).toEqual({ status: 'applied', revision: 2 });
        expect(first.readCurrent().text).toBe('Home A context');
        expect(second.readCurrent().text).toBe('Home B');
    });

    it('selects the exact pending editor Account scope and refuses undeclared Action placement', () => {
        const scope = { serverId: 'pending-home-a', accountId: 'account-a' };
        activeScopeState.value = scope;
        const ref = { kind: 'pendingMessage', sessionId: 'same-session', localId: 'same-pending' } as const;
        const first = createDocumentTarget(createSnapshot({ ref, text: 'Home A' }));
        const foreign = createDocumentTarget(createSnapshot({ ref, text: 'Home B' }));
        cleanups.push(registerComposerPresentationTarget(ref, { ...first, readScope: () => scope }));
        cleanups.push(registerComposerPresentationTarget(ref, { ...foreign, readScope: () => ({ serverId: 'pending-home-b', accountId: 'account-b' }) }));
        expect(readMountedComposerPresentationSnapshot({ scope, ref })?.text).toBe('Home A');
        expect(applyMountedComposerPresentationTransaction({ scope, ref, transaction: {
            expectedRevision: 1, operations: [{ kind: 'text.insert', position: { offset: 6 }, text: ' context' }],
        } })).toEqual({ status: 'applied', revision: 2 });
        expect(first.readCurrent().text).toBe('Home A context');
        expect(foreign.readCurrent().text).toBe('Home B');
        const undeclared = { kind: 'newSession', instanceId: 'scope-undeclared' } as const;
        cleanups.push(registerComposerPresentationTarget(undeclared, createDocumentTarget(createSnapshot({ ref: undeclared }))));
        expect(readMountedComposerPresentationSnapshot({ scope, ref: undeclared })).toBeNull();
    });

    it('inserts qualified dropped context at the caret through one document transaction', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const target = createDocumentTarget(createSnapshot({
            text: 'Keep this draft @old', selection: { start: 4, end: 4 },
            references: [{ kind: 'future.context', ref: 'future:old', token: '@old', start: 16, end: 20 }],
        }));
        cleanups.push(registerComposerPresentationTarget(target.readCurrent().ref, target));
        const context: ComposerEntityDropContext = {
            scope, ref: target.readCurrent().ref, snapshot: target.readCurrent(), workspace: null,
            sessions: [{ id: 'dropped-session', title: 'Current title', serverId: scope.serverId,
                workspaceLabel: null, agentLabel: null, agentId: null, machineId: 'machine-a', updatedAt: 0, active: true }],
            preview: { verb: 'Add context', target: 'Composer' }, reason: code => code,
        };
        const item = { kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'dropped-session' } } as const;
        const admission = resolveComposerEntityDrop(item, context);
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') return;
        expect(applyComposerPresentationTransaction(admission.effect.input as Parameters<typeof applyComposerPresentationTransaction>[0]))
            .toEqual({ status: 'applied', revision: 2 });
        const current = target.readCurrent();
        const token = '[Current title](happier-ref:session:dropped-session)';
        expect(current.text).toBe(`Keep ${token} this draft @old`);
        expect(current.selection).toEqual({ start: 4, end: 4 });
        expect(current.references).toHaveLength(2);
        expect(current.references[0]).toMatchObject({ kind: 'happier.session', ref: 'session:dropped-session', token, start: 5, end: 5 + token.length });
        expect(current.references[1]).toMatchObject({ kind: 'future.context', ref: 'future:old', token: '@old', start: 17 + token.length, end: 21 + token.length });
        expect(JSON.stringify(buildComposerSnapshotStructuredInputMetaOverrides(current))).toContain('session:dropped-session');
        expect(current.text).not.toContain('"kind"');
        expect(resolveComposerEntityDrop({ ...item, scope: { ...scope, accountId: 'other-account' } }, context).status).toBe('refused');
        expect(resolveComposerEntityDrop(item, { ...context, sessions: [] }).status).toBe('refused');
        expect(resolveComposerEntityDrop(item, { ...context, snapshot: { ...current, state: { ...current.state, editable: false } } }).status).toBe('refused');
    });

    it('snaps retained selection endpoints out of a newly inserted reference token', () => {
        const reference = { kind: 'happier.file', ref: 'file:a.ts', label: 'a.ts' };
        const token = '[a.ts](happier-ref:file:a.ts)';
        for (const [selection, expectedSelection] of [
            [{ start: 4, end: 4 }, { start: 3, end: 3 }],
            [{ start: token.length + 2, end: token.length + 2 }, { start: token.length + 3, end: token.length + 3 }],
            [{ start: 4, end: token.length + 2 }, { start: 3, end: token.length + 3 }],
        ] as const) {
            const snapshot = createSnapshot({ text: 'x'.repeat(token.length + 20), selection });
            const target = createDocumentTarget(snapshot);
            cleanups.push(registerComposerPresentationTarget(snapshot.ref, target));
            const operations = planComposerReferenceInsertion({ snapshot, reference, at: { kind: 'offset', offset: 2 } });
            expect(applyComposerPresentationTransaction({ ref: snapshot.ref,
                transaction: { expectedRevision: snapshot.revision, operations } })).toEqual({ status: 'applied', revision: 2 });
            expect(target.readCurrent().selection).toEqual(expectedSelection);
        }
    });

    it('drops in the middle of the draft, snaps across chips, and refuses a stale admission without writing', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const token = '[old.ts](happier-ref:file:old.ts)';
        const snapshot = createSnapshot({ text: `Before ${token} after`, selection: { start: 0, end: 0 },
            references: [{ kind: 'happier.file', ref: 'file:old.ts', label: 'old.ts', token, start: 7, end: 7 + token.length }] });
        const target = createDocumentTarget(snapshot);
        cleanups.push(registerComposerPresentationTarget(snapshot.ref, target));
        const item = { kind: 'repository-file', scope, machineId: 'machine-a', path: '/repo/new.ts' } as const;
        const context: ComposerEntityDropContext = {
            scope, ref: snapshot.ref, snapshot, sessions: [],
            workspace: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' },
            at: { kind: 'offset', offset: 9 }, preview: { verb: 'Mention', target: 'Composer' }, reason: code => code,
        };
        const admission = resolveComposerEntityDrop(item, context);
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') return;
        const input = admission.effect.input as Parameters<typeof applyComposerPresentationTransaction>[0];
        expect(applyComposerPresentationTransaction(input)).toEqual({ status: 'applied', revision: 2 });
        expect(target.readCurrent().text).toBe(`Before [new.ts](happier-ref:file:new.ts) ${token} after`);
        const applied = target.readCurrent();
        expect(applyComposerPresentationTransaction(input).status).toBe('conflict');
        expect(target.readCurrent()).toEqual(applied);
    });

    it.each(['pointer', 'native'] as const)('uses the mounted editor release point for %s and clears its hover caret before keyboard insertion', async (mode) => {
        activeScopeState.value = null;
        await prepareSessionFilesViewTestkit();
        const account = await createSessionFilesViewFixture({ serverIdentityId: 'srv_composer_drop',
            sessionId: 'session-1', machineId: 'machine-a', rootPath: '/repo' });
        cleanups.push(() => account.dispose());
        const scope = { serverId: account.scope.serverId, accountId: 'alice' };
        const document = createDocumentTarget(createSnapshot({ text: 'Before after', selection: { start: 0, end: 0 } }));
        const ref = document.readCurrent().ref;
        if (ref.kind !== 'session') throw new Error('Session fixture required');
        cleanups.push(registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId }, { ...document, readScope: () => scope }));
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 0;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
        cleanups.push(() => { vi.unstubAllGlobals(); });
        const handle = { offsetAtPoint: vi.fn(async () => 7), setDropCaret: vi.fn() };
        const mounted = await renderHook(() => {
            const runtime = useEntityDragDropRuntime();
            ComposerEntityDropTarget({ id: 'composer-drop', scope, refValue: document.readCurrent().ref,
                bounds: () => ({ x: 0, y: 0, width: 200, height: 100 }), presented: true, editable: true,
                kinds: ['file'], fileScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' },
                inputRef: { current: handle } });
            return runtime;
        });
        const runtime = mounted.getCurrent();
        cleanups.push(runtime.registerSource({ id: 'dropped-file', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'repository-file', scope, machineId: 'machine-a', path: '/repo/a.ts' }) }));
        const carry = runtime.begin('dropped-file')!;
        const { createEntityDragGestureAdapter } = await import('@/components/ui/treeDragDrop/entityDragGestureAdapter');
        const gesture = mode === 'native' ? createEntityDragGestureAdapter(carry) : null;
        await act(async () => {
            if (gesture) gesture.update({ x: 80, y: 20 });
            else carry.move({ x: 80, y: 20 });
        });
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', targetId: 'composer-drop', admission: { status: 'allowed' } });
        await act(async () => {
            for (const callback of frames.values()) callback(0);
            frames.clear();
            await Promise.resolve();
        });
        expect(handle.setDropCaret).toHaveBeenLastCalledWith(7);
        await act(async () => { expect(await (gesture ? gesture.end(true, { x: 90, y: 20 }) : carry.release())).toEqual({ status: 'applied' }); });
        expect(handle.offsetAtPoint).toHaveBeenLastCalledWith({ x: gesture ? 90 : 80, y: 20 });
        expect(document.readCurrent().text).toBe('Before [a.ts](happier-ref:file:a.ts) after');
        expect(handle.setDropCaret).toHaveBeenLastCalledWith(null);
        await act(async () => {
            const keyboard = runtime.begin('dropped-file', 'keyboard')!;
            keyboard.choose('composer-drop');
            expect(await keyboard.release()).toEqual({ status: 'applied' });
        });
        expect(document.readCurrent().text).toBe('[a.ts](happier-ref:file:a.ts) Before [a.ts](happier-ref:file:a.ts) after');
    });

    it('admits repository references only on the exact current machine and workspace', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const snapshot = createSnapshot({ text: 'Draft', selection: { start: 5, end: 5 } });
        const context: ComposerEntityDropContext = {
            scope, ref: snapshot.ref, snapshot, sessions: [],
            workspace: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' },
            preview: { verb: 'Add context', target: 'Composer' }, reason: code => code,
        };
        const item = { kind: 'repository-file', scope, machineId: 'machine-a', path: '/repo/src/file.ts' } as const;
        const admission = resolveComposerEntityDrop(item, context);
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') return;
        expect(admission.effect.input).toMatchObject({ transaction: { expectedRevision: 1, operations: [
            { kind: 'text.insert', text: ' [file.ts](happier-ref:file:src/file.ts) ' },
            { kind: 'reference.insert', reference: { kind: 'happier.file', ref: 'file:src/file.ts' } },
        ] } });
        expect(admission.effect.input).toMatchObject({ transaction: {
            operations: buildFileReferenceOperation('src/file.ts', snapshot),
        } });
        expect(resolveComposerEntityDrop({ ...item, path: '/repo-other/file.ts' }, context).status).toBe('refused');
        expect(resolveComposerEntityDrop({ ...item, machineId: 'other-machine' }, context).status).toBe('refused');
        expect(resolveComposerEntityDrop({ ...item, path: '../escape.ts' }, context).status).toBe('refused');
        const windowsContext = { ...context, workspace: { ...context.workspace!, rootPath: 'C:\\Users\\Alice\\repo\\' } };
        expect(resolveComposerEntityDrop({ ...item, path: 'c:/users/ALICE/repo\\src/file.ts' }, windowsContext).status).toBe('allowed');
        expect(resolveComposerEntityDrop({ ...item, path: 'C:\\Users\\Alice\\repo2\\src\\file.ts' }, windowsContext).status).toBe('refused');
        expect(resolveComposerEntityDrop({ ...item, path: '/repo/src/../escape.ts' }, context).status).toBe('refused');
    });

    it('mentions repository folders and workflow identities while refusing the excluded families', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const snapshot = createSnapshot({ text: 'Read this', selection: { start: 5, end: 5 } });
        const context: ComposerEntityDropContext = { scope, ref: snapshot.ref, snapshot, sessions: [], itemLabel: 'Release checks',
            workspace: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' },
            preview: { verb: 'Mention', target: 'Composer' }, reason: code => code };
        const folder = resolveComposerEntityDrop({ kind: 'repository-file', scope, machineId: 'machine-a',
            path: '/repo/src', entryKind: 'directory' }, context);
        expect(folder).toMatchObject({ status: 'allowed', effect: { input: { transaction: { operations: [
            { kind: 'text.insert', position: { offset: 5 }, text: '[src/](happier-ref:file:src/) ' },
            { kind: 'reference.insert', reference: { kind: 'happier.file', ref: 'file:src/', label: 'src/' } },
        ] } } } });
        const workflow = resolveComposerEntityDrop({ kind: 'workflow', scope, workflowId: 'release' }, context);
        expect(workflow).toMatchObject({ status: 'allowed', effect: { input: { transaction: { operations: [
            { kind: 'text.insert', text: '[Release checks](happier-ref:workflow:release) ' },
            { kind: 'reference.insert', reference: { kind: 'happier.workflow', ref: 'workflow:release', label: 'Release checks' } },
        ] } } } });
        for (const item of [{ kind: 'artifact', scope, artifactId: 'a' }, { kind: 'todo', scope, todoId: 't' },
            { kind: 'work-board-item', scope, boardId: 'b', item: { kind: 'session', qualifiedId: { serverId: scope.serverId, id: 's' } } },
            { kind: 'companion-item', scope, address: { serverId: scope.serverId, sessionId: 's' }, item: { kind: 'widget', widgetId: 'w' } }] as const) {
            expect(resolveComposerEntityDrop(item, context)).toMatchObject({ status: 'refused', reason: { code: 'referenceUnavailable' } });
        }
    });

    it('mentions qualified widgets through the canonical instance identity', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const snapshot = createSnapshot({ text: '', selection: { start: 0, end: 0 } });
        const context: ComposerEntityDropContext = { scope, ref: snapshot.ref, snapshot, sessions: [], workspace: null,
            itemLabel: 'Build status', preview: { verb: 'Mention', target: 'Composer' }, reason: code => code };
        const ref = { surface: { ...scope, owner: { kind: 'workBoard' as const, boardId: 'board-a' } }, instanceId: 'widget-a' };
        for (const item of [{ kind: 'work-board-widget', scope, boardId: 'board-a', instanceId: 'widget-a' },
            { kind: 'widget-area-instance', scope, ref: { ...ref, surface: { ...scope, owner: { kind: 'project', projectId: 'project-a' } } } }] as const) {
            const identity = item.kind === 'work-board-widget' ? ref : item.ref;
            expect(resolveComposerEntityDrop(item, context)).toMatchObject({ status: 'allowed', effect: { input: { transaction: {
                operations: [expect.objectContaining({ kind: 'text.insert' }), { kind: 'reference.insert', reference: {
                    kind: 'happier.widget', ref: buildMentionRefForKindV1(MENTION_KIND_V1.widget, formatWidgetInstanceRefKeyV1(identity)),
                    label: 'Build status', start: 0,
                } }],
            } } } });
        }
    });

    it('preserves predecessor Message identities and unknown references when adding new context', () => {
        // Observed ../0.2 HEAD 2124e78e: structuredInputMentions.ts writes this
        // positionless Message identity. This is not a reconstructed current draft.
        const text = 'Continue @session:older @future';
        const envelope = readHappierStructuredInputV1FromMeta({ happierStructuredInputV1: { v: 1, mentions: [
            { kind: 'happier.session', ref: 'session:older', token: '@session:older', label: 'Older Session' },
            { kind: 'future.context', ref: 'future:42', token: '@future' },
        ] } });
        expect(envelope?.mentions).toHaveLength(2);
        const references = placePositionlessComposerReferences({ text, references: envelope!.mentions! });
        const target = createDocumentTarget(createSnapshot({ text, references }));
        cleanups.push(registerComposerPresentationTarget(target.readCurrent().ref, target));
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const admission = resolveComposerEntityDrop({ kind: 'repository-file', scope, machineId: 'm', path: '/repo/current.ts' }, {
            scope, ref: target.readCurrent().ref, snapshot: target.readCurrent(), sessions: [],
            workspace: { serverId: scope.serverId, machineId: 'm', rootPath: '/repo' },
            preview: { verb: 'Add context', target: 'Composer' }, reason: code => code,
        });
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') return;
        expect(applyComposerPresentationTransaction(admission.effect.input as Parameters<typeof applyComposerPresentationTransaction>[0]).status).toBe('applied');
        expect(target.readCurrent().references.slice(0, 2)).toEqual(references);
        expect(readHappierStructuredInputV1FromMeta(buildComposerSnapshotStructuredInputMetaOverrides(target.readCurrent()))?.mentions?.slice(0, 2))
            .toEqual(envelope?.mentions);
    });

    it('admits only a live contributed reference and keeps malformed carried data inert', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const target = createDocumentTarget(createSnapshot({ text: 'Review', selection: { start: 1, end: 3 } }));
        cleanups.push(registerComposerPresentationTarget(target.readCurrent().ref, target));
        const projection: PluginProjectionV2 = { v: 2, generation: 1,
            installedPackagesById: {}, agentsById: {}, actionsById: {},
            resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
            contributionIntrospection: { version: 1, generation: 1, diagnostics: [], contributions: [{
                version: 1, occurrenceId: 'live', contribution: { kind: 'localId', pluginId: 'acme.issues',
                    localId: 'pull-requests', family: 'composerReferences', qualifiedId: 'acme.issues/pull-requests' },
                progression: { declared: true, normalized: true, merged: true },
                registration: { requirement: 'required', state: 'bound', occurrenceId: 'live' },
                activation: { state: 'active', occurrenceId: 'live' }, projection: { state: 'projected' },
                consumer: 'composer-reference-host', platforms: ['cli', 'web'], diagnostics: [],
                presentation: { kind: 'composerReference', title: 'Pull requests', icon: 'search', triggers: ['@'] },
            }] },
        };
        const context: ComposerEntityDropContext = { scope, ref: target.readCurrent().ref, snapshot: target.readCurrent(),
            workspace: null, sessions: [], referenceHost: { projection, pluginUiProjection: normalizePluginUiProjection(projection, 'web'), serverId: scope.serverId, machineId: 'm', isCurrent: () => true },
            preview: { verb: 'Add context', target: 'Composer' }, reason: code => code };
        const item = { kind: 'plugin', scope, contribution: { pluginId: 'acme.issues', localId: 'pr-drag' },
            reference: buildComposerReferenceMentionPayloadV1({ reference: { pluginId: 'acme.issues', localId: 'pull-requests' },
                candidate: { id: 'pr:42', label: 'PR 42' } }) } as const;
        const admission = resolveComposerEntityDrop(item, context);
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') return;
        expect(applyComposerPresentationTransaction(admission.effect.input as Parameters<typeof applyComposerPresentationTransaction>[0]).status).toBe('applied');
        expect(target.readCurrent()).toMatchObject({ selection: { start: 1, end: 2 }, references: [{
            kind: 'happier.composerReference', ref: 'composerReference:pr:42', composerReference: { pluginId: 'acme.issues', localId: 'pull-requests' },
        }] });
        expect(target.readCurrent().text).toBe('R [PR 42](happier-ref:composerReference:pr:42) iew');
        expect(resolveComposerEntityDrop(item, { ...context, referenceHost: { ...context.referenceHost!, isCurrent: () => false } }).status).toBe('refused');
        expect(resolveComposerEntityDrop(item, { ...context, referenceHost: { ...context.referenceHost!, projection: { ...projection, contributionIntrospection: undefined } } }).status).toBe('refused');
        expect(resolveComposerEntityDrop({ ...item, reference: { actionId: 'session.send', input: { text: 'transport' } } }, context).status).toBe('refused');
        expect(resolveComposerEntityDrop({ ...item, reference: { ...item.reference, label: 'x'.repeat(5000) } }, context).status).toBe('refused');
    });

    it('opens prompts through the exact Home target, rejecting hidden, retired and locked composers', () => {
        const ref = { kind: 'session', sessionId: 'same-id' } as const;
        const address = { serverId: 'https://home.example.test', sessionId: ref.sessionId };
        let presented = true;
        let current = true;
        let editable = true;
        const open = vi.fn(() => true);
        const otherOpen = vi.fn(() => true);
        const base = createSnapshot({ ref });
        cleanups.push(registerSessionComposerPresentationTarget(address, {
            ...createDocumentTarget(base),
            isCurrent: () => current,
            isPresented: () => presented,
            readSnapshot: () => ({ ...base, state: { ...base.state, editable } }),
            openPromptPicker: open,
        }));
        cleanups.push(registerSessionComposerPresentationTarget({ ...address, serverId: 'https://other.example.test' }, {
            ...createDocumentTarget(base), openPromptPicker: otherOpen,
        }));
        expect(requestRegisteredComposerPromptPicker({ ref, serverId: address.serverId })).toEqual(ref);
        expect(open).toHaveBeenCalledOnce();
        expect(otherOpen).not.toHaveBeenCalled();
        presented = false;
        expect(requestRegisteredComposerPromptPicker({ ref, serverId: address.serverId })).toBeNull();
        presented = true;
        current = false;
        expect(requestRegisteredComposerPromptPicker({ ref, serverId: address.serverId })).toBeNull();
        current = true;
        editable = false;
        expect(requestRegisteredComposerPromptPicker({ ref, serverId: address.serverId })).toBeNull();
        expect(open).toHaveBeenCalledOnce();
    });

    it('opens the focused New/Home composer and never falls back from an absent explicit address', () => {
        const ref = { kind: 'newSession', instanceId: 'home-composer' } as const;
        const base = createSnapshot({ ref });
        let focused = true;
        let ready = true;
        const open = vi.fn(() => ready);
        const unregister = registerComposerPresentationTarget(ref, {
            ...createDocumentTarget(base),
            readSnapshot: () => ({ ...base, state: { ...base.state, focused } }),
            openPromptPicker: open,
        });
        cleanups.push(unregister);
        expect(requestRegisteredComposerPromptPicker({})).toEqual(ref);
        focused = false;
        expect(requestRegisteredComposerPromptPicker({})).toBeNull();
        expect(requestRegisteredComposerPromptPicker({ ref })).toEqual(ref);
        expect(requestRegisteredComposerPromptPicker({ ref: { kind: 'newSession', instanceId: 'missing' } })).toBeNull();
        ready = false;
        expect(requestRegisteredComposerPromptPicker({ ref })).toBeNull();
        unregister();
        expect(requestRegisteredComposerPromptPicker({ ref })).toBeNull();
    });

    it('executes the client Action through the real addressed target and cancels before opening', async () => {
        const ref = { kind: 'session', sessionId: 'action-session' } as const;
        const base = createSnapshot({ ref, text: 'private draft' });
        const open = vi.fn(() => true);
        cleanups.push(registerSessionComposerPresentationTarget({ serverId: 'https://home.example.test', sessionId: ref.sessionId }, {
            ...createDocumentTarget(base), openPromptPicker: open,
        }));
        const request = { actionId: 'ui.prompts.picker.open' as const, input: {},
            context: { surface: 'agent' as const, defaultSessionId: ref.sessionId, serverId: 'https://home.example.test' } };
        await expect(executePromptPickerOpenAction(request)).resolves.toEqual({ ok: true, result: { status: 'opened', composerRef: ref } });
        await expect(executePromptPickerOpenAction({ ...request, context: { ...request.context, serverId: 'https://other.example.test' } }))
            .resolves.toEqual({ ok: true, result: { status: 'noEligibleComposer' } });
        const cancellation = new AbortController();
        cancellation.abort();
        await expect(executePromptPickerOpenAction({ ...request, context: { ...request.context, signal: cancellation.signal } })).rejects.toBeDefined();
        expect(open).toHaveBeenCalledOnce();
    });

    it('delivers a pending focus intent once when the exact qualified Session composer registers', () => {
        const address = { serverId: 'https://home.example.test:8443', sessionId: 'shared-id' } as const;
        const otherAddress = { serverId: 'https://other.example.test', sessionId: 'shared-id' } as const;
        const focus = vi.fn(() => true);
        const otherFocus = vi.fn(() => true);

        expect(requestRegisteredSessionComposerFocus(address)).toBe(false);
        cleanups.push(registerSessionComposerPresentationTarget(otherAddress, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'shared-id' } })),
            focusComposer: otherFocus,
        }));
        expect(otherFocus).not.toHaveBeenCalled();

        cleanups.push(registerSessionComposerPresentationTarget(address, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'shared-id' } })),
            focusComposer: focus,
        }));
        expect(focus).toHaveBeenCalledTimes(1);

        cleanups.pop()?.();
        cleanups.push(registerSessionComposerPresentationTarget(address, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'shared-id' } })),
            focusComposer: focus,
        }));
        expect(focus).toHaveBeenCalledTimes(1);
    });

    it('opens a composer action chip on the exact Session composer, retaining one request until it can', () => {
        const address = { serverId: 'https://home.example.test', sessionId: 'goal-session' } as const;
        const otherAddress = { serverId: 'https://other.example.test', sessionId: 'goal-session' } as const;
        let ready = false;
        const openActionChip = vi.fn((chipKey: string) => ready && chipKey === 'session-goal');
        const otherOpen = vi.fn(() => true);

        expect(readSessionComposerActionChipAvailable(address, 'session-goal')).toBe(false);
        expect(requestRegisteredSessionComposerActionChip(address, 'session-goal')).toBe(false);
        cleanups.push(registerSessionComposerPresentationTarget(otherAddress, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'goal-session' } })),
            openActionChip: otherOpen,
            hasActionChip: () => true,
        }));
        expect(otherOpen).not.toHaveBeenCalled();

        cleanups.push(registerSessionComposerPresentationTarget(address, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'goal-session' } })),
            openActionChip,
            hasActionChip: (chipKey) => chipKey === 'session-goal',
        }));
        // Registered but not on screen yet: the request stays pending.
        expect(openActionChip).toHaveBeenCalledWith('session-goal');
        expect(readSessionComposerActionChipAvailable(address, 'session-goal')).toBe(true);
        expect(readSessionComposerActionChipAvailable(address, 'other-chip')).toBe(false);

        ready = true;
        expect(flushPendingRegisteredSessionComposerActionChip(address)).toBe(true);
        // Delivered once: a second flush has nothing to deliver.
        expect(flushPendingRegisteredSessionComposerActionChip(address)).toBe(false);
        expect(openActionChip).toHaveBeenCalledTimes(2);

        expect(requestRegisteredSessionComposerActionChip(address, 'session-goal')).toBe(true);
        expect(openActionChip).toHaveBeenCalledTimes(3);
        expect(otherOpen).not.toHaveBeenCalled();
    });

    it('focuses the requested Home when same-ID Session composers are mounted together', () => {
        const address = { serverId: 'https://home.example.test', sessionId: 'shared-id' } as const;
        const otherAddress = { serverId: 'https://other.example.test', sessionId: 'shared-id' } as const;
        const focus = vi.fn(() => true);
        const otherFocus = vi.fn(() => true);
        cleanups.push(registerSessionComposerPresentationTarget(address, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'shared-id' } })),
            focusComposer: focus,
        }));
        cleanups.push(registerSessionComposerPresentationTarget(otherAddress, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'shared-id' } })),
            focusComposer: otherFocus,
        }));

        expect(requestRegisteredSessionComposerFocus(address)).toBe(true);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(otherFocus).not.toHaveBeenCalled();
    });

    it('reads presentation effects from the exact Home when same-ID Sessions are mounted together', () => {
        const address = { serverId: 'https://home.example.test', sessionId: 'shared-id' } as const;
        const otherAddress = { serverId: 'https://other.example.test', sessionId: 'shared-id' } as const;
        const apply = vi.fn(() => ({ status: 'applied' as const }));
        const otherApply = vi.fn(() => ({ status: 'applied' as const }));
        cleanups.push(registerSessionComposerPresentationTarget(address, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'shared-id' } })),
            applySessionPresentationIntent: apply,
        }));
        cleanups.push(registerSessionComposerPresentationTarget(otherAddress, {
            ...createDocumentTarget(createSnapshot({ ref: { kind: 'session', sessionId: 'shared-id' } })),
            applySessionPresentationIntent: otherApply,
        }));

        readSessionComposerPresentationTargetAtAddress(address)?.applySessionPresentationIntent?.({
            kind: 'companion.show',
        });

        expect(apply).toHaveBeenCalledTimes(1);
        expect(otherApply).not.toHaveBeenCalled();
        expect(readSessionComposerPresentationTargetAtAddress({
            serverId: '',
            sessionId: 'shared-id',
        })).toBeNull();
        expect(readSessionComposerPresentationTargetAtAddress({
            serverId: 'https://missing.example.test',
            sessionId: 'shared-id',
        })).toBeNull();
    });

    it('binds a Session plugin transaction applier to the exact Home', () => {
        const address = { serverId: 'https://home.example.test', sessionId: 'shared-id' } as const;
        const otherAddress = { serverId: 'https://other.example.test', sessionId: 'shared-id' } as const;
        const target = createDocumentTarget(createSnapshot({
            ref: { kind: 'session', sessionId: address.sessionId },
        }));
        const otherTarget = createDocumentTarget(createSnapshot({
            ref: { kind: 'session', sessionId: address.sessionId },
        }));
        cleanups.push(registerSessionComposerPresentationTarget(address, target));
        cleanups.push(registerSessionComposerPresentationTarget(otherAddress, otherTarget));
        const applier = createComposerPresentationTransactionApplier({
            composerAttachmentsById: {},
            sessionAddress: address,
        });

        expect(applier.apply({
            ref: { kind: 'session', sessionId: address.sessionId },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{ kind: 'text.set', text: 'Home A only' }],
            },
        })).toEqual({ status: 'applied', revision: 2 });
        expect(target.commitDocument).toHaveBeenCalledTimes(1);
        expect(otherTarget.commitDocument).not.toHaveBeenCalled();
    });

    it('refuses a transaction through a retired exact target after that address is replaced', () => {
        const address = { serverId: 'https://home.example.test', sessionId: 'shared-id' } as const;
        const first = createDocumentTarget(createSnapshot({
            ref: { kind: 'session', sessionId: address.sessionId },
        }));
        const replacement = createDocumentTarget(createSnapshot({
            ref: { kind: 'session', sessionId: address.sessionId },
        }));
        const unregisterFirst = registerSessionComposerPresentationTarget(address, first);
        const resolved = readSessionComposerPresentationTargetAtAddress(address);
        expect(resolved).not.toBeNull();

        unregisterFirst();
        cleanups.push(registerSessionComposerPresentationTarget(address, replacement));

        expect(resolved?.applyTransaction({
            expectedRevision: 1,
            operations: [{ kind: 'text.set', text: 'must not apply' }],
        })).toEqual({ status: 'composerUnavailable' });
        expect(first.commitDocument).not.toHaveBeenCalled();
        expect(replacement.commitDocument).not.toHaveBeenCalled();
    });

    it('refuses a presentation effect through a retired exact target after that address is replaced', () => {
        const address = { serverId: 'https://home.example.test', sessionId: 'shared-id' } as const;
        const firstApply = vi.fn(() => ({ status: 'applied' as const }));
        const replacementApply = vi.fn(() => ({ status: 'applied' as const }));
        const first = {
            ...createDocumentTarget(createSnapshot({
                ref: { kind: 'session', sessionId: address.sessionId },
            })),
            applySessionPresentationIntent: firstApply,
        };
        const replacement = {
            ...createDocumentTarget(createSnapshot({
                ref: { kind: 'session', sessionId: address.sessionId },
            })),
            applySessionPresentationIntent: replacementApply,
        };
        const unregisterFirst = registerSessionComposerPresentationTarget(address, first);
        const resolved = readSessionComposerPresentationTargetAtAddress(address);
        expect(resolved).not.toBeNull();

        unregisterFirst();
        cleanups.push(registerSessionComposerPresentationTarget(address, replacement));

        expect(resolved?.applySessionPresentationIntent?.({ kind: 'companion.show' }))
            .toEqual({ status: 'notCurrent' });
        expect(firstApply).not.toHaveBeenCalled();
        expect(replacementApply).not.toHaveBeenCalled();
    });

    it('refuses a new staged attachment through the synchronous owner instead of publishing unclaimed', () => {
        // Custody is admitted only by the attachment-capable Host API path.
        // The synchronous owner refuses typed rather than silently publishing
        // a handle no transfer-store claim protects.
        const stagedMedia = createStagedMediaContent();
        const target = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));
        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: stagedMedia.handle.executionTarget,
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: stagedMedia,
                }],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 0,
            reason: 'staged_media_custody_required',
        });
        expect(target.readCurrent().attachments).toEqual([]);
        expect(claimComposerContentSpy).not.toHaveBeenCalled();
    });

    it('releases a newly claimed stage introduced and removed inside one committed transaction', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = createDocumentTarget(createSnapshot(), () => 'host-created-issue-42');
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        await expect(applier.applyWithAttachmentCustody({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: stagedMedia.handle.executionTarget,
            transaction: {
                expectedRevision: 1,
                operations: [
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                        content: stagedMedia,
                    },
                    { kind: 'attachment.remove', instanceId: 'host-created-issue-42' },
                ],
            },
        })).resolves.toMatchObject({ status: 'applied' });

        expect(target.readCurrent().attachments).toEqual([]);
        await Promise.resolve();
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle, {
            claimant: {
                composer: { kind: 'session', sessionId: 'session-1' },
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
    });

    it('keeps distinct live composer scope arms from colliding in the one target registry', () => {
        const sessionTarget = { readRevision: vi.fn(() => 1), replace: vi.fn(() => 1) };
        const pendingTarget = { readRevision: vi.fn(() => 2), replace: vi.fn(() => 2) };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionTarget,
        ));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            pendingTarget,
        ));

        expect(readComposerPresentationTarget({ kind: 'session', sessionId: 'session-1' }))
            .toMatchObject({ revision: 1, replace: sessionTarget.replace });
        expect(readComposerPresentationTarget({ kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' }))
            .toMatchObject({ revision: 2, replace: pendingTarget.replace });
    });

    describe('visibility-eligible targeting (plan 05 SC-R7)', () => {
        const address = { serverId: 'https://home.example.test', sessionId: 'session-7' } as const;
        const ref = { kind: 'session', sessionId: 'session-7' } as const;

        function presentationTarget(revision: number, presented: { value: boolean }) {
            return {
                ...createDocumentTarget(createSnapshot({ ref, revision })),
                isPresented: () => presented.value,
                focusComposer: vi.fn(() => true),
            };
        }

        it('resolves to the presented target, not a hidden retained one that registered later', () => {
            const visible = { value: true };
            const hidden = { value: false };
            const visibleTarget = presentationTarget(10, visible);
            const hiddenTarget = presentationTarget(20, hidden);
            cleanups.push(registerSessionComposerPresentationTarget(address, visibleTarget));
            cleanups.push(registerSessionComposerPresentationTarget(address, hiddenTarget));

            expect(readSessionComposerPresentationTargetAtAddress(address)?.revision).toBe(10);
            expect(readComposerPresentationTarget(ref)?.revision).toBe(10);
            expect(requestRegisteredSessionComposerFocus(address)).toBe(true);
            expect(visibleTarget.focusComposer).toHaveBeenCalledTimes(1);
            expect(hiddenTarget.focusComposer).not.toHaveBeenCalled();
        });

        it('restores the next eligible target when the resolved one unregisters, and notifies', () => {
            const first = presentationTarget(1, { value: true });
            const second = presentationTarget(2, { value: true });
            const listener = vi.fn();
            cleanups.push(subscribeComposerPresentationTarget(ref, listener));
            cleanups.push(registerSessionComposerPresentationTarget(address, first));
            const unregisterSecond = registerSessionComposerPresentationTarget(address, second);
            expect(readSessionComposerPresentationTargetAtAddress(address)?.revision).toBe(2);
            listener.mockClear();

            unregisterSecond();

            expect(readSessionComposerPresentationTargetAtAddress(address)?.revision).toBe(1);
            expect(readComposerPresentationTarget(ref)?.revision).toBe(1);
            expect(listener).toHaveBeenCalled();
        });

        it('follows a presentation change after the change notification', () => {
            const primary = { value: false };
            const embedded = { value: true };
            cleanups.push(registerSessionComposerPresentationTarget(address, presentationTarget(1, embedded)));
            cleanups.push(registerSessionComposerPresentationTarget(address, presentationTarget(2, primary)));
            expect(readSessionComposerPresentationTargetAtAddress(address)?.revision).toBe(1);

            primary.value = true;
            embedded.value = false;
            notifyComposerPresentationTargetChanged(ref);

            expect(readSessionComposerPresentationTargetAtAddress(address)?.revision).toBe(2);
        });

        it('keeps resolution when a non-resolved target unregisters, with the unqualified mirror equal to it', () => {
            const resolved = presentationTarget(1, { value: true });
            const retained = presentationTarget(2, { value: false });
            cleanups.push(registerSessionComposerPresentationTarget(address, resolved));
            const unregisterRetained = registerSessionComposerPresentationTarget(address, retained);

            unregisterRetained();

            expect(readSessionComposerPresentationTargetAtAddress(address)?.revision).toBe(1);
            expect(readComposerPresentationTarget(ref)?.revision).toBe(1);
        });

        it('falls back to the latest current target when none is presented', () => {
            cleanups.push(registerSessionComposerPresentationTarget(address, presentationTarget(1, { value: false })));
            cleanups.push(registerSessionComposerPresentationTarget(address, presentationTarget(2, { value: false })));

            expect(readSessionComposerPresentationTargetAtAddress(address)?.revision).toBe(2);
        });
    });

    it('does not let an obsolete registration cleanup retire the current target', () => {
        const oldTarget = { readRevision: vi.fn(() => 1), replace: vi.fn(() => 1) };
        const currentTarget = { readRevision: vi.fn(() => 2), replace: vi.fn(() => 2) };
        const retireOld = registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            oldTarget,
        );
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            currentTarget,
        ));

        retireOld();

        expect(readComposerPresentationTarget({ kind: 'session', sessionId: 'session-1' }))
            .toMatchObject({ revision: 2, replace: currentTarget.replace });
    });

    it('adds and removes an exact plugin attachment through one explicitly addressed composer without a control or picker', () => {
        const token = '[Issue](happier-ref:attachment:host-created-issue-42)';
        const keptToken = '[Session](happier-ref:session:session-2)';
        const text = `${token} and ${keptToken} then ${token}; plain ${token}`;
        const keptStart = token.length + 5;
        const secondStart = keptStart + keptToken.length + 6;
        const target = createDocumentTarget(createSnapshot({
            text,
            selection: { start: text.length, end: text.length },
            references: [
                { kind: 'happier.attachment', ref: 'attachment:host-created-issue-42', token, start: 0, end: token.length },
                { kind: 'happier.session', ref: 'session:session-2', token: keptToken, start: keptStart, end: keptStart + keptToken.length },
                { kind: 'happier.attachment', ref: 'attachment:host-created-issue-42', token, start: secondStart, end: secondStart + token.length },
            ],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));
        const added = applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        });

        expect(added).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-issue-42'],
        });
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 'session-1' }))
            .toMatchObject({
                revision: 2,
                attachments: [{
                    instanceId: 'host-created-issue-42',
                    attachment: { pluginId: 'acme.issues', localId: 'issue' },
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                    availability: { status: 'ready' },
                }],
            });
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 'session-1' })?.attachments[0])
            .not.toHaveProperty('content');

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 2,
                operations: [{ kind: 'attachment.remove', instanceId: 'host-created-issue-42' }],
            },
        })).toEqual({ status: 'applied', revision: 3 });
        expect(target.readCurrent().attachments).toEqual([]);
        const nextText = ` and ${keptToken} then ; plain ${token}`;
        expect(target.readCurrent()).toMatchObject({
            text: nextText,
            references: [{ ref: 'session:session-2', start: 5, end: 5 + keptToken.length }],
            selection: { start: nextText.length, end: nextText.length },
        });
        expect(target.readCurrent().references).toHaveLength(1);
    });

    it('reads added and withdrawn attachment authority at each transaction admission', () => {
        const target = createDocumentTarget(createSnapshot());
        const ref = { kind: 'session' as const, sessionId: 'session-1' };
        cleanups.push(registerComposerPresentationTarget(ref, target));
        const entry = createAttachmentProjectionEntry({ pluginId: 'acme.issues', localId: 'issue', typeLabel: 'Issue' });
        let composerAttachmentsById: Readonly<Record<string, PluginUiComposerAttachmentProjection>> = {};
        const applier = createComposerPresentationTransactionApplier({ get composerAttachmentsById() { return composerAttachmentsById; } });
        const apply = (expectedRevision: number) => applier.apply({ ref,
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: { expectedRevision, operations: [{ kind: 'attachment.add', attachmentLocalId: 'issue',
                value: { key: '42', value: { issueId: 42 }, presentation: { label: 'Issue #42' } } }] },
        });
        expect(apply(1)).toMatchObject({ status: 'invalidOperation', reason: 'attachment_authority_mismatch' });
        composerAttachmentsById = { [entry.id]: entry };
        expect(apply(1)).toMatchObject({ status: 'applied', revision: 2 });
        composerAttachmentsById = {};
        expect(apply(2)).toMatchObject({ status: 'invalidOperation', reason: 'attachment_authority_mismatch' });
        expect(readComposerPresentationSnapshot(ref)).toMatchObject({ revision: 2, attachments: [{ key: '42' }] });
    });

    it('freezes the CURRENT locale into an admitted attachment type label, not the declaration fallback', () => {
        const target = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        // 03d1 persists this label as a plain string so replay never depends on
        // installed plugin translations. That makes resolving the reader's
        // current locale BEFORE the freeze the whole point.
        const entry = createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        });
        const localizedEntry = {
            ...entry,
            definition: {
                ...entry.definition,
                title: { key: 'acme.issues.type', fallback: 'Issue' },
            },
        } as PluginUiComposerAttachmentProjection;
        const applier = createComposerPresentationTransactionApplier({
            composerAttachmentsById: { [localizedEntry.id]: localizedEntry },
            localize: (pluginId, value) => (
                pluginId === 'acme.issues'
                && typeof value === 'object'
                && value !== null
                && (value as { key?: unknown }).key === 'acme.issues.type'
                    ? 'Ticket'
                    : 'unresolved'
            ),
        });

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        })).toMatchObject({ status: 'applied' });

        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 'session-1' }))
            .toMatchObject({
                attachments: [{
                    presentation: { label: 'Issue #42', typeLabel: 'Ticket' },
                }],
            });
    });

    it('preserves an opaque staged-media claim through the async custody applier and draft snapshot', async () => {
        const target = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const stagedMedia = createStagedMediaContent();
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        await expect(applier.applyWithAttachmentCustody({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: stagedMedia.handle.executionTarget,
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: stagedMedia,
                }],
            },
        })).resolves.toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-issue-42'],
        });

        expect(claimComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle, {
            composer: { kind: 'session', sessionId: 'session-1' },
            attachmentInstanceId: 'host-created-issue-42',
        });
        expect(target.readCurrent().attachments).toMatchObject([{
            instanceId: 'host-created-issue-42',
            content: stagedMedia,
        }]);
    });

    it('does not release a newly claimed stage when currentness loses and snapshot adjudication throws', async () => {
        const stagedMedia = createStagedMediaContent();
        const exactPublishedAttachment = {
            v: 1 as const,
            instanceId: 'host-created-issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            availability: { status: 'ready' as const },
            content: stagedMedia,
        };
        const baseTarget = createDocumentTarget(createSnapshot());
        const commitBaseDocument = baseTarget.commitDocument;
        if (!commitBaseDocument) {
            throw new Error('test fixture must expose a document commit owner');
        }
        let snapshotReads = 0;
        const target = {
            ...baseTarget,
            readSnapshot: () => {
                snapshotReads += 1;
                if (snapshotReads === 1) return baseTarget.readCurrent();
                commitBaseDocument({
                    expectedRevision: 1,
                    mutation: {
                        text: '',
                        references: [],
                        attachments: [exactPublishedAttachment],
                    },
                });
                throw new Error('snapshot read unavailable');
            },
            commitDocument: vi.fn((): ComposerTransactionResultV1 => {
                throw new Error('currentness loss should stop before commit');
            }),
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));
        let currentnessChecks = 0;

        await expect(applier.applyWithAttachmentCustody({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: stagedMedia.handle.executionTarget,
            isCurrent: () => {
                currentnessChecks += 1;
                return currentnessChecks === 1;
            },
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: stagedMedia,
                }],
            },
        })).resolves.toEqual({ status: 'composerUnavailable' });

        expect(claimComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle, {
            composer: { kind: 'session', sessionId: 'session-1' },
            attachmentInstanceId: 'host-created-issue-42',
        });
        expect(target.commitDocument).not.toHaveBeenCalled();
        expect(baseTarget.readCurrent().attachments).toMatchObject([{
            instanceId: 'host-created-issue-42',
            content: stagedMedia,
        }]);
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
    });

    it('releases a newly claimed stage when a different target publishes the same opaque handle id', async () => {
        const stagedMedia = createStagedMediaContent();
        const differentTargetStage: ComposerStagedMediaContentV1 = {
            ...stagedMedia,
            handle: {
                ...stagedMedia.handle,
                executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
            },
        };
        const baseTarget = createDocumentTarget(createSnapshot());
        let snapshotReads = 0;
        const target = {
            ...baseTarget,
            readSnapshot: () => {
                snapshotReads += 1;
                if (snapshotReads === 1) return baseTarget.readCurrent();
                return createSnapshot({
                    revision: 2,
                    attachments: [{
                        v: 1,
                        instanceId: 'host-created-issue-42',
                        attachment: { pluginId: 'acme.issues', localId: 'issue' },
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                        availability: { status: 'ready' },
                        content: differentTargetStage,
                    }],
                });
            },
            commitDocument: vi.fn((): ComposerTransactionResultV1 => {
                throw new Error('currentness loss should stop before commit');
            }),
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));
        let currentnessChecks = 0;

        await expect(applier.applyWithAttachmentCustody({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: stagedMedia.handle.executionTarget,
            isCurrent: () => {
                currentnessChecks += 1;
                return currentnessChecks === 1;
            },
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: stagedMedia,
                }],
            },
        })).resolves.toEqual({ status: 'composerUnavailable' });

        expect(releaseComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle, {
            claimant: {
                composer: { kind: 'session', sessionId: 'session-1' },
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
        expect(target.commitDocument).not.toHaveBeenCalled();
    });

    it('rejects an attachment value before allocating an instance id or mutating the document', () => {
        const createAttachmentInstanceId = vi.fn(() => 'must-not-be-allocated');
        const target = {
            ...createDocumentTarget(createSnapshot()),
            createAttachmentInstanceId,
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const valueValidator = vi.fn((value: unknown) => (
            typeof value === 'object'
            && value !== null
            && 'issueId' in value
            && typeof value.issueId === 'string'
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
            valueValidator,
        }));

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: 'valid',
                            value: { issueId: 'valid' },
                            presentation: { label: 'Valid issue' },
                        },
                    },
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    },
                ],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 1,
            reason: 'attachment_value_invalid',
        });
        expect(valueValidator).toHaveBeenNthCalledWith(1, { issueId: 'valid' });
        expect(valueValidator).toHaveBeenNthCalledWith(2, { issueId: 42 });
        expect(createAttachmentInstanceId).not.toHaveBeenCalled();
        expect(target.readCurrent()).toEqual(createSnapshot());
    });

    it('rejects an attachment update value through the same normalized declaration validator', () => {
        const initial = createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: '42' },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
            }],
        });
        const target = createDocumentTarget(initial);
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
            valueValidator: (value) => (
                typeof value === 'object'
                && value !== null
                && 'issueId' in value
                && typeof value.issueId === 'string'
            ),
        }));

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.update',
                    instanceId: 'issue-42',
                    update: { value: { issueId: 42 } },
                }],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 0,
            reason: 'attachment_value_invalid',
        });
        expect(target.readCurrent()).toEqual(initial);
    });

    it('retains staged custody when a contentless add upserts the same attachment key', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
                content: stagedMedia,
            }],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42, refreshed: true },
                        presentation: { label: 'Issue #42 (refreshed)' },
                    },
                }],
            },
        })).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-issue-42'],
        });

        expect(target.readCurrent().attachments).toMatchObject([{
            instanceId: 'host-created-issue-42',
            value: { issueId: 42, refreshed: true },
            content: stagedMedia,
        }]);
        await Promise.resolve();
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
    });

    it('releases removed staged media only after the canonical document transaction commits', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
                content: stagedMedia,
            }],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 1,
                operations: [{ kind: 'attachment.remove', instanceId: 'host-created-issue-42' }],
            },
        })).toEqual({ status: 'applied', revision: 2 });
        expect(target.readCurrent().attachments).toEqual([]);

        await Promise.resolve();
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle, {
            claimant: {
                composer: { kind: 'session', sessionId: 'session-1' },
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
    });

    it('releases only the replaced staged claim after an authoritative attachment upsert', async () => {
        const stagedMedia = createStagedMediaContent();
        const replacement: ComposerStagedMediaContentV1 = {
            kind: 'stagedMedia',
            handle: {
                ...stagedMedia.handle,
                id: 'stage-43',
                name: 'issue-43.png',
            },
        };
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
                content: stagedMedia,
            }],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        expect(await applier.applyWithAttachmentCustody({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: replacement.handle.executionTarget,
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 43 },
                        presentation: { label: 'Issue #43' },
                    },
                    content: replacement,
                }],
            },
        })).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-issue-42'],
        });

        expect(claimComposerContentSpy).toHaveBeenCalledWith(replacement.handle, {
            composer: { kind: 'session', sessionId: 'session-1' },
            attachmentInstanceId: 'host-created-issue-42',
        });
        await Promise.resolve();
        expect(target.readCurrent().attachments).toMatchObject([{ content: replacement }]);
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle, {
            claimant: {
                composer: { kind: 'session', sessionId: 'session-1' },
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
        expect(releaseComposerContentSpy).not.toHaveBeenCalledWith(replacement.handle);
    });

    it('does not release a staged claim when the document owner rejects the transaction', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = {
            ...createDocumentTarget(createSnapshot({
                attachments: [{
                    v: 1,
                    instanceId: 'host-created-issue-42',
                    attachment: { pluginId: 'acme.issues', localId: 'issue' },
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                    availability: { status: 'ready' },
                    content: stagedMedia,
                }],
            })),
            commitDocument: (): ComposerTransactionResultV1 => ({ status: 'conflict', currentRevision: 2 }),
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 1,
                operations: [{ kind: 'attachment.remove', instanceId: 'host-created-issue-42' }],
            },
        })).toEqual({ status: 'conflict', currentRevision: 2 });

        await Promise.resolve();
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
    });

    it('applies all host-authorized attachment additions atomically while rejecting a foreign or missing local id', () => {
        const issueEntry = createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        });
        const labelEntry = createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'label',
            typeLabel: 'Label',
        });
        let nextInstance = 0;
        const target = {
            ...createDocumentTarget(createSnapshot()),
            createAttachmentInstanceId: () => `host-created-${++nextInstance}`,
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(issueEntry, labelEntry);
        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    },
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'label',
                        value: {
                            key: 'urgent',
                            value: { label: 'urgent' },
                            presentation: { label: 'Urgent' },
                        },
                    },
                ],
            },
        })).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-1', 'host-created-2'],
        });
        expect(target.readCurrent().attachments).toMatchObject([
            { attachment: issueEntry.identity, key: '42' },
            { attachment: labelEntry.identity, key: 'urgent' },
        ]);

        const rejectedTarget = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-2' },
            rejectedTarget,
        ));
        const rejectedApplier = createAttachmentTransactionApplier(issueEntry);
        expect(rejectedApplier.apply({
            ref: { kind: 'session', sessionId: 'session-2' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    },
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'foreign-plugin-attachment',
                        value: {
                            key: 'foreign',
                            value: { foreign: true },
                            presentation: { label: 'Foreign' },
                        },
                    },
                ],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 1,
            reason: 'attachment_authority_mismatch',
        });
        expect(rejectedTarget.readCurrent()).toMatchObject({ revision: 1, attachments: [] });

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-2' },
            admittedContributor: admittedContributor({
                pluginId: 'acme.issues',
                occurrenceId: 'retired-generation',
            }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 0,
            reason: 'attachment_authority_mismatch',
        });
        expect(rejectedTarget.readCurrent()).toMatchObject({ revision: 1, attachments: [] });
    });

    it('rejects an attachment local-id forged outside the exact caller contribution without changing the document', () => {
        const target = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));
        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'review',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 0,
            reason: 'attachment_authority_mismatch',
        });
        expect(target.readCurrent()).toMatchObject({ revision: 1, attachments: [] });
    });

    it('resolves a media attachment owner only from the exact admitted attachment authority', () => {
        const applier = createAttachmentTransactionApplier(
            createAttachmentProjectionEntry({
                pluginId: 'acme.issues',
                localId: 'issue',
                typeLabel: 'Issue',
            }),
            createAttachmentProjectionEntry({
                pluginId: 'acme.issues',
                localId: 'review',
                typeLabel: 'Review',
            }),
        );

        expect(applier.resolveAttachmentIdentity({
            attachmentLocalId: 'issue',
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
        })).toEqual({ pluginId: 'acme.issues', localId: 'issue' });
        expect(applier.resolveAttachmentIdentity({
            attachmentLocalId: 'missing',
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
        })).toBeNull();
        expect(applier.resolveAttachmentIdentity({
            attachmentLocalId: 'issue',
            admittedContributor: admittedContributor({
                pluginId: 'acme.issues',
                occurrenceId: 'retired-generation',
            }),
        })).toBeNull();
    });

    it('treats a one-cardinality key change as remove-plus-add with fresh custody', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'unavailable' },
                content: stagedMedia,
            }, {
                v: 1,
                instanceId: 'host-created-note-1',
                attachment: { pluginId: 'acme.notes', localId: 'note' },
                key: 'note:1',
                value: { noteId: 1 },
                presentation: { label: 'Note #1', typeLabel: 'Note' },
                availability: { status: 'ready' },
            }],
        }), () => 'host-created-issue-77');
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
            cardinality: 'one',
        }));
        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '77',
                        value: { issueId: 77 },
                        presentation: { label: 'Issue #77' },
                    },
                }],
            },
        })).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-issue-77'],
        });
        expect(target.readCurrent().attachments).toEqual([{
            v: 1,
            instanceId: 'host-created-issue-77',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '77',
            value: { issueId: 77 },
            presentation: { label: 'Issue #77', typeLabel: 'Issue' },
            availability: { status: 'ready' },
        }, {
            v: 1,
            instanceId: 'host-created-note-1',
            attachment: { pluginId: 'acme.notes', localId: 'note' },
            key: 'note:1',
            value: { noteId: 1 },
            presentation: { label: 'Note #1', typeLabel: 'Note' },
            availability: { status: 'ready' },
        }]);
        await Promise.resolve();
        expect(releaseComposerContentSpy).toHaveBeenCalledOnce();
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle, {
            claimant: {
                composer: { kind: 'session', sessionId: 'session-1' },
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
    });

    it('keeps superseded cardinality-one custody when the remove-plus-add commit conflicts', async () => {
        const stagedMedia = createStagedMediaContent();
        const incumbent = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
                content: stagedMedia,
            }],
        }), () => 'host-created-issue-77');
        const target = {
            ...incumbent,
            commitDocument: (): ComposerTransactionResultV1 => ({ status: 'conflict', currentRevision: 2 }),
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
            cardinality: 'one',
        }));

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '77',
                        value: { issueId: 77 },
                        presentation: { label: 'Issue #77' },
                    },
                }],
            },
        })).toEqual({ status: 'conflict', currentRevision: 2 });

        await Promise.resolve();
        expect(incumbent.readCurrent().attachments).toMatchObject([{
            instanceId: 'host-created-issue-42',
            key: '42',
            content: stagedMedia,
        }]);
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
    });

    it('rejects a stale transaction before any operation is committed', () => {
        const target = createDocumentTarget(createSnapshot({ text: 'before', revision: 4 }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 3,
                operations: [{ kind: 'text.set', text: 'after' }],
            },
        })).toEqual({ status: 'conflict', currentRevision: 4 });
        expect(target.readCurrent()).toMatchObject({ revision: 4, text: 'before' });
    });

    it('observes only its exact composer scope and stops after disposal', () => {
        const sessionTarget = createDocumentTarget(createSnapshot());
        const pendingTarget = createDocumentTarget(createSnapshot({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionTarget,
        ));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            pendingTarget,
        ));
        const listener = vi.fn();
        const dispose = subscribeComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            listener,
        );

        applyComposerPresentationTransaction({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            transaction: { expectedRevision: 1, operations: [{ kind: 'text.set', text: 'pending' }] },
        });
        expect(listener).not.toHaveBeenCalled();

        applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: { expectedRevision: 1, operations: [{ kind: 'text.set', text: 'main' }] },
        });
        expect(listener).toHaveBeenCalledTimes(1);

        dispose();
        applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: { expectedRevision: 2, operations: [{ kind: 'text.set', text: 'later' }] },
        });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies only the exact live scope when an incumbent adapter changes outside a transaction', () => {
        const sessionTarget = createDocumentTarget(createSnapshot());
        const participantTarget = createDocumentTarget(createSnapshot({
            ref: { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-1' },
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionTarget,
        ));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-1' },
            participantTarget,
        ));
        const sessionListener = vi.fn();
        const participantListener = vi.fn();
        const disposeSession = subscribeComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionListener,
        );
        const disposeParticipant = subscribeComposerPresentationTarget(
            { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-1' },
            participantListener,
        );

        notifyComposerPresentationTargetChanged({
            kind: 'participantMessage',
            sessionId: 'session-1',
            instanceId: 'participant-1',
        });
        expect(sessionListener).not.toHaveBeenCalled();
        expect(participantListener).toHaveBeenCalledTimes(1);

        disposeSession();
        disposeParticipant();
    });
});

const persistentSessionScope: ServerAccountScope = {
    serverId: 'server-persistent',
    accountId: 'account-persistent',
};

function activatePersistentSessionDraft(sessionId: string, text: string): void {
    persistentValues.clear();
    resetSessionDraftValueCachesForTests();
    activeScopeState.value = persistentSessionScope;
    storage.getState().clearSessionLocalStateScope();
    storage.getState().activateSessionLocalStateScope(persistentSessionScope);
    writeExistingSessionDraft({ scope: persistentSessionScope, sessionId, patch: { text } });
    storage.setState((state) => ({
        ...state,
        deletedSessionIds: {},
        sessions: {
            ...state.sessions,
            [sessionId]: createSessionFixture({
                id: sessionId,
            }),
        },
    }));
}

function readPersistentSessionText(sessionId: string): string {
    return requireComposerDraftDocument(getSessionDraftSnapshot(persistentSessionScope, { kind: 'session', sessionId })?.document)?.composer.text.value ?? '';
}

function readPersistentSessionSnapshot(sessionId: string): ComposerSnapshotV1 {
    const snapshot = readComposerPresentationSnapshot({ kind: 'session', sessionId });
    if (!snapshot) throw new Error('Expected the current-account persistent Session fallback');
    return snapshot;
}

describe('persistent Session composer fallback', () => {
    afterEach(() => {
        activeScopeState.value = null;
        storage.getState().clearSessionLocalStateScope();
        persistentValues.clear();
        resetSessionDraftValueCachesForTests();
    });

    it('reads, observes, and atomically applies an exact unmounted Session draft', () => {
        const sessionId = 'session-persistent-1';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const initial = readPersistentSessionSnapshot(sessionId);
        const observed = vi.fn();
        const dispose = subscribeComposerPresentationTarget(ref, observed);
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        const result = applier.apply({
            ref,
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: initial.revision,
                operations: [
                    { kind: 'text.set', text: '@issue-42' },
                    {
                        kind: 'reference.insert',
                        reference: {
                            kind: 'acme.issue',
                            ref: 'issue:42',
                            token: '@issue-42',
                            label: 'Issue #42',
                            start: 0,
                            end: 9,
                        },
                    },
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    },
                ],
            },
        });

        expect(result).toMatchObject({
            status: 'applied',
            revision: initial.revision + 1,
            attachmentInstanceIds: [expect.any(String)],
        });
        expect(readPersistentSessionText(sessionId)).toBe('@issue-42');
        expect(readSessionDraftValue(
            persistentSessionScope,
            sessionId,
            'structuredInput.mentions',
        )).toEqual([{
            kind: 'acme.issue',
            ref: 'issue:42',
            tokenText: '@issue-42',
            start: 0,
            end: 9,
            label: 'Issue #42',
        }]);
        expect(readSessionDraftValue(
            persistentSessionScope,
            sessionId,
            'structuredInput.composerAttachments',
        )).toMatchObject([{
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
        }]);
        expect(observed).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('persists a replacement label when a transaction removes and reinserts the same reference identity', () => {
        const sessionId = 'session-persistent-reference-label';
        const ref = { kind: 'session', sessionId } as const;
        const token = formatInlineReferenceTokenV1({ label: 'Issue #42', ref: 'issue:42' });
        activatePersistentSessionDraft(sessionId, token);

        const initial = readPersistentSessionSnapshot(sessionId);
        expect(applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: initial.revision,
                operations: [{
                    kind: 'reference.insert',
                    reference: {
                        kind: 'acme.issue',
                        ref: 'issue:42',
                        token,
                        label: 'Issue #42',
                        start: 0,
                        end: token.length,
                    },
                }],
            },
        }).status).toBe('applied');

        const seeded = readPersistentSessionSnapshot(sessionId);
        expect(applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: seeded.revision,
                operations: [
                    {
                        kind: 'reference.remove',
                        reference: { ref: 'issue:42', start: 0, end: token.length },
                    },
                    {
                        kind: 'reference.insert',
                        reference: {
                            kind: 'acme.issue',
                            ref: 'issue:42',
                            token,
                            label: 'Renamed issue',
                            start: 0,
                            end: token.length,
                        },
                    },
                ],
            },
        }).status).toBe('applied');

        expect(readSessionDraftValue(
            persistentSessionScope,
            sessionId,
            'structuredInput.mentions',
        )).toEqual([{
            kind: 'acme.issue',
            ref: 'issue:42',
            tokenText: token,
            start: 0,
            end: token.length,
            label: 'Renamed issue',
        }]);
        expect(readPersistentSessionSnapshot(sessionId).references).toEqual([
            expect.objectContaining({ ref: 'issue:42', label: 'Renamed issue' }),
        ]);
    });

    it('keeps the one Session revision continuous across mounted and unmounted access', () => {
        const sessionId = 'session-persistent-2';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        writeExistingSessionDraft({ scope: persistentSessionScope, sessionId, patch: { text: 'after' } });
        const persisted = readPersistentSessionSnapshot(sessionId);
        const unregister = registerComposerPresentationTarget(ref, createDocumentTarget({
            ...persisted,
            text: 'mounted text',
        }));

        expect(readComposerPresentationSnapshot(ref)?.revision).toBe(persisted.revision);
        unregister();

        expect(readPersistentSessionSnapshot(sessionId)).toMatchObject({
            revision: persisted.revision,
            text: 'after',
        });
    });

    it('notifies exact fallback observers for external persisted text writes and rejects their stale revision', () => {
        const sessionId = 'session-persistent-3';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const initial = readPersistentSessionSnapshot(sessionId);
        const observed = vi.fn();
        const dispose = subscribeComposerPresentationTarget(ref, observed);
        writeExistingSessionDraft({ scope: persistentSessionScope, sessionId, patch: { text: 'outside' } });

        const current = readPersistentSessionSnapshot(sessionId);
        expect(current).toMatchObject({
            revision: initial.revision + 1,
            text: 'outside',
        });
        expect(observed).toHaveBeenCalledTimes(1);
        expect(applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: initial.revision,
                operations: [{ kind: 'text.set', text: 'stale' }],
            },
        })).toEqual({ status: 'conflict', currentRevision: current.revision });
        dispose();
    });

    it('does not carry a fallback draft across Account replacement and retires it on known Session deletion', () => {
        const sessionId = 'session-persistent-4';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const observed = vi.fn();
        const dispose = subscribeComposerPresentationTarget(ref, observed);
        const replacementScope: ServerAccountScope = {
            serverId: 'server-persistent',
            accountId: 'account-replacement',
        };
        activeScopeState.value = replacementScope;
        storage.setState((state) => ({
            ...state,
            sessionLocalStateScope: replacementScope,
        }));

        // A fresh exact read follows the newly active Account, but never leaks
        // the former Account's persisted draft through the same Session id.
        expect(readComposerPresentationSnapshot(ref)).toMatchObject({
            revision: 0,
            text: '',
        });
        expect(observed).toHaveBeenCalledTimes(1);

        activeScopeState.value = persistentSessionScope;
        storage.getState().activateSessionLocalStateScope(persistentSessionScope);
        expect(readPersistentSessionSnapshot(sessionId)).toMatchObject({ text: 'before' });
        expect(observed).toHaveBeenCalledTimes(2);
        storage.setState((state) => ({
            ...state,
            deletedSessionIds: { ...state.deletedSessionIds, [sessionId]: true },
        }));

        expect(readComposerPresentationSnapshot(ref)).toBeNull();
        expect(observed).toHaveBeenCalledTimes(3);
        dispose();
    });

    it('keeps a pending-message registration separate from the persistent Session fallback', () => {
        const sessionId = 'session-persistent-5';
        const sessionRef = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const unregister = registerComposerPresentationTarget(
            { kind: 'pendingMessage', sessionId, localId: 'pending-1' },
            createDocumentTarget(createSnapshot({
                ref: { kind: 'pendingMessage', sessionId, localId: 'pending-1' },
                text: 'pending',
            })),
        );
        try {
            expect(readComposerPresentationSnapshot(sessionRef)).toMatchObject({ text: 'before' });
            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId,
                localId: 'pending-1',
            })).toMatchObject({ text: 'pending' });
        } finally {
            unregister();
        }
    });

    it('does not let a daemon replacement fall back to persistent Session text when only a pending editor is registered', () => {
        const sessionId = 'session-persistent-daemon-visual-scope';
        const sessionRef = { kind: 'session', sessionId } as const;
        const pendingRef = { kind: 'pendingMessage', sessionId, localId: 'pending-1' } as const;
        activatePersistentSessionDraft(sessionId, 'persistent before');
        const persistent = readPersistentSessionSnapshot(sessionId);
        const pendingTarget = createDocumentTarget(createSnapshot({
            ref: pendingRef,
            text: 'pending before',
            revision: persistent.revision,
        }));
        const unregister = registerComposerPresentationTarget(pendingRef, pendingTarget);
        const genericApply = vi.fn((transaction: ComposerTransactionV1) => applyComposerPresentationTransaction({
            ref: sessionRef,
            transaction,
        }));
        const visualSessionTarget = readSessionComposerPresentationTargetAtAddress({
            serverId: persistentSessionScope.serverId,
            sessionId,
        });
        try {
            expect(visualSessionTarget).toBeNull();
            const application = applyCurrentSessionPresentationCommand({
                hostNonce: 'host-1',
                clientId: 'client-1',
                isCurrentSession: true,
                state: {
                    v: 1,
                    hostNonce: 'host-1',
                    revision: 1,
                    statuses: [],
                    widgets: [],
                    command: {
                        id: 'command-1',
                        clientId: 'client-1',
                        kind: 'composer.replace',
                        transaction: {
                            expectedRevision: persistent.revision,
                            operations: [{ kind: 'text.set', text: 'daemon replacement' }],
                        },
                    },
                },
                notify: vi.fn(),
                // The daemon bridge receives only a mounted Session target. The
                // generic callback models exact offscreen `get(sessionRef)`,
                // which must remain unavailable to this command path.
                composer: visualSessionTarget && {
                    revision: visualSessionTarget.revision,
                    apply: genericApply,
                },
            });

            expect(application).toEqual({
                ack: {
                    hostNonce: 'host-1',
                    clientId: 'client-1',
                    commandId: 'command-1',
                    result: { status: 'composerUnavailable' },
                },
            });
            expect(genericApply).not.toHaveBeenCalled();
            expect(readPersistentSessionText(sessionId)).toBe('persistent before');
            expect(pendingTarget.readCurrent()).toMatchObject({
                revision: persistent.revision,
                text: 'pending before',
            });
        } finally {
            unregister();
        }
    });

});
