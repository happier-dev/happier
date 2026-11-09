import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerPreparedAuthoringV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';

const state = vi.hoisted(() => ({
    values: new Map<string, string>(),
    removedFiles: [] as unknown[],
    read: vi.fn(async (key: string) => state.values.get(key) ?? null),
    removeFile: vi.fn(async (value: unknown) => { state.removedFiles.push(value); }),
}));

vi.mock('@/auth/storage/deviceLocalStorage', () => ({
    readDeviceLocalStorageString: state.read,
    writeDeviceLocalStorageString: async (key: string, value: string) => { state.values.set(key, value); },
    removeDeviceLocalStorageString: async (key: string) => { state.values.delete(key); },
}));

vi.mock('./package/runnerArtifactAcquisitionSink', () => ({
    isRunnerArtifactAcquisitionCustodyHandle: (value: unknown) => Boolean(
        value && typeof value === 'object' && 'kind' in value,
    ),
    openRunnerArtifactAcquisitionCustody: async (value: Readonly<{ kind: string; fileUri?: string }>) => (
        value.kind === 'native_cache_file'
            ? { kind: 'native', uri: value.fileUri }
            : { kind: 'web', file: new File(['reviewed'], 'staged.bin') }
    ),
    removeRunnerArtifactAcquisitionCustody: (value: unknown) => state.removeFile(value),
}));

import {
    beginRunnerCreatorAttachmentStagingCustody,
    listRunnerCreatorCustodyActivationIds,
    readRunnerCreatorAttachmentUploadCustody,
    readPreparedRunnerCreatorLaunchCustody,
    readSubmittedRunnerCreatorTeamCredentialModel,
    recordRunnerCreatorStagingCustodyHandle,
    recordRunnerCreatorStagedAttachmentCustody,
    recordRunnerCreatorAttachmentUploadCheckpoint,
    removeRunnerCreatorLaunchCustody,
    writePreparedRunnerCreatorLaunchCustody,
} from './runnerCreatorLaunchCustody';
import { createRunnerActivationKeyCustody, openRunnerActivationKeyCustody } from './runnerActivationKeyCustody';
import { removeRunnerCreatorCustodyForAccount } from './runnerCreatorDraftRemoval';

const scope = { serverId: 'home-a', accountId: 'account-a' } as const;
const activationId = '00000000-0000-4000-8000-0000000000aa';
const preparedAuthoring: RunnerPreparedAuthoringV1 = {
    v: 1,
    actionsSettings: { v: 1, actions: {} },
    mcpMaterial: null,
    authoring: {
        targetType: 'new_session',
        executionTarget: {
            kind: 'temporary_computer',
            serverId: scope.serverId,
            artifactTarget: 'linux-x64',
            workspace: { kind: 'choose_on_endpoint' },
        },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } },
        permissionMode: 'default',
        modelSelection: null,
        transcriptStorage: 'persisted',
        profileId: null,
        environmentVariables: null,
        capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
        connectedServices: null,
        checkoutCreationDraft: null,
        resumeSessionId: null,
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        acpSessionModeId: null,
        sessionConfigOptionOverrides: null,
        access: null,
        primaryTeamId: null,
        organizationPlacement: { folderId: null, tagIds: [] },
    },
    agentPluginDistribution: null,
    composer: { text: 'Inspect this', references: [], attachments: [] },
    files: [{
        id: 'file-a',
        name: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 8,
        sha256: 'a'.repeat(64),
    }],
    attachmentDestination: {
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
    },
};

