import { buildNewSessionAuthoringDraftFromPersistedDraft, buildNewSessionAuthoringDraftFromTempData, buildNewSessionTempDataFromAuthoringDraft, buildPersistedNewSessionDraftFromAuthoringDraft, buildSessionSpawnNewInputV2FromAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { StoredPluginUiNewSessionSeedOriginV1Schema } from '@happier-dev/protocol/plugins/ui';
import { seedNewSessionDraftV1 } from '@/components/sessions/new/newSessionDraftSeed';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionDraftLocalState } from '@/sync/ops/sessionDrafts/newSessionDraftLocalState';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

import { canonicalSessionDraftAddressV2, type SessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SessionInitialTriggerV1Schema} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { type ComposerAttachmentDraftV1} from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { array } from 'zod/mini';
import { NewSessionDraftDocumentV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { sessionDraftRowKey } from '@/sync/ops/sessionDrafts/sessionDraftSerializedScope';
import { requireComposerDraftDocument } from '@/dev/testkit';
import type {
    NewSessionComposerAttachmentSeedV1,
    NewSessionDraft,
} from '@/sync/domains/state/persistence';
import {
    getSessionDraftSnapshot,
    flushSessionDraft,
    resetSessionDraftRepositoryForTests,
    writeNewSessionDraft,
    writeSessionDraftLocalSupplement,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
    readNewSessionDraftFromRepository,
    readNewSessionDraftProjectionFromRepository,
    clearNewSessionComposerAttachmentSeedsFromRepository,
    hasNewSessionDraftAccessConflict,
    hasNewSessionDraftPrimaryTeamConflict,
    writeTemporaryComputerActivationRefToRepository,
    writeNewSessionAuthoringDraftToRepository,
    writeNewSessionNameToRepository,
    writeNewSessionInstructionsToRepository,
    writeNewSessionDraftToRepository,
    writeNewSessionBotFaceToRepository,
} from './newSessionDraftRepositoryAdapter';
import { NEW_BOT_SEED, withNewBotDraftFaceSeed } from '@/components/sessions/bots/newBotDraft';
import { buildNewSessionConfigurationDraft, buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const attachment: ComposerAttachmentDraftV1 = {
    v: 1,
    instanceId: 'attachment-a',
    attachment: { pluginId: 'example.plugin', localId: 'ticket' },
    key: 'ticket-a',
    value: { id: 42 },
    presentation: { typeLabel: 'Ticket', label: 'Issue 42' },
};

function authoringDraft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
    return {
        input: 'stale delayed text',
        composerAttachments: [],
        selectedMachineId: 'machine-b',
        selectedPath: '/repo',
        entryIntent: 'session',
        selectedProfileId: null,
        selectedSecretId: null,
        agentType: 'codex',
        permissionMode: 'default',
        acpSessionModeId: null,
        updatedAt: 10,
        ...overrides,
    };
}

afterEach(() => {
    resetSessionDraftRepositoryForTests();
});

/**
 * Temporary-computer authoring lives only in the current catalogued document,
 * so these assertions read it through that exact document version rather than
 * the released V1 vocabulary the same union also carries.
 */
function cataloguedNewSessionAuthoring(
    snapshot: ReturnType<typeof getSessionDraftSnapshot>,
) {
    const document = snapshot?.document;
    if (document?.v !== 2 || document.target.kind !== 'newSession') return undefined;
    return document.target.authoring;
}

describe('newSessionDraftRepositoryAdapter', () => {
    it.each(['custom:removed', null, undefined])('retains the source approval profile through durable same-setup custody and Session birth (%s)', async (approvalProfileId) => {
        const draftId = approvalProfileId === undefined ? '00000000-0000-4000-8000-000000001032'
            : approvalProfileId === null ? '00000000-0000-4000-8000-000000001031'
                : '00000000-0000-4000-8000-000000001030';
        const seed = buildNewSessionTempDataFromSessionConfiguration({
            session: { id: 'source-session', encryptionMode: 'plain', metadata: {
                path: '/workspace/source', host: 'dev-host', flavor: 'codex',
                ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
            } },
            machineId: 'machine-source',
        });
        expect(seedAndOpenNewSession({
            scope, createDraftId: () => draftId, isCurrent: () => true, navigateToNewSession: () => {},
            seed: { placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'machine-source', directory: seed.directory } },
            configurationDraft: buildNewSessionConfigurationDraft(seed),
        }).kind).toBe('opened');
        // Unauthored opener context is intentionally process-local. The real
        // Composer's first text edit makes the copied setup a durable draft.
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Review this workspace' }, materializationIntent: 'userEdit' });
        await flushSessionDraft({ scope, address: { kind: 'newSession', draftId } });
        resetSessionDraftRepositoryForTests();
        const retained = readNewSessionDraftFromRepository({ scope, draftId });
        if (!retained) throw new Error('Expected retained same-setup draft');
        const spawn = buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(retained),
            creationKey: 'manual:same-setup-profile', permissionMode: 'default', configurationUpdatedAtMs: 10,
        });
        expect(retained.approvalProfileId).toBe(approvalProfileId);
        if (approvalProfileId === undefined) expect(spawn).not.toHaveProperty('approvalProfileId');
        else expect(spawn).toHaveProperty('approvalProfileId', approvalProfileId);
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...retained, approvalProfileId: undefined } });
        await flushSessionDraft({ scope, address: { kind: 'newSession', draftId } });
        resetSessionDraftRepositoryForTests();
        const cleared = readNewSessionDraftFromRepository({ scope, draftId });
        expect(cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }))).not.toHaveProperty('approvalProfileId');
        if (!cleared) throw new Error('Expected retained draft after clearing the profile');
        const clearedSpawn = buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(cleared),
            creationKey: 'manual:same-setup-profile-reset', permissionMode: 'default', configurationUpdatedAtMs: 10,
        });
        expect(clearedSpawn).not.toHaveProperty('approvalProfileId');
    });
    it('carries a New Bot draft face into Session birth: the previewed seed, then reset to the draft seed', () => {
        const requests = vi.spyOn(globalThis, 'fetch');
        onTestFinished(() => { requests.mockRestore(); });
        const draftId = '00000000-0000-4000-8000-00000000f4ce';
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({
            initialSessionFacts: NEW_BOT_SEED.initialSessionFacts,
            executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } },
        }) });
        // Before any choice the draft draws (and is born with) its own seed, so the preview never jumps at birth.
        const seeded = readNewSessionDraftFromRepository({ scope, draftId });
        expect(withNewBotDraftFaceSeed(seeded?.initialSessionFacts, draftId)?.botFace).toEqual({ seed: draftId });
        expect(withNewBotDraftFaceSeed({ createdAsBot: true }, draftId)).toEqual({ createdAsBot: true });

        writeNewSessionBotFaceToRepository({ scope, draftId, botFace: { style: 'pixel', body: 'crab', seed: 'another-face-seed' } });
        resetSessionDraftRepositoryForTests();
        const chosen = readNewSessionDraftFromRepository({ scope, draftId });
        expect(chosen?.initialSessionFacts).toEqual({ ...NEW_BOT_SEED.initialSessionFacts, botFace: { style: 'pixel', body: 'crab', seed: 'another-face-seed' } });
        if (!chosen) throw new Error('Missing New Bot draft');
        const spawn = buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: { ...buildNewSessionAuthoringDraftFromPersistedDraft(chosen),
                initialSessionFacts: withNewBotDraftFaceSeed(chosen.initialSessionFacts, draftId) },
            creationKey: 'manual:new-bot-face', permissionMode: 'default', configurationUpdatedAtMs: 10,
        });
        expect(spawn.identity?.botFace).toEqual({ style: 'pixel', body: 'crab', seed: 'another-face-seed' });

        writeNewSessionBotFaceToRepository({ scope, draftId, botFace: null });
        const reset = readNewSessionDraftFromRepository({ scope, draftId });
        expect(reset?.initialSessionFacts).toEqual(NEW_BOT_SEED.initialSessionFacts);
        expect(withNewBotDraftFaceSeed(reset?.initialSessionFacts, draftId)?.botFace).toEqual({ seed: draftId });
        expect(requests).not.toHaveBeenCalled();
        console.info('LIVING_BOTS_DRAFT', JSON.stringify({ previewAndEdits: 3, requests: requests.mock.calls.length }));
    });

    it.each(['prompt', 'ask', 'bot'] as const)('keeps a fresh %s seed unselected through repository projection', (kind) => {
        const draftId = '00000000-0000-4000-8000-000000000957';
        seedNewSessionDraftV1({
            scope,
            createDraftId: () => draftId,
            seed: kind === 'prompt'
                ? { prompt: { text: 'Review this selection', mode: 'replace' } }
                : { sessionName: kind === 'ask' ? 'Happier' : 'Release helper', initialSessionFacts: { createdAsBot: true } },
        });
        expect(cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }))?.agentTarget?.value).toBeNull();
        const projected = readNewSessionDraftFromRepository({ scope, draftId });
        expect(projected?.agentTarget).toBeNull();
        expect(projected?.backendTarget).toBeUndefined();
        // A subsequent authoring write must not promote the display fallback.
        if (!projected) throw new Error('Missing seeded draft');
        const authoring = buildNewSessionAuthoringDraftFromPersistedDraft(projected);
        expect(authoring.agentTarget).toBeNull();
        const temp = buildNewSessionTempDataFromAuthoringDraft({ draft: authoring, machineId: null });
        expect(buildNewSessionAuthoringDraftFromTempData(temp).agentTarget).toBeNull();
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: authoring, machineId: null, selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null, updatedAt: projected.updatedAt,
        });
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persisted).agentTarget).toBeNull();
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: projected });
        expect(cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }))?.agentTarget?.value).toBeNull();
    });
    it('reopens Project files from synchronized authoring with the selected placement', async () => {
        const draftId = '00000000-0000-4000-8000-000000001136';
        const address = { kind: 'newSession' as const, draftId };
        const sessionPlacement = { kind: 'machine' as const, target: { serverId: 'server-a', machineId: 'machine-b' },
            projectFiles: { kind: 'copy_once' as const } };
        writeNewSessionDraftToRepository({ scope, draftId, draft: { ...authoringDraft(), sessionPlacement } });
        await flushSessionDraft({ scope, address });
        resetSessionDraftRepositoryForTests();
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        expect(reopened).toMatchObject({ sessionPlacement });
        expect(NewSessionDraftDocumentV2Schema.parse(getSessionDraftSnapshot(scope, address)!.document).target.authoring)
            .toMatchObject({ sessionPlacement: { value: sessionPlacement } });
    });
    it('keeps one-Session Directly intent device-local when reopening the authoring draft', async () => {
        const draftId = '00000000-0000-4000-8000-000000001125';
        const address = { kind: 'newSession' as const, draftId };
        writeNewSessionDraftToRepository({ scope, draftId,
            draft: { ...authoringDraft({ input: 'Run one Session directly' }), ...{ isolationOverride: 'directly' as const } } });
        await flushSessionDraft({ scope, address });
        resetSessionDraftRepositoryForTests();
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        expect(reopened).toMatchObject({ isolationOverride: 'directly' });
        if (!reopened) throw new Error('Expected retained Directly draft');
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened), creationKey: 'reopened-directly',
            permissionMode: 'default', configurationUpdatedAtMs: 1,
        })).toMatchObject({ isolationOverride: 'directly' });
        expect(NewSessionDraftDocumentV2Schema.parse(getSessionDraftSnapshot(scope, address)!.document).target.authoring)
            .not.toHaveProperty('isolationOverride');
        writeSessionDraftLocalSupplement({ scope, address, patch: { newSessionLocalState: null } });
        await flushSessionDraft({ scope, address });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toHaveProperty('isolationOverride');
        const nextDraftId = '00000000-0000-4000-8000-000000001126';
        writeNewSessionDraftToRepository({ scope, draftId: nextDraftId, draft: authoringDraft() });
        expect(readNewSessionDraftFromRepository({ scope, draftId: nextDraftId })).not.toHaveProperty('isolationOverride');
    });
    it('keeps an explicitly configured Agent on a seeded draft', () => {
        const draftId = '00000000-0000-4000-8000-000000000958';
        seedNewSessionDraftV1({ scope, createDraftId: () => draftId,
            seed: { sessionName: 'Happier' }, configurationDraft: authoringDraft({ agentType: 'claude' }),
        });
        expect(cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }))?.agentTarget?.value).toMatchObject({
            kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        });
    });
    it('keeps missing-draft configuration passive and still creates and edits readable authored drafts', () => {
        const draftId = '00000000-0000-4000-8000-000000000956';
        const address = { kind: 'newSession' as const, draftId };
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: authoringDraft() });
        expect(getSessionDraftSnapshot(scope, address)).toBeNull();
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Authored content' }) });
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: authoringDraft({ selectedPath: '/edited' }) });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ input: 'Authored content', selectedPath: '/edited' });
    });
    it.each(['invalid composer', 'unsupported version'])('does not autosave fallback authoring over retained unreadable custody (%s)', (malformation) => {
        const draftId = '00000000-0000-4000-8000-000000000955';
        const address = { kind: 'newSession' as const, draftId };
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Retained intent', selectedPath: '/retained' }), materializationIntent: 'seeded' });
        const document = getSessionDraftSnapshot(scope, address)?.document;
        if (!document) throw new Error('Expected a genuine retained draft');
        const storage = getSessionDraftPersistenceStorage();
        const key = sessionDraftRowKey(serverAccountScopedStorageKey('session-drafts-repository-v1', scope), canonicalSessionDraftAddressV2(address));
        const replica: unknown = JSON.parse(storage.getString(key)!);
        if (!replica || typeof replica !== 'object' || Array.isArray(replica)) throw new Error('Expected retained replica');
        const retainedDocument = malformation === 'invalid composer' ? { ...document, composer: null } : { ...document, v: 99 };
        const retainedRaw = JSON.stringify({ ...replica, localRawDocument: retainedDocument });
        storage.set(key, retainedRaw);
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftProjectionFromRepository({ scope, draftId })).toBeNull();

        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: authoringDraft({ input: '', selectedPath: '/resolved-default' }), preserveLiveSessionName: true });

        expect(getSessionDraftSnapshot(scope, address)?.document).toEqual(retainedDocument);
        expect(storage.getString(key)).toBe(retainedRaw);
    });
    it('validates each repository snapshot once and refreshes document, local and Account changes', () => {
        const draftId = 'snapshot-validation';
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'First' }), materializationIntent: 'seeded' });
        const parses = vi.spyOn(StoredPluginUiNewSessionSeedOriginV1Schema, 'safeParse');
        try {
            const first = readNewSessionDraftProjectionFromRepository({ scope, draftId });
            expect(first?.draft.input).toBe('First');
            expect(parses).toHaveBeenCalledTimes(1);
            const repeated = Array.from({ length: 5 }, () => readNewSessionDraftProjectionFromRepository({ scope, draftId }));
            expect(parses).toHaveBeenCalledTimes(1);
            for (const projection of repeated) expect(projection).toBe(first);
            writeNewSessionDraft({ scope, draftId, patch: { text: 'Updated' }, materializationIntent: 'userEdit' });
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('Updated');
            writeSessionDraftLocalSupplement({ scope, address: { kind: 'newSession', draftId },
                patch: { launchUserAttemptId: 'new-attempt' } });
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.launchUserAttemptId).toBe('new-attempt');
            const otherScope = { ...scope, accountId: 'account-other' };
            writeNewSessionDraftToRepository({ scope: otherScope, draftId, draft: authoringDraft({ input: 'Other Account' }), materializationIntent: 'seeded' });
            expect(readNewSessionDraftFromRepository({ scope: otherScope, draftId })?.input).toBe('Other Account');
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('Updated');
        } finally { parses.mockRestore(); }
    });

    it('reopens editor-authored credentials, folder, profile and model through the real authoring adapter', async () => {
        const draftId = '00000000-0000-4000-8000-000000001001';
        const targetKey = 'agent:happier.agent.claude/claude';
        const connectedServices = { v: 2 as const, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
        } };
        const retainedConnectedServices = { v: 2 as const, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'connected' as const, profileId: 'work' },
        } };
        const draft = authoringDraft({ agentType: 'claude',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            selectedPath: '/repo/authored', selectedProfileId: 'launch-profile',
            modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId: 'haiku' } },
            backendNewSessionOptionStateByTargetKey: { [targetKey]: {
                connectedServicesBindingsByServiceId: connectedServices.bindingsByServiceId,
            } },
        });
        writeNewSessionDraftToRepository({ scope, draftId, draft });
        await flushSessionDraft({ scope, address: { kind: 'newSession', draftId } });
        resetSessionDraftRepositoryForTests();
        const retained = readNewSessionDraftFromRepository({ scope, draftId });
        if (!retained) throw new Error('Expected retained authoring');
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(retained)).toMatchObject({
            connectedServices: retainedConnectedServices, directory: draft.selectedPath,
            profileId: draft.selectedProfileId, modelSelection: draft.modelSelection,
        });
        // A configuration handoff consumes the same recovered authoring, rather
        // than silently producing a native credential seed.
        const seed = buildNewSessionTempDataFromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(retained), machineId: draft.selectedMachineId ?? null,
        });
        expect(buildNewSessionAuthoringDraftFromTempData(seed).connectedServices).toEqual(retainedConnectedServices);
    });
    it('restores retained authoring fields and attachments with unknown nested metadata', () => {
        const draftId = '00000000-0000-4000-8000-000000001002';
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({
            executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } },
            composerAttachments: [attachment],
        }) });
        const storage = getSessionDraftPersistenceStorage();
        const key = sessionDraftRowKey(serverAccountScopedStorageKey('session-drafts-repository-v1', scope), canonicalSessionDraftAddressV2({ kind: 'newSession', draftId }));
        const persisted = JSON.parse(storage.getString(key)!) as { localRawDocument: SessionDraftDocumentV2 };
        const document = requireComposerDraftDocument(persisted.localRawDocument);
        if (document.target.kind !== 'newSession') throw new Error('Expected retained draft');
        const fields = document.target.authoring;
        const execution = Reflect.get(fields, 'executionTarget') as { value: Record<string, unknown> };
        execution.value.retired = true;
        const retainedAttachment = document.composer.attachments.value[0];
        if (!retainedAttachment || typeof retainedAttachment !== 'object' || Array.isArray(retainedAttachment)) {
            throw new Error('Expected retained attachment');
        }
        Reflect.set(retainedAttachment, 'retired', true);
        // An invalid optional sibling keeps raw custody; the adapter must still salvage the valid selections.
        const directory = Reflect.get(fields, 'directory');
        if (!directory) throw new Error('Expected retained directory field');
        Reflect.set(directory, 'value', '');
        storage.set(key, JSON.stringify(persisted));
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } },
            composerAttachments: [attachment],
        });
    });
    it('persists flushes and reopens two distinct definitions of the same Custom ACP Agent', async () => {
        const definitions = [
            { definitionId: 'review-a', draftId: '00000000-0000-4000-8000-000000001003' },
            { definitionId: 'review-b', draftId: '00000000-0000-4000-8000-000000001004' },
        ];
        for (const { definitionId, draftId } of definitions) {
            const target = { kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId };
            writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ agentTarget: target,
                backendTarget: { kind: 'backend', backendId: definitionId, configuredBackendId: definitionId },
                executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } } }) });
            await flushSessionDraft({ scope, address: { kind: 'newSession', draftId } });
        }
        resetSessionDraftRepositoryForTests();
        for (const { definitionId, draftId } of definitions) {
            const reopened = readNewSessionDraftFromRepository({ scope, draftId });
            expect(reopened?.agentTarget).toEqual({ kind: 'agent',
                identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId });
            if (!reopened) throw new Error('Expected retained configured choice');
            const spawn = buildSessionSpawnNewInputV2FromAuthoringDraft({
                draft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened),
                creationKey: `manual:configured-${definitionId}`, permissionMode: 'default', configurationUpdatedAtMs: 10,
            });
            expect(spawn.agentTarget).toEqual(reopened.agentTarget);
        }
    });
    it('materializes the ordinary local draft on the first Instructions edit without an Artifact', () => {
        const draftId = '00000000-0000-4000-8000-000000001005';
        const instructionsDraft = { title: 'Remit', markdown: 'Keep the remit.' };
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toBeNull();
        writeNewSessionInstructionsToRepository({ scope, draftId, instructionsDraft });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ instructionsDraft });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toHaveProperty('promptStack');
    });

    it.each(['name', 'instructions'] as const)('keeps canonical local defaults and existing fields through a %s edit', (edit) => {
        const draftId = edit === 'name' ? '00000000-0000-4000-8000-000000001006' : '00000000-0000-4000-8000-000000001007';
        const address = { kind: 'newSession' as const, draftId };
        const instructionsDraft = { title: 'Current remit', markdown: 'Keep the current remit.' };
        const editDraft = () => edit === 'name'
            ? writeNewSessionNameToRepository({ scope, draftId, sessionName: 'Edited title' })
            : writeNewSessionInstructionsToRepository({ scope, draftId, instructionsDraft });
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'seeded', patch: { text: 'Keep the current prompt' } });
        expect(getSessionDraftSnapshot(scope, address)?.localSupplement.newSessionLocalState).toBeUndefined();

        editDraft();
        expect(getSessionDraftSnapshot(scope, address)?.localSupplement.newSessionLocalState).toMatchObject({
            entryIntent: 'session', selectedSecretId: null,
            ...(edit === 'instructions' ? { instructionsDraft } : {}),
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject(
            edit === 'name' ? { sessionName: 'Edited title' } : { instructionsDraft },
        );

        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({
            input: 'Keep the current prompt', sessionName: 'Retained title', instructionsDraft,
            selectedSecretId: 'retained-secret', memoryEnabled: false,
        }), materializationIntent: 'seeded' });
        editDraft();
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            input: 'Keep the current prompt', selectedSecretId: 'retained-secret', memoryEnabled: false,
            sessionName: edit === 'name' ? 'Edited title' : 'Retained title', instructionsDraft,
        });
    });

    it('reopens lazy Instructions authoring and carries selected qualified Session context into the ordinary spawn recipe', () => {
        const promptStack = [{ id: 'session.instructions',
            ref: { kind: 'doc', serverId: 'instructions-home', artifactId: 'instructions-doc' },
            enabled: true, required: true, placement: 'system_append' }] as const;
        const instructionsDraft = { title: 'Build caretaker', markdown: '' };
        const draftId = '00000000-0000-4000-8000-000000001008';
        const draft = { ...authoringDraft({ input: '', sessionName: 'Build caretaker',
            initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        }), instructionsDraft };
        writeNewSessionDraftToRepository({ scope, draftId, draft, materializationIntent: 'seeded' });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ instructionsDraft });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toHaveProperty('promptStack');
        writeNewSessionDraftToRepository({ scope, draftId, draft: { ...draft, instructionsDraft: null, promptStack }, materializationIntent: 'seeded' });
        resetSessionDraftRepositoryForTests();
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        expect(reopened).toMatchObject({ promptStack, instructionsDraft: null });
        if (!reopened) throw new Error('Expected ordinary Instructions authoring custody');
        const spawn = buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened),
            creationKey: 'manual:instructions-authoring', permissionMode: 'default', configurationUpdatedAtMs: 10,
        });
        expect(spawn).toMatchObject({ title: 'Build caretaker', promptStack });
        expect(spawn).not.toHaveProperty('initialInput');
        expect(spawn).not.toHaveProperty('instructionsDraft');
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(authoringDraft({ input: '',
                executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            })),
            creationKey: 'manual:untouched-bot', permissionMode: 'default', configurationUpdatedAtMs: 10,
        })).not.toHaveProperty('promptStack');
    });
    it('recovers the exact managed Home, profile routing id and reviewed receipt locally through reload and authoring edits', () => {
        const draftId = '00000000-0000-4000-8000-000000001009';
        const receipt = {
            launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
                name: 'Reviewed guest', choices: { cores: 2 } },
            controller: { machineId: 'controller-a', installationId: 'installation-a' },
            optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' },
            prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            preset: { id: 'preset-a', revision: 7, name: 'Reviewed preset' },
        } satisfies ManagedConfigurationFactsV1;
        const managedMachineSelection = {
            selection: { kind: 'preset' as const, homeId: 'home-b', id: 'preset-a', revision: 7 },
            receipt, archiveEffect: 'delete' as const,
        };
        const managedMachineAcquisition = {
            requestId: 'reviewed-request', selection: managedMachineSelection.selection, managedId: 'paid-resource',
            operation: { operationId: 'install-operation', waitForTerminal: true as const },
        };
        const draft = { ...authoringDraft({ input: 'Live reviewed request', selectedMachineId: null,
            executionTarget: null, targetServerId: 'profile-b' }), managedMachineSelection, managedMachineAcquisition };
        writeNewSessionDraftToRepository({ scope, draftId, draft });
        const storedLocalState = { ...buildNewSessionDraftLocalState(draft), managedMachineSelection: {
                ...managedMachineSelection,
                selection: { ...managedMachineSelection.selection, future: true },
                receipt: { ...receipt, billing: { ...receipt.billing, future: true } },
            } };
        writeSessionDraftLocalSupplement({ scope, address: { kind: 'newSession', draftId }, patch: {
            newSessionLocalState: storedLocalState,
        } });
        resetSessionDraftRepositoryForTests();

        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({ input: 'Live reviewed request', targetServerId: 'profile-b',
            executionTarget: null, selectedMachineId: null, managedMachineSelection, managedMachineAcquisition });
        if (!recovered) throw new Error('Expected the retained managed draft');
        expect(recovered.managedMachineSelection).toEqual(managedMachineSelection);
        const roundtripped = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(recovered), machineId: null,
            targetServerId: recovered.targetServerId, managedMachineSelection: recovered.managedMachineSelection,
            managedMachineAcquisition: recovered.managedMachineAcquisition,
            selectedSecretId: recovered.selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName: recovered.selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: recovered.sessionOnlySecretValueEncByProfileIdByEnvVarName,
            backendNewSessionOptionStateByTargetKey: recovered.backendNewSessionOptionStateByTargetKey,
            updatedAt: 42,
        });
        expect(roundtripped).toMatchObject({ targetServerId: 'profile-b', managedMachineSelection, managedMachineAcquisition });
        writeNewSessionAuthoringDraftToRepository({ scope, draftId,
            draft: { ...roundtripped, input: 'Stale autosave', selectedPath: '/edited' } });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            input: 'Live reviewed request', selectedPath: '/edited', targetServerId: 'profile-b', managedMachineSelection, managedMachineAcquisition,
        });
        expect(JSON.stringify(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document))
            .not.toContain('managedMachineSelection');
        expect(JSON.stringify(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document))
            .not.toContain('managedMachineAcquisition');
        expect(readNewSessionDraftFromRepository({ scope: { ...scope, accountId: 'other' }, draftId })).toBeNull();

        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...roundtripped,
            selectedMachineId: 'enrolled-machine',
            executionTarget: { kind: 'machine', target: { serverId: 'home-b', machineId: 'enrolled-machine' } },
        } });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            selectedMachineId: 'enrolled-machine', managedMachineSelection, managedMachineAcquisition,
        });

        writeNewSessionAuthoringDraftToRepository({ scope, draftId,
            draft: { ...recovered, managedMachineSelection: null, managedMachineAcquisition: null } });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            input: 'Live reviewed request', managedMachineSelection: null, managedMachineAcquisition: null,
        });
    });

    it('migrates retained local Bot authoring on edit and never resurrects it over canonical clears', () => {
        const draftId = 'local-bot-upgrade';
        const address = { kind: 'newSession' as const, draftId };
        const legacy = { ...buildNewSessionDraftLocalState(authoringDraft()), sessionName: 'Retained caretaker',
            initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true } as const,
            promptStack: [] as const, memoryEnabled: false };
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'seeded', patch: { text: 'Keep this work' } });
        writeSessionDraftLocalSupplement({ scope, address, patch: { newSessionLocalState: legacy } });
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({ sessionName: legacy.sessionName, initialSessionFacts: legacy.initialSessionFacts });
        if (!recovered) throw new Error('Expected retained local authoring');
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: recovered });
        const supplement = getSessionDraftSnapshot(scope, address)?.localSupplement.newSessionLocalState;
        for (const field of ['sessionName', 'initialSessionFacts', 'promptStack', 'memoryEnabled']) {
            expect(supplement).not.toHaveProperty(field);
        }
        writeSessionDraftLocalSupplement({ scope, address, patch: { newSessionLocalState: null } });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            sessionName: legacy.sessionName, initialSessionFacts: legacy.initialSessionFacts, memoryEnabled: false, promptStack: [],
        });
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'seeded', patch: { authoring: {
            sessionName: null, initialSessionFacts: null, memoryEnabled: null, promptStack: null,
        } } });
        writeSessionDraftLocalSupplement({ scope, address, patch: { newSessionLocalState: legacy } });
        const cleared = readNewSessionDraftFromRepository({ scope, draftId });
        for (const field of ['sessionName', 'initialSessionFacts', 'promptStack', 'memoryEnabled']) {
            expect(cleared).not.toHaveProperty(field);
        }
    });

    it('carries a reopened Bot name and initial identity through the ordinary spawn boundary', () => {
        const initialSessionFacts = { bot: { kind: 'bot' }, createdAsBot: true } as const;
        const promptStack = [{ id: 'session.instructions', ref: { kind: 'doc', serverId: scope.serverId, artifactId: 'guide-doc' },
            enabled: true, required: true, placement: 'system_append' }] as const;
        const draftId = '00000000-0000-4000-8000-000000001010';
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({
            sessionName: '  Look after builds  ', initialSessionFacts, memoryEnabled: false, promptStack,
            executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } },
        }) });
        const address = { kind: 'newSession' as const, draftId };
        const { document } = getSessionDraftSnapshot(scope, address)!;
        const synchronized = NewSessionDraftDocumentV2Schema.parse(document);
        expect(synchronized.target.authoring).toMatchObject({
            sessionName: { value: '  Look after builds  ' }, initialSessionFacts: { value: initialSessionFacts },
            memoryEnabled: { value: false }, promptStack: { value: promptStack },
        });
        // Another browser receives the synchronized document without the originating device's supplement.
        writeSessionDraftLocalSupplement({ scope, address, patch: { newSessionLocalState: null } });
        resetSessionDraftRepositoryForTests();
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected retained Bot draft');
        expect(reopened.initialSessionFacts).toEqual(initialSessionFacts);
        const authored = buildNewSessionAuthoringDraftFromPersistedDraft(reopened);
        const spawn = buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: authored, creationKey: 'manual:bot-test', permissionMode: 'default', configurationUpdatedAtMs: 10,
        });
        expect(spawn).toMatchObject({ title: 'Look after builds', identity: initialSessionFacts, memoryEnabled: false, promptStack });
        expect(spawn).not.toHaveProperty('initialInput');
        const automatic = buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft: { ...authored, sessionName: '   ' }, creationKey: 'manual:bot-test', permissionMode: 'default', configurationUpdatedAtMs: 10,
        });
        expect(automatic).not.toHaveProperty('title');
        writeNewSessionNameToRepository({ scope, draftId, sessionName: 'Current title' });
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: reopened, preserveLiveSessionName: true });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.sessionName).toBe('Current title');
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...reopened, sessionName: '' } });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ sessionName: '', initialSessionFacts });
    });
    it('reopens stored authoring origin without extras and preserves it when launch target changes', () => {
        const draftId = '00000000-0000-4000-8000-000000001011';
        const authoringOrigin = {
            kind: 'project',
            accountId: scope.accountId,
            workspace: { serverId: scope.serverId, workspaceId: 'workspace-a', machineId: 'machine-a', rootPath: '/original' },
            page: 'changes',
            comparisonId: 'comparison-a',
        } as const;
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Review this checkout' }) });
        const storedOrigin = { ...authoringOrigin, future: true, workspace: { ...authoringOrigin.workspace, future: true } };
        writeSessionDraftLocalSupplement({
            scope,
            address: { kind: 'newSession', draftId },
            patch: { newSessionLocalState: {
                ...buildNewSessionDraftLocalState(authoringDraft()),
                authoringOrigin: storedOrigin,
            } },
        });
        resetSessionDraftRepositoryForTests();
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered?.authoringOrigin).toEqual(authoringOrigin);
        if (!recovered) throw new Error('Expected a reopened qualified authoring draft');
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: {
            ...recovered,
            executionTarget: { kind: 'machine', target: { serverId: 'server-b', machineId: 'machine-b' } },
            selectedPath: '/edited',
            targetServerId: 'server-b',
            selectedMachineId: 'machine-b',
        } });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            input: 'Review this checkout', selectedPath: '/edited', selectedMachineId: 'machine-b',
            targetServerId: 'server-b', authoringOrigin,
        });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.localSupplement.newSessionLocalState?.authoringOrigin)
            .toEqual(authoringOrigin);
        expect(JSON.stringify(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document))
            .not.toContain('comparison-a');
    });

    it('persists initial triggers in the canonical authoring document and clears them without changing composer text', () => {
        const draftId = 'birth-triggers';
        const initialTriggers = array(SessionInitialTriggerV1Schema).parse([{
            trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } },
            target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
            executionTarget: { kind: 'session' }, inputs: { maxRounds: 3 },
            visibleTeamId: null,
        }]);
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Live prompt', initialTriggers }) });
        expect(cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }))?.initialTriggers?.value)
            .toEqual(initialTriggers);
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered?.initialTriggers).toEqual(initialTriggers);
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Stale autosave', initialTriggers: [] }) });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ input: 'Live prompt', initialTriggers: [] });
    });
    it('keeps an explicit placement-only seed without keeping ordinary empty authoring edits', () => {
        writeNewSessionDraftToRepository({
            scope,
            draftId: 'ordinary-empty-edit',
            draft: authoringDraft({ input: '' }),
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId: 'ordinary-empty-edit' })).toBeNull();

        const draftId = seedNewSessionDraftV1({
            scope,
            createDraftId: () => 'placement-only-seed',
            seed: { placement: { kind: 'exactTarget', serverId: 'server-b', machineId: 'machine-b' } },
        });
        expect(draftId).toBe('placement-only-seed');
        expect(readNewSessionDraftFromRepository({ scope, draftId: draftId! })).toMatchObject({
            input: '',
            executionTarget: { kind: 'machine', target: { serverId: 'server-b', machineId: 'machine-b' } },
        });
    });

    it('retires legacy Zen routing without losing a retained draft or its authoring edits', async () => {
        const zenTaskSource = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Fix the task' } as const;
        const draftId = seedNewSessionDraftV1({
            scope,
            createDraftId: () => '00000000-0000-4000-8000-000000001012',
            seed: { prompt: { text: 'Work on this task', mode: 'replace' } },
        });
        await flushSessionDraft({ scope, address: { kind: 'newSession', draftId: draftId! } });
        // An older writer could persist this retired field; seed that actual
        // storage boundary rather than sending it through the current author API.
        const storage = getSessionDraftPersistenceStorage();
        const addressKey = canonicalSessionDraftAddressV2({ kind: 'newSession', draftId: draftId! });
        const key = sessionDraftRowKey(serverAccountScopedStorageKey('session-drafts-repository-v1', scope), addressKey);
        const replica: unknown = JSON.parse(storage.getString(key)!);
        if (!replica || typeof replica !== 'object' || Array.isArray(replica)) throw new Error('Expected retained replica');
        const retainedSnapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: draftId! });
        storage.set(key, JSON.stringify({ ...replica, localSupplement: { ...retainedSnapshot?.localSupplement,
            newSessionLocalState: { ...retainedSnapshot?.localSupplement.newSessionLocalState, zenTaskSource },
        } }));
        resetSessionDraftRepositoryForTests();
        expect(draftId).toBe('00000000-0000-4000-8000-000000001012');
        const reloaded = readNewSessionDraftFromRepository({ scope, draftId: draftId! });
        expect(reloaded).toMatchObject({ input: 'Work on this task' });
        expect(reloaded).not.toHaveProperty('zenTaskSource');
        writeNewSessionAuthoringDraftToRepository({
            scope, draftId: draftId!, draft: { ...reloaded!, selectedPath: '/changed' },
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId: draftId! })).toMatchObject({ input: 'Work on this task', selectedPath: '/changed' });
        const snapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: draftId! });
        expect(snapshot?.localSupplement.newSessionLocalState).not.toHaveProperty('zenTaskSource');
        expect(JSON.stringify(snapshot?.document)).not.toContain('zen_task');
        expect(readNewSessionDraftFromRepository({ scope: { ...scope, accountId: 'other' }, draftId: draftId! })).toBeNull();
    });
    it('writes and clears only the Temporary computer activation reference', () => {
        const draftId = 'temporary-computer-reference-only';
        const executionTarget = {
            kind: 'temporary_computer',
            serverId: 'server-a',
            artifactTarget: 'linux-x64',
            workspace: { kind: 'choose_on_endpoint' },
        } as const;
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'newer composer text',
                authoring: { executionTarget, directory: '/newer/path' },
            },
            materializationIntent: 'userEdit',
        });
        const before = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        if (!before || !('composer' in before.document)) throw new Error('Expected a Session composer draft');
        const reference = {
            v: 1,
            activationId: '1d79cf10-cabc-4132-a8b8-bafaa7d60b2e',
            createdOnDeviceLabel: 'Creating device',
        } as const;

        writeTemporaryComputerActivationRefToRepository({ scope, draftId, activationRef: reference });

        const written = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        if (!written || !('composer' in written.document)) throw new Error('Expected the retained composer draft');
        expect(written.document.composer.text).toEqual(before.document.composer.text);
        expect(written?.document.target).toMatchObject({
            authoring: {
                executionTarget: cataloguedNewSessionAuthoring(before)?.executionTarget,
                directory: cataloguedNewSessionAuthoring(before)?.directory,
                temporaryComputerActivationRef: { value: reference },
            },
        });

        writeTemporaryComputerActivationRefToRepository({ scope, draftId, activationRef: null });

        const cleared = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        if (!cleared || !('composer' in cleared.document)) throw new Error('Expected the retained composer draft');
        expect(cleared.document.composer.text).toEqual(before.document.composer.text);
        expect(cataloguedNewSessionAuthoring(cleared)?.temporaryComputerActivationRef?.value).toBeNull();
        expect(cataloguedNewSessionAuthoring(cleared)?.executionTarget)
            .toEqual(cataloguedNewSessionAuthoring(before)?.executionTarget);
    });

    it('preserves Temporary computer intent and its activation reference through authoring, reentry and repository edits', () => {
        const draftId = 'temporary-computer-draft';
        const executionTarget = {
            kind: 'temporary_computer',
            serverId: 'server-a',
            artifactTarget: 'darwin-arm64',
            workspace: { kind: 'choose_on_endpoint' },
        } as const;
        const temporaryComputerActivationRef = {
            v: 1,
            activationId: '1d79cf10-cabc-4132-a8b8-bafaa7d60b2e',
            createdOnDeviceLabel: 'My laptop',
        } as const;
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'Keep the reviewed request',
                authoring: {
                    executionTarget,
                    temporaryComputerActivationRef,
                    directory: '/previous-machine-folder',
                },
            },
            materializationIntent: 'userEdit',
        });

        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({
            executionTarget,
            temporaryComputerActivationRef,
            selectedMachineId: null,
            targetServerId: 'server-a',
            selectedPath: '/previous-machine-folder',
        });
        if (!recovered) throw new Error('Expected the retained New Session draft');

        const authored = buildNewSessionAuthoringDraftFromPersistedDraft(recovered);
        const reentry = buildNewSessionTempDataFromAuthoringDraft({ draft: authored, machineId: 'stale-machine' });
        expect(reentry.machineId).toBeUndefined();
        const reentered = buildNewSessionAuthoringDraftFromTempData(reentry);
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: reentered,
            machineId: 'stale-machine',
            targetServerId: 'another-home',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 20,
        });
        expect(persisted).toMatchObject({
            executionTarget,
            temporaryComputerActivationRef,
            selectedMachineId: null,
            targetServerId: 'server-a',
            selectedPath: '/previous-machine-folder',
        });
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: persisted });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.target).toMatchObject({
            authoring: {
                executionTarget: { value: executionTarget },
                temporaryComputerActivationRef: { value: temporaryComputerActivationRef },
                directory: { value: '/previous-machine-folder' },
            },
        });
    });

    it('round-trips and explicitly clears initial access in the canonical synchronized authoring document', () => {
        const access = { grants: [{ subject: { kind: 'account' as const, accountId: 'person-b' }, accessLevel: 'edit' as const, canApprovePermissions: true }] };
        const draftId = 'access-draft';
        // A New Session draft exists once it holds content; access then travels with it.
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Share with Person B', access, primaryTeamId: 'team-a' }) });
        const firstSnapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        const projection = readNewSessionDraftProjectionFromRepository({ scope, draftId });
        const recovered = projection?.draft ?? null;
        expect(projection?.revision).toBe(firstSnapshot?.revision);
        expect(recovered?.access).toEqual(access);
        expect(recovered?.primaryTeamId).toBe('team-a');
        const authored = buildNewSessionAuthoringDraftFromPersistedDraft(recovered!);
        expect(authored.access).toEqual(access);
        const temp = buildNewSessionTempDataFromAuthoringDraft({ draft: authored, machineId: 'machine-b' });
        expect(buildNewSessionAuthoringDraftFromTempData(temp).access).toEqual(access);
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.target).toMatchObject({
            authoring: { access: { value: access } },
        });
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: authoringDraft({ access: null, primaryTeamId: null }) });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.access).toBeNull();
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.primaryTeamId).toBeNull();
    });

    it('retains captured Space context with the editable draft while organization placement stays synchronized', () => {
        const draftId = 'organization-placement-draft';
        const organizationPlacement = { folderId: 'folder-a', tagIds: ['tag-a', 'tag-b'] };
        const spaceMembership = { spaceId: 'captured-space', spaceSettingsTarget: scope };
        const runtimeDescriptorV1 = { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } };
        const draft = { ...authoringDraft({ organizationPlacement, runtimeDescriptorV1 }), spaceMembership };
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft,
        });
        const written = cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }));
        expect(written).toMatchObject({
            organizationPlacement: { value: organizationPlacement },
            runtimeDescriptorV1: { value: runtimeDescriptorV1 },
        });

        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered?.organizationPlacement).toEqual(organizationPlacement);
        expect(recovered?.runtimeDescriptorV1).toEqual(runtimeDescriptorV1);
        expect(recovered).toMatchObject({ spaceMembership });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.localSupplement.newSessionLocalState)
            .toMatchObject({ spaceMembership });
        expect(written).not.toHaveProperty('spaceMembership');

        // Reopening and autosaving the recovered draft must not revert the saved choice to defaults.
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: recovered! });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.organizationPlacement).toEqual(organizationPlacement);
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ spaceMembership });
        const cleared = { ...recovered!, spaceMembership: null };
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: cleared });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ spaceMembership: null });
    });

    it('projects a clean conflict with per-field access and Team-context presence', () => {
        const draftId = 'conflict-presence';
        const access = { grants: [{ subject: { kind: 'account' as const, accountId: 'person-b' }, accessLevel: 'edit' as const, canApprovePermissions: true }] };
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Share with Person B', access, primaryTeamId: 'team-a' }) });
        const clean = readNewSessionDraftProjectionFromRepository({ scope, draftId });
        expect(clean?.conflict).toBeNull();
        expect(hasNewSessionDraftAccessConflict(clean?.conflict)).toBe(false);
        expect(hasNewSessionDraftPrimaryTeamConflict(clean?.conflict)).toBe(false);
        expect(hasNewSessionDraftAccessConflict({ fields: [{
            fieldId: 'target.authoring.access',
            path: { kind: 'authoring', fieldId: 'access' },
            mine: null,
            synced: null,
        }] })).toBe(true);
        expect(hasNewSessionDraftPrimaryTeamConflict({ fields: [{
            fieldId: 'target.authoring.primaryTeamId',
            path: { kind: 'authoring', fieldId: 'primaryTeamId' },
            mine: null,
            synced: null,
        }] })).toBe(true);
        expect(hasNewSessionDraftAccessConflict({ fields: [{
            fieldId: 'target.authoring.primaryTeamId',
            path: { kind: 'authoring', fieldId: 'primaryTeamId' },
            mine: null,
            synced: null,
        }] })).toBe(false);
    });

    it('projects a published 0.2 draft and contracts predecessor fields when a current-only value is written', () => {
        const draftId = 'predecessor-draft';
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'Continue on another device',
                // Reader-compatibility fixture: current writers intentionally exclude predecessor keys.
                authoring: {
                    machineId: 'machine-legacy',
                    serverId: 'server-legacy',
                    agentId: 'codex',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    modelId: 'gpt-5',
                    codexBackendMode: 'appServer',
                } as never,
            },
            materializationIntent: 'userEdit',
        });

        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({
            input: 'Continue on another device',
            selectedMachineId: 'machine-legacy',
            targetServerId: 'server-legacy',
            executionTarget: { kind: 'machine', target: { serverId: 'server-legacy', machineId: 'machine-legacy' } },
            agentType: 'codex',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5',
                },
            },
        });

        writeNewSessionDraftToRepository({ scope, draftId, draft: recovered! });
        const current = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document;
        expect(current).toMatchObject({
            v: 2,
            target: {
            kind: 'newSession',
            authoring: {
                executionTarget: {
                    value: {
                        kind: 'machine',
                        target: { serverId: 'server-legacy', machineId: 'machine-legacy' },
                    },
                },
                agentTarget: {
                    value: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                },
            },
            },
        });
        if (current?.target.kind !== 'newSession') throw new Error('expected new-session draft');
        expect(current.target.authoring).not.toHaveProperty('machineId');
        expect(current.target.authoring).not.toHaveProperty('serverId');
        expect(current.target.authoring).not.toHaveProperty('agentId');
        expect(current.target.authoring).not.toHaveProperty('backendTarget');
        expect(current.target.authoring).not.toHaveProperty('modelId');
        expect(current.target.authoring).not.toHaveProperty('codexBackendMode');
    });

    it('persists delayed authoring fields without rewriting the canonical composer document', () => {
        const draftId = 'draft-a';
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'live composer text',
                mentions: [{ kind: 'mention', tokenText: '@issue', start: 0, end: 6 }],
                attachments: [attachment],
            },
            materializationIntent: 'userEdit',
        });

        writeNewSessionAuthoringDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft(),
        });

        const snapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        expect(snapshot?.document).toMatchObject({ composer: {
            text: { value: 'live composer text' },
            mentions: { value: [{ kind: 'mention', tokenText: '@issue', start: 0, end: 6 }] },
            attachments: { value: [attachment] },
        } });
        expect(snapshot?.document.target).toMatchObject({
            kind: 'newSession',
            authoring: {
                executionTarget: {
                    value: {
                        kind: 'machine',
                        target: { serverId: 'server-a', machineId: 'machine-b' },
                    },
                },
                directory: { value: '/repo' },
                agentTarget: {
                    value: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                },
            },
        });
    });

    it('round-trips the canonical execution and Agent selection through the repository', () => {
        const draftId = 'round-trip-draft';
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft({
                executionTarget: {
                    kind: 'machine',
                    target: { serverId: 'server-a', machineId: 'machine-b' },
                    selectionOrigin: {
                        kind: 'machine_pool',
                        poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                    },
                },
            }),
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            selectedMachineId: 'machine-b',
            targetServerId: 'server-a',
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-a', machineId: 'machine-b' },
                selectionOrigin: {
                    kind: 'machine_pool',
                    poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                },
            },
            agentType: 'codex',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        });
    });

    it('sanitizes incomplete synchronized Automation trigger rows when materializing a local draft', () => {
        const draftId = 'incomplete-automation-draft';
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                authoring: {
                    automation: {
                        enabled: true,
                        name: 'Continue later',
                        description: '',
                        triggers: [{
                            clientId: 'trigger-a',
                            kind: 'sessionLifecycle',
                            persisted: null,
                            enabled: true,
                            definition: null,
                        }],
                    },
                },
            },
            materializationIntent: 'userEdit',
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })?.automationDraft).toMatchObject({
            enabled: true,
            name: 'Continue later',
            triggers: [],
        });
    });

    it('retains the full writer for an initial seed before the composer mounts', () => {
        writeNewSessionDraftToRepository({
            scope,
            draftId: 'seeded-draft',
            draft: authoringDraft({
                input: 'Seeded prompt',
                composerAttachments: [attachment],
            }),
        });

        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: 'seeded-draft' })?.document)
            .toMatchObject({ composer: {
                text: { value: 'Seeded prompt' },
                attachments: { value: [attachment] },
            } });
    });

    it('round-trips device-local launch choices without synchronizing them', () => {
        const draftId = 'local-state-draft';
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft({
                entryIntent: 'automation',
                selectedSecretId: 'secret-a',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 12,
                    overrides: { speed: { updatedAt: 12, value: 'fast' } },
                },
                windowsRemoteSessionLaunchModeOverride: {
                    machineId: 'machine-b',
                    mode: 'windows_terminal',
                },
            }),
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            entryIntent: 'automation',
            selectedSecretId: 'secret-a',
            sessionConfigOptionOverrides: {
                overrides: { speed: { value: 'fast' } },
            },
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-b',
                mode: 'windows_terminal',
            },
        });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.target)
            .not.toMatchObject({
                authoring: { windowsRemoteSessionLaunchMode: expect.anything() },
            });
    });

    it('round-trips draft-local attachment requests and clears only admitted identities', () => {
        const draftId = 'seed-custody-draft';
        const seed: NewSessionComposerAttachmentSeedV1 = {
            instanceId: 'seed-a',
            pluginId: 'example.plugin',
            attachmentLocalId: 'ticket',
            value: { key: 'ticket-a', value: { id: 42 }, presentation: { label: 'Issue 42' } },
        };
        const otherSeed = { ...seed, instanceId: 'seed-b', value: { ...seed.value, key: 'ticket-b' } };
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft({ composerAttachmentSeeds: [seed, otherSeed] }),
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds)
            .toEqual([seed, otherSeed]);
        clearNewSessionComposerAttachmentSeedsFromRepository({ scope, draftId, seeds: [seed] });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds)
            .toEqual([otherSeed]);
    });

    it.each([false, true])('preserves pending screen attachment custody across ordinary Machine authoring edits (delayed=%s)', (preserveLiveSessionName) => {
        const draftId = 'pending-screen-machine-edit';
        expect(seedAndOpenNewSession({
            scope, createDraftId: () => draftId, isCurrent: () => true, navigateToNewSession: () => {},
            seed: { currentUiContext: { navigation: { area: 'sessions', screen: 'tab.sessions' }, commands: [] } },
        }).kind).toBe('opened');
        const pending = readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds;
        expect(pending).toHaveLength(1);

        writeNewSessionAuthoringDraftToRepository({ scope, draftId,
            draft: authoringDraft({ selectedMachineId: 'other-machine' }), preserveLiveSessionName });

        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            selectedMachineId: 'other-machine', composerAttachmentSeeds: pending,
        });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document)
            .toMatchObject({ composer: { attachments: { value: [] } } });
    });

    it.each([false, true])('does not resurrect settled attachment requests from stale authoring snapshots (delayed=%s)', (preserveLiveSessionName) => {
        const draftId = 'settled-screen-stale-authoring';
        expect(seedAndOpenNewSession({
            scope, createDraftId: () => draftId, isCurrent: () => true, navigateToNewSession: () => {},
            seed: { currentUiContext: { navigation: { area: 'sessions', screen: 'tab.sessions' }, commands: [] } },
        }).kind).toBe('opened');
        const stale = readNewSessionDraftFromRepository({ scope, draftId });
        if (!stale?.composerAttachmentSeeds) throw new Error('Expected pending screen custody');
        clearNewSessionComposerAttachmentSeedsFromRepository({ scope, draftId, seeds: stale.composerAttachmentSeeds });

        writeNewSessionAuthoringDraftToRepository({ scope, draftId,
            draft: { ...stale, selectedMachineId: 'other-machine' }, preserveLiveSessionName });

        expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds).toBeUndefined();
    });
});
