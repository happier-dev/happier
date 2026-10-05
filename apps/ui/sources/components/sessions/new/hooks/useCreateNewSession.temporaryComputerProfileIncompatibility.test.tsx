import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, type SavedSecret } from '@happier-dev/protocol';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui';

import { renderHook } from '@/dev/testkit';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { RunnerActivationClientError, type RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import {
    assertLaunchProfileReviewCurrent,
    LaunchProfileEnvironmentUnavailableError,
    materializeLaunchProfileEnvironment,
} from '../modules/profileHelpers';

import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syncSingletonBridge = vi.hoisted(() => ({
    current: null as typeof import('@/sync/sync').sync | null,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => {
        if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
        return syncSingletonBridge.current;
    },
}));

const SCOPE = { serverId: 'server-a', accountId: 'account-a' } as const;

/**
 * The exact Profile the composer reviewed at Send. `createdAt`/`updatedAt` are
 * pinned because the schema stamps them from the clock, and only a genuine
 * Account-side change may move `updatedAt`.
 */
const reviewedProfile = (updatedAt = 1): AIBackendProfile => AIBackendProfileSchema.parse({
    id: 'work',
    name: 'Work',
    environmentVariables: [{ name: 'PROFILE_MODE', value: 'reviewed' }],
    envVarRequirements: [{ name: 'RUNNER_PROFILE_TOKEN', required: true, kind: 'secret' }],
    createdAt: 0,
    updatedAt,
});

function composerSnapshot(text: string): ComposerSnapshotV1 {
    return {
        revision: 1,
        ref: { kind: 'newSession', instanceId: 'temporary-computer-profile-composer' },
        text,
        references: [],
        attachments: [],
        layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
    };
}

describe('New Session Send on a Temporary computer with an unresolvable Profile', () => {
    let modalAlertSpy: ReturnType<typeof vi.fn>;
    let useComposedTemporaryComputerSend: (input: Readonly<{
        currentProfile: AIBackendProfile | null;
        secrets: readonly SavedSecret[];
        create: ReturnType<typeof vi.fn>;
        /** Replaces the Profile preflight with a transport-shaped failure. */
        transientFailure?: unknown;
    }>) => Readonly<{
        status: string;
        handleCreateSession: (options?: Record<string, unknown>) => void;
        dismissTerminal: () => void;
    }>;

    beforeAll(async () => {
        modalAlertSpy = vi.fn();
        installNewSessionScreenModelCommonModuleMocks({
            text: () => createTextModuleMock({ translate: (key: string) => key }),
            modal: async () => ({ Modal: { alert: modalAlertSpy, confirm: vi.fn(async () => false) } }),
        });
        vi.doUnmock('@/sync/domains/state/storage');
        vi.doUnmock('@/sync/domains/state/persistence');
        await selectNewSessionTestHome();
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().activateProfileScope(SCOPE);
        storage.getState().activateSettingsScope(SCOPE);
        storage.getState().applySettings(storage.getState().settings, 1);
        const { sync } = await import('@/sync/syncEngine');
        syncSingletonBridge.current = sync;

        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { useTemporaryComputerLaunch } = await import('./useTemporaryComputerLaunch');

        // The mounted screen model composes exactly these two owners: Send calls
        // the launch controller, and the controller's abandonment rejects the
        // settlement Send handed it. Recreating that composition here keeps the
        // production Send path, its generic failure alert and the launch owner's
        // recovery under one real test.
        let draftSequence = 0;
        useComposedTemporaryComputerSend = (input) => {
            const draftId = React.useMemo(() => `temporary-profile-draft-${++draftSequence}`, []);
            const settlementRef = React.useRef<{ reject: () => void } | null>(null);
            const client = React.useRef({
                readByDraft: async () => { throw new RunnerActivationClientError('not_found', 404, false); },
                create: input.create,
            } as unknown as RunnerActivationClient).current;
            const controller = useTemporaryComputerLaunch({
                client,
                serverId: SCOPE.serverId,
                draftId,
                existingPublicRef: null,
                prepareActivation: async () => {
                    if (input.transientFailure !== undefined) throw input.transientFailure;
                    const currentProfile = input.currentProfile;
                    assertLaunchProfileReviewCurrent(reviewedProfile(), currentProfile);
                    const materialized = materializeLaunchProfileEnvironment({
                        profile: currentProfile,
                        selectedAgentProviderOwnedEnvironmentKeys: [],
                        secrets: input.secrets,
                        selectedSecretIds: { RUNNER_PROFILE_TOKEN: 'secret-work' },
                        machineEnvReadyByName: { RUNNER_PROFILE_TOKEN: false },
                        decryptSecretValue: (value) => value?.value ?? null,
                    });
                    if (!materialized.ok) throw new LaunchProfileEnvironmentUnavailableError(materialized.reason);
                    throw new Error('unreachable: the preflight must reject before activation creation');
                },
                persistPublicRef: () => undefined,
                onMaterialized: () => undefined,
                onAbandoned: () => {
                    settlementRef.current?.reject();
                    settlementRef.current = null;
                },
            });
            const { handleCreateSession } = useCreateNewSession({
                launchIntentSignature: 'temporary-computer-profile-intent',
                router: { push: vi.fn(), replace: vi.fn() } as never,
                selectedMachineId: null,
                selectedMachine: null as never,
                selectedPath: '',
                draftId,
                draftScope: SCOPE,
                temporaryComputerTargetScope: SCOPE,
                targetServerId: SCOPE.serverId,
                allowedTargetServerIds: [SCOPE.serverId],
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: storage.getState().settings,
                useProfiles: true,
                selectedProfileId: 'work',
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'default',
                modelMode: 'default',
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                authoringDraft: {
                    executionTarget: {
                        kind: 'temporary_computer',
                        serverId: SCOPE.serverId,
                        artifactTarget: 'linux-x64',
                        workspace: { kind: 'choose_on_endpoint' },
                    },
                } as never,
                machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                resolveSavedSecretReference: () => ({ status: 'missing' }) as never,
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: {},
                temporaryComputerLaunch: async (_submission, settlement) => {
                    settlementRef.current = settlement;
                    await controller.start();
                },
            });
            return {
                status: controller.status,
                handleCreateSession: handleCreateSession as (options?: Record<string, unknown>) => void,
                dismissTerminal: controller.dismissTerminal,
            };
        };
    });

    afterAll(() => {
        syncSingletonBridge.current = null;
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        modalAlertSpy.mockReset();
    });

    type ComposedSendHook = Readonly<{
        getCurrent: () => ReturnType<typeof useComposedTemporaryComputerSend>;
    }>;

    async function pressSend(hook: ComposedSendHook, settled: ReturnType<typeof vi.fn>) {
        await act(async () => {
            await hook.getCurrent().handleCreateSession({
                initialMessage: 'send',
                afterCreated: async () => undefined,
                onAfterCreatedSettled: settled,
                temporaryComputerSubmission: {
                    composer: composerSnapshot('Run the migration on a fresh computer'),
                    reviewComments: null,
                    attachmentDrafts: [],
                    attachmentDestination: {
                        uploadLocation: 'workspace',
                        workspaceRelativeDir: '.happier/attachments',
                        vcsIgnoreStrategy: 'none',
                        vcsIgnoreWritesEnabled: false,
                    },
                    maxFileBytes: 1_000_000,
                },
            });
        });
    }

    it('creates no activation, states the exact incompatibility and adds no generic failure alert', async () => {
        const create = vi.fn();
        const settled = vi.fn();
        const hook = await renderHook(() => useComposedTemporaryComputerSend({
            // The exact target-Account secret this reviewed Profile requires was
            // deleted between review and Send.
            currentProfile: reviewedProfile(),
            secrets: [],
            create,
        }));
        try {
            await pressSend(hook, settled);

            expect(create).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toBe('profile_environment_unavailable');
            // The launch surface already explains this exact selection and offers
            // Return to editing; a second generic "couldn't start" alert would
            // contradict it and hide the only recovery that works.
            expect(modalAlertSpy).not.toHaveBeenCalled();
            expect(settled).toHaveBeenCalledWith({ status: 'rejected' });

            await act(async () => { hook.getCurrent().dismissTerminal(); });
            expect(hook.getCurrent().status).toBe('idle');
        } finally {
            await hook.unmount();
        }
    });

    // The suppression above is specific, not a blanket removal: the incumbent
    // generic Send alert must still fire for a failure the user can retry.
    it('keeps the generic Send failure alert for a transient launch failure', async () => {
        const create = vi.fn();
        const settled = vi.fn();
        const hook = await renderHook(() => useComposedTemporaryComputerSend({
            currentProfile: reviewedProfile(),
            secrets: [],
            create,
            transientFailure: new RunnerActivationClientError('unavailable', 503, true),
        }));
        try {
            await pressSend(hook, settled);

            expect(hook.getCurrent().status).toBe('failed');
            expect(modalAlertSpy).toHaveBeenCalledTimes(1);
            expect(settled).toHaveBeenCalledWith({ status: 'rejected' });
        } finally {
            await hook.unmount();
        }
    });

    it('reports a changed reviewed Profile through the same Send path', async () => {
        const create = vi.fn();
        const settled = vi.fn();
        const hook = await renderHook(() => useComposedTemporaryComputerSend({
            currentProfile: reviewedProfile(2),
            secrets: [],
            create,
        }));
        try {
            await pressSend(hook, settled);

            expect(create).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toBe('profile_changed');
            expect(modalAlertSpy).not.toHaveBeenCalled();
            expect(settled).toHaveBeenCalledWith({ status: 'rejected' });
        } finally {
            await hook.unmount();
        }
    });
});