describe('Runner creator attachment launch custody', () => {
    beforeEach(() => {
        state.values.clear();
        state.removedFiles.length = 0;
        state.read.mockReset();
        state.read.mockImplementation(async (key: string) => state.values.get(key) ?? null);
        state.removeFile.mockReset();
        state.removeFile.mockImplementation(async (value: unknown) => { state.removedFiles.push(value); });
    });

    it('restores prepared custody with retired fields without changing canonical writes', async () => {
        await writePreparedRunnerCreatorLaunchCustody({ scope, activationId, preparedAuthoring, attachmentUpload: {
            attachmentMessageLocalId: 'attachment-message-a', firstTurnLocalId: 'first-turn-a', maxFileBytes: 1024,
            files: [{ id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8,
                custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/notes.txt' } }],
        } });
        for (const [key, raw] of state.values) {
            const value: unknown = JSON.parse(raw);
            if (value && typeof value === 'object' && 'preparedAuthoring' in value) {
                state.values.set(key, JSON.stringify({ ...value, preparedAuthoring: { ...preparedAuthoring,
                    retired: true, composer: { ...preparedAuthoring.composer, retired: true } } }));
            }
        }
        await expect(readPreparedRunnerCreatorLaunchCustody(scope, activationId)).resolves.toEqual(preparedAuthoring);
    });

    it('discovers crash-stranded staged bytes from the existing Account custody index', async () => {
        const otherScope = { serverId: scope.serverId, accountId: 'account-b' } as const;
        const exact = await createRunnerActivationKeyCustody(scope);
        const other = await createRunnerActivationKeyCustody(otherScope);
        const exactCustody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/exact.txt' };
        const otherCustody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/other.txt' };

        for (const [targetScope, target, custody] of [
            [scope, exact, exactCustody],
            [otherScope, other, otherCustody],
        ] as const) {
            await beginRunnerCreatorAttachmentStagingCustody({
                scope: targetScope,
                activationId: target.activationId,
                attachmentMessageLocalId: `attachment-${target.activationId}`,
                firstTurnLocalId: `turn-${target.activationId}`,
                maxFileBytes: 1024,
            });
            const custodyFile = {
                id: 'file-a',
                name: 'notes.txt',
                mimeType: 'text/plain',
                sizeBytes: 8,
                custody,
            } as const;
            await recordRunnerCreatorStagingCustodyHandle({
                scope: targetScope,
                activationId: target.activationId,
                custodyFile,
            });
        }

        // Simulate process interruption before prepared launch custody exists.
        await removeRunnerCreatorCustodyForAccount(scope);

        expect(state.removeFile).toHaveBeenCalledWith(exactCustody);
        expect(state.removeFile).not.toHaveBeenCalledWith(otherCustody);
        await expect(listRunnerCreatorCustodyActivationIds(scope)).resolves.toEqual([]);
        await expect(listRunnerCreatorCustodyActivationIds(otherScope)).resolves.toEqual([other.activationId]);
        await expect(openRunnerActivationKeyCustody(scope, exact.activationId))
            .rejects.toMatchObject({ code: 'runner_activation_key_unavailable' });
        await expect(openRunnerActivationKeyCustody(otherScope, other.activationId)).resolves.toEqual(other);
    });

    it('promotes progressively staged custody into the prepared launch record', async () => {
        const exact = await createRunnerActivationKeyCustody(scope);
        const custody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/notes.txt' };
        await beginRunnerCreatorAttachmentStagingCustody({
            scope,
            activationId: exact.activationId,
            attachmentMessageLocalId: 'attachment-message-a',
            firstTurnLocalId: 'first-turn-a',
            maxFileBytes: 1024,
        });
        const custodyFile = { id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, custody } as const;
        await recordRunnerCreatorStagingCustodyHandle({ scope, activationId: exact.activationId, custodyFile });
        const retiredReviewedFile = { ...preparedAuthoring.files[0]!, retired: true };
        await expect(recordRunnerCreatorStagedAttachmentCustody({ scope, activationId: exact.activationId,
            reviewedFile: retiredReviewedFile, custodyFile,
        })).rejects.toThrow();
        await recordRunnerCreatorStagedAttachmentCustody({
            scope,
            activationId: exact.activationId,
            reviewedFile: preparedAuthoring.files[0]!,
            custodyFile,
        });

        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId: exact.activationId,
            preparedAuthoring,
            attachmentUpload: {
                attachmentMessageLocalId: 'attachment-message-a',
                firstTurnLocalId: 'first-turn-a',
                maxFileBytes: 1024,
                files: [{ id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, custody }],
            },
        });

        await expect(readRunnerCreatorAttachmentUploadCustody(scope, exact.activationId)).resolves.toMatchObject({
            attachmentMessageLocalId: 'attachment-message-a',
            firstTurnLocalId: 'first-turn-a',
            stagedFiles: [expect.objectContaining({ id: 'file-a' })],
        });
    });

    it('retains partial staging custody and its Account locator after deletion fails', async () => {
        const exact = await createRunnerActivationKeyCustody(scope);
        const custody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/notes.txt' };
        await beginRunnerCreatorAttachmentStagingCustody({
            scope,
            activationId: exact.activationId,
            attachmentMessageLocalId: 'attachment-message-a',
            firstTurnLocalId: 'first-turn-a',
            maxFileBytes: 1024,
        });
        const custodyFile = { id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, custody } as const;
        await recordRunnerCreatorStagingCustodyHandle({ scope, activationId: exact.activationId, custodyFile });
        await recordRunnerCreatorStagedAttachmentCustody({
            scope,
            activationId: exact.activationId,
            reviewedFile: preparedAuthoring.files[0]!,
            custodyFile,
        });
        state.removeFile.mockRejectedValueOnce(new Error('file busy'));

        await expect(removeRunnerCreatorCustodyForAccount(scope)).rejects.toThrow('file busy');
        await expect(listRunnerCreatorCustodyActivationIds(scope)).resolves.toEqual([exact.activationId]);
        await expect(removeRunnerCreatorCustodyForAccount(scope)).resolves.toBeUndefined();
        expect(state.removeFile).toHaveBeenCalledTimes(2);
        await expect(listRunnerCreatorCustodyActivationIds(scope)).resolves.toEqual([]);
    });

    it('reopens and removes the exact activation-scoped reviewed Profile environment', async () => {
        const reviewed = {
            ...preparedAuthoring,
            files: [],
            reviewComments: {
                workspace: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' },
                comments: [{
                    id: 'comment-a',
                    filePath: 'src/example.ts',
                    source: 'file' as const,
                    anchor: { kind: 'fileLine' as const, startLine: 4, lineHash: 'lh1:1234567890abcdef' as const },
                    snapshot: { selectedLines: ['const answer = 41;'], beforeContext: [], afterContext: [] },
                    body: 'Use 42.',
                    createdAt: 1,
                }],
            },
            authoring: {
                ...preparedAuthoring.authoring,
                profileId: 'work',
                environmentVariables: { RUNNER_PROFILE_TOKEN: 'sealed-secret' },
            },
        };
        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring: reviewed,
        });

        await expect(readPreparedRunnerCreatorLaunchCustody(scope, activationId)).resolves.toMatchObject({
            authoring: {
                profileId: 'work',
                environmentVariables: { RUNNER_PROFILE_TOKEN: 'sealed-secret' },
            },
            reviewComments: {
                workspace: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' },
                comments: [expect.objectContaining({ id: 'comment-a', body: 'Use 42.' })],
            },
        });
        await removeRunnerCreatorLaunchCustody(scope, activationId);
        await expect(readPreparedRunnerCreatorLaunchCustody(scope, activationId))
            .rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });
    });

    it('keeps the Team model frozen at Send, and reports none when the package froze none', async () => {
        const submitted = {
            kind: 'team_credential_provider_model',
            resourceId: 'resource-a',
            teamId: 'team-1',
            expectedResourceRevision: 3,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'gpt-5',
            deliveryMode: 'brokered',
        } as const;
        const withoutFiles = { ...preparedAuthoring, files: [] };
        await writePreparedRunnerCreatorLaunchCustody({ scope, activationId, preparedAuthoring: withoutFiles, submittedTeamCredentialModel: submitted });
        await expect(readSubmittedRunnerCreatorTeamCredentialModel(scope, activationId)).resolves.toEqual(submitted);

        await removeRunnerCreatorLaunchCustody(scope, activationId);
        await writePreparedRunnerCreatorLaunchCustody({ scope, activationId, preparedAuthoring: withoutFiles });
        await expect(readSubmittedRunnerCreatorTeamCredentialModel(scope, activationId)).resolves.toBeNull();
    });

    it('requires a persisted first-turn identity even when the submission has no files', async () => {
        const withoutFiles = { ...preparedAuthoring, files: [] };
        await writePreparedRunnerCreatorLaunchCustody({ scope, activationId, preparedAuthoring: withoutFiles });
        await expect(readRunnerCreatorAttachmentUploadCustody(scope, activationId))
            .rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });

        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring: withoutFiles,
            attachmentUpload: {
                attachmentMessageLocalId: 'attachment-message-a',
                firstTurnLocalId: 'spawn-first-turn:creation-a',
                maxFileBytes: 1024,
                files: [],
            },
        });
        await expect(readRunnerCreatorAttachmentUploadCustody(scope, activationId)).resolves.toMatchObject({
            firstTurnLocalId: 'spawn-first-turn:creation-a',
            stagedFiles: [],
        });
    });

    it('reopens exact staged sources and upload identities after a React owner remount', async () => {
        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring,
            attachmentUpload: {
                attachmentMessageLocalId: 'attachment-message-a',
                firstTurnLocalId: 'first-turn-a',
                maxFileBytes: 1024,
                files: [{
                    id: 'file-a',
                    name: 'notes.txt',
                    mimeType: 'text/plain',
                    sizeBytes: 8,
                    custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/notes.txt' },
                }],
            },
        });

        await expect(readRunnerCreatorAttachmentUploadCustody(scope, activationId)).resolves.toEqual({
            attachmentMessageLocalId: 'attachment-message-a',
            firstTurnLocalId: 'first-turn-a',
            maxFileBytes: 1024,
            stagedFiles: [{
                id: 'file-a',
                source: {
                    kind: 'native',
                    uri: 'file:///runner-stage/notes.txt',
                    name: 'notes.txt',
                    sizeBytes: 8,
                    mimeType: 'text/plain',
                },
            }],
        });
    });

    it('retains a verified ordinary-upload checkpoint in the existing activation custody', async () => {
        const attachmentHandle = { v: 1 as const, sessionId: 'session-1', id: 'issued-file-a' };
        const custodyModule = await import('./runnerCreatorLaunchCustody');
        const recordCheckpoint = (
            custodyModule as unknown as Readonly<Record<string, unknown>>
        ).recordRunnerCreatorAttachmentUploadCheckpoint;
        expect(recordCheckpoint).toBeTypeOf('function');
        if (typeof recordCheckpoint !== 'function') return;
        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring,
            attachmentUpload: {
                attachmentMessageLocalId: 'attachment-message-a',
                firstTurnLocalId: 'first-turn-a',
                maxFileBytes: 1024,
                files: [{
                    id: 'file-a',
                    name: 'notes.txt',
                    mimeType: 'text/plain',
                    sizeBytes: 8,
                    custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/notes.txt' },
                }],
            },
        });

        await recordCheckpoint({
            scope,
            activationId,
            upload: {
                id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', path: '.happier/uploads/legacy-notes.txt',
                sizeBytes: 8, sha256: 'a'.repeat(64),
            },
        });
        await expect(readRunnerCreatorAttachmentUploadCustody(scope, activationId)).resolves.toMatchObject({
            resumedUploads: [{ id: 'file-a', path: '.happier/uploads/legacy-notes.txt' }],
        });
        await recordCheckpoint({
            scope,
            activationId,
            upload: {
                id: 'file-a',
                name: 'notes.txt',
                mimeType: 'text/plain',
                path: '.happier/uploads/notes.txt',
                sizeBytes: 8,
                sha256: 'a'.repeat(64),
                attachmentHandle,
            },
        });

        await expect(readRunnerCreatorAttachmentUploadCustody(scope, activationId)).resolves.toMatchObject({
            resumedUploads: [{
                id: 'file-a',
                name: 'notes.txt',
                mimeType: 'text/plain',
                path: '.happier/uploads/notes.txt',
                sizeBytes: 8,
                sha256: 'a'.repeat(64),
                attachmentHandle,
            }],
        });
    });

    it('removes staged byte custody before deleting the activation-scoped record', async () => {
        const custody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/notes.txt' };
        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring,
            attachmentUpload: {
                attachmentMessageLocalId: 'attachment-message-a',
                firstTurnLocalId: 'first-turn-a',
                maxFileBytes: 1024,
                files: [{ id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, custody }],
            },
        });

        await removeRunnerCreatorLaunchCustody(scope, activationId);

        expect(state.removedFiles).toEqual([custody]);
        await expect(readRunnerCreatorAttachmentUploadCustody(scope, activationId))
            .rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });
    });

    it('serializes concurrent checkpoint writes without losing either verified file', async () => {
        const secondFile = {
            id: 'file-b',
            name: 'more.txt',
            mimeType: 'text/plain',
            sizeBytes: 9,
            sha256: 'b'.repeat(64),
        } as const;
        const twoFiles = { ...preparedAuthoring, files: [...preparedAuthoring.files, secondFile] };
        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring: twoFiles,
            attachmentUpload: {
                attachmentMessageLocalId: 'attachment-message-a',
                firstTurnLocalId: 'first-turn-a',
                maxFileBytes: 1024,
                files: [
                    { id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/notes.txt' } },
                    { id: 'file-b', name: 'more.txt', mimeType: 'text/plain', sizeBytes: 9, custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/more.txt' } },
                ],
            },
        });

        await Promise.all([
            recordRunnerCreatorAttachmentUploadCheckpoint({
                scope,
                activationId,
                upload: { id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', path: '.happier/uploads/notes.txt', sizeBytes: 8, sha256: 'a'.repeat(64) },
            }),
            recordRunnerCreatorAttachmentUploadCheckpoint({
                scope,
                activationId,
                upload: { id: 'file-b', name: 'more.txt', mimeType: 'text/plain', path: '.happier/uploads/more.txt', sizeBytes: 9, sha256: 'b'.repeat(64) },
            }),
        ]);

        await expect(readRunnerCreatorAttachmentUploadCustody(scope, activationId)).resolves.toMatchObject({
            resumedUploads: [
                expect.objectContaining({ id: 'file-a', path: '.happier/uploads/notes.txt' }),
                expect.objectContaining({ id: 'file-b', path: '.happier/uploads/more.txt' }),
            ],
        });
    });

    it('retains the exact locator and remains retryable after a staged-file removal failure', async () => {
        const custody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/notes.txt' };
        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring,
            attachmentUpload: {
                attachmentMessageLocalId: 'attachment-message-a',
                firstTurnLocalId: 'first-turn-a',
                maxFileBytes: 1024,
                files: [{ id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, custody }],
            },
        });
        state.removeFile.mockRejectedValueOnce(new Error('file busy'));

        await expect(removeRunnerCreatorLaunchCustody(scope, activationId)).rejects.toThrow('file busy');
        await expect(readPreparedRunnerCreatorLaunchCustody(scope, activationId)).resolves.toMatchObject({ v: 1 });
        await expect(removeRunnerCreatorLaunchCustody(scope, activationId)).resolves.toBeUndefined();
        expect(state.removeFile).toHaveBeenCalledTimes(2);
        await expect(readPreparedRunnerCreatorLaunchCustody(scope, activationId))
            .rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });

        await expect(removeRunnerCreatorLaunchCustody(scope, activationId)).resolves.toBeUndefined();
        expect(state.removeFile).toHaveBeenCalledTimes(2);
    });

    it('retains the exact locator when custody metadata is temporarily unreadable', async () => {
        await writePreparedRunnerCreatorLaunchCustody({
            scope,
            activationId,
            preparedAuthoring: { ...preparedAuthoring, files: [] },
        });
        state.read.mockRejectedValueOnce(new Error('protected storage busy'));

        await expect(removeRunnerCreatorLaunchCustody(scope, activationId))
            .rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });
        await expect(readPreparedRunnerCreatorLaunchCustody(scope, activationId)).resolves.toMatchObject({ v: 1 });
    });

    it('erases every exact Account/Home key, launch record, and staged file without touching another scope', async () => {
        const otherScope = { serverId: scope.serverId, accountId: 'account-b' } as const;
        const exact = await createRunnerActivationKeyCustody(scope);
        const other = await createRunnerActivationKeyCustody(otherScope);
        const exactCustody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/exact.txt' };
        const otherCustody = { kind: 'native_cache_file' as const, fileUri: 'file:///runner-stage/other.txt' };
        for (const [targetScope, target, custody] of [
            [scope, exact, exactCustody],
            [otherScope, other, otherCustody],
        ] as const) {
            await writePreparedRunnerCreatorLaunchCustody({
                scope: targetScope,
                activationId: target.activationId,
                preparedAuthoring,
                attachmentUpload: {
                    attachmentMessageLocalId: `attachment-${target.activationId}`,
                    firstTurnLocalId: `turn-${target.activationId}`,
                    maxFileBytes: 1024,
                    files: [{ id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, custody }],
                },
            });
        }

        await removeRunnerCreatorCustodyForAccount(scope);

        expect(state.removeFile).toHaveBeenCalledWith(exactCustody);
        expect(state.removeFile).not.toHaveBeenCalledWith(otherCustody);
        await expect(openRunnerActivationKeyCustody(scope, exact.activationId))
            .rejects.toMatchObject({ code: 'runner_activation_key_unavailable' });
        await expect(readPreparedRunnerCreatorLaunchCustody(scope, exact.activationId))
            .rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });
        await expect(listRunnerCreatorCustodyActivationIds(scope)).resolves.toEqual([]);
        await expect(openRunnerActivationKeyCustody(otherScope, other.activationId)).resolves.toEqual(other);
        await expect(readPreparedRunnerCreatorLaunchCustody(otherScope, other.activationId)).resolves.toMatchObject({ v: 1 });
        await expect(listRunnerCreatorCustodyActivationIds(otherScope)).resolves.toEqual([other.activationId]);
    });
});
