import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import tweetnacl from 'tweetnacl';
import { AIBackendProfileSchema, type SavedSecret } from '@happier-dev/protocol';
import type { RunnerActivationProgressPhaseV1 } from '@happier-dev/protocol/ephemeralRunner/progress';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { signRunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { signRunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import { signRunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol/teams';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodeBase64 } from '@/encryption/base64';

import { createDeferred, renderHook } from '@/dev/testkit';
import {
    createRunnerActivationClient,
    RunnerActivationClientError,
    type RunnerActivationClient,
} from '@/sync/api/ephemeralRunner/runnerActivationClient';
import {
    isTemporaryComputerLaunchErrorRetryable,
    projectTemporaryComputerLaunchStatus,
    TemporaryComputerLaunchDependencyUnavailableError,
    useTemporaryComputerLaunch as useProductionTemporaryComputerLaunch,
} from './useTemporaryComputerLaunch';
import {
    assertLaunchProfileReviewCurrent,
    LaunchProfileEnvironmentUnavailableError,
    materializeLaunchProfileEnvironment,
} from '../modules/profileHelpers';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

// The mounted owner retains one API client per Home. Inline boundary fixtures
// would otherwise create a new client on every hook render and falsely retrigger
// the client's recovery effect until the worker exhausts its heap.
function useTemporaryComputerLaunch(
    input: Parameters<typeof useProductionTemporaryComputerLaunch>[0],
): ReturnType<typeof useProductionTemporaryComputerLaunch> {
    const client = React.useRef(input.client).current;
    return useProductionTemporaryComputerLaunch({ ...input, client });
}

const ACTIVATION_ID = '00000000-0000-4000-8000-000000000001';
// Runner commitments are canonical unpadded base64url digests, not hex.
const LAUNCH_MANIFEST_COMMITMENT = encodeBase64(new Uint8Array(32).fill(7), 'base64url');
const AUTHORING_COMMITMENT = encodeBase64(new Uint8Array(32).fill(3), 'base64url');

const activationKey = tweetnacl.sign.keyPair();
const installationKey = tweetnacl.sign.keyPair();
const runnerBoxKey = tweetnacl.box.keyPair();

const activationBinding: RunnerActivationBindingV1 = {
    activationId: ACTIVATION_ID,
    homeServerIdentityId: 'srv_runner',
    creatorAccountId: 'creator',
    creatorTokenEpoch: 1,
    activationExpiresAt: null,
    workspace: { kind: 'choose_on_endpoint' },
    sessionId: 'session-1',
    machineId: 'machine-1',
    activationSigningPublicKey: encodeBase64(activationKey.publicKey, 'base64url'),
    authoringCommitment: AUTHORING_COMMITMENT,
    artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
    endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'creator' },
};

const credentialSelectionBinding = {
    v: 1,
    resourceId: 'resource-1',
    brokerMachineId: 'broker-1',
    revision: 1,
    application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
    },
    sourceRevision: 'source-revision-1',
} as const;

const activationClaim = signRunnerClaimV1({
    payload: {
        v: 1,
        purpose: 'happier.ephemeral-session-runner.claim',
        binding: activationBinding,
        runnerBoxPublicKey: encodeBase64(runnerBoxKey.publicKey, 'base64url'),
        installation: {
            installationId: 'runner-installation',
            publicKey: encodeBase64(installationKey.publicKey, 'base64url'),
            proof: signMachineInstallationProof({
                payload: {
                    version: 1,
                    installationId: 'runner-installation',
                    machineId: activationBinding.machineId,
                    accountId: activationBinding.creatorAccountId,
                },
                privateKey: installationKey.secretKey,
            }),
        },
        protocolEpoch: 1,
    },
    activationSecretKey: activationKey.secretKey,
});

const reviewedActivation: NonNullable<RunnerActivationProjectionV1['review']> = {
    sealedLaunchManifest: 'sealed',
    authoringCommitment: AUTHORING_COMMITMENT,
    launchManifestCommitment: LAUNCH_MANIFEST_COMMITMENT,
    endpointFactsProof: {
        activationSignature: activationClaim.signature,
        installationSignature: activationClaim.signature,
    },
    agentTargetKey: 'agent:happier.agent.codex/codex',
    machineContentKeyBinding: null,
    credentialSelectionBinding,
    displayFacts: {
        v: 1,
        homeId: 'home-1',
        homeName: 'Alice’s Home',
        requesterId: 'creator',
        requesterName: 'Alice',
        teamId: 'team-1',
        teamName: 'Acme',
    },
};

/**
 * The exact reviewed readiness the endpoint signs. Materialization is gated on
 * this being present, so the fixture is the real signed document rather than a
 * stand-in that could not survive the canonical verifier.
 */
const reviewedReadiness: NonNullable<RunnerActivationProjectionV1['readiness']> = signRunnerReadinessV1({
    payload: {
        v: 1,
        purpose: 'happier.ephemeral-session-runner.readiness',
        claim: activationClaim.payload,
        launchManifestCommitment: LAUNCH_MANIFEST_COMMITMENT,
        installation: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            agentRuntimeId: 'codex',
            executablePath: '/runner/bin/codex',
            authoritativeVersion: null,
        },
        credentialSelectionBinding,
        brokerReadinessRequest: signRunnerBrokerReadinessRequestV1({
            facts: {
                v: 1,
                kind: 'provider_broker_readiness',
                homeServerIdentityId: activationBinding.homeServerIdentityId,
                activationId: ACTIVATION_ID,
                launchManifestCommitment: LAUNCH_MANIFEST_COMMITMENT,
                resourceId: credentialSelectionBinding.resourceId,
                agentTargetKey: credentialSelectionBinding.application.agentTargetKey,
                modelId: 'gpt-5',
                protocol: 'openai-responses',
                initiator: { installationId: 'runner-installation', endpointId: 'a'.repeat(64) },
                target: { machineId: credentialSelectionBinding.brokerMachineId, endpointId: 'b'.repeat(64) },
            },
            claim: activationClaim,
            activationSecretKey: activationKey.secretKey,
            installationSecretKey: installationKey.secretKey,
        }),
    },
    activationSecretKey: activationKey.secretKey,
    installationSecretKey: installationKey.secretKey,
});

const projection = (state: 'pending' | 'claimed' | 'consented' | 'materialized' | 'closed', options?: Readonly<{
    reviewed?: boolean;
    ready?: boolean;
    progressPhase?: RunnerActivationProgressPhaseV1 | null;
}>): RunnerActivationProjectionV1 => ({
    ...activationBinding,
    draftId: 'draft-a',
    state,
    closeReason: state === 'closed' ? 'canceled' : null,
    progressPhase: options?.progressPhase ?? null,
    claim: state === 'pending' ? null : activationClaim,
    endpointFacts: null,
    review: options?.reviewed ? reviewedActivation : null,
    consent: null,
    readiness: options?.ready ? reviewedReadiness : null,
    materialization: state === 'materialized' ? { sessionId: 'session-1', machineId: 'machine-1' } : null,
});

async function invokeHookActionAndCaptureError(action: () => Promise<void>): Promise<unknown> {
    let caught: unknown;
    await act(async () => {
        try {
            await action();
        } catch (error) {
            caught = error;
        }
    });
    return caught;
}

function beginHookAction(action: () => Promise<void>): Promise<void> {
    let pending!: Promise<void>;
    act(() => {
        pending = action();
    });
    return pending;
}

async function settleHookAction(pending: Promise<void>): Promise<void> {
    await act(async () => {
        await pending;
    });
}

describe('useTemporaryComputerLaunch', () => {
    it('derives every phase the projection already carries and reports only the endpoint-only one', () => {
        // The projection's own state/review/readiness decide four of the five
        // phases; the endpoint reports only what no durable fact can express.
        expect(projectTemporaryComputerLaunchStatus(projection('claimed'))).toBe('connected');
        expect(projectTemporaryComputerLaunchStatus(projection('claimed', { progressPhase: 'checking_ai_access' }))).toBe('connected');
        expect(projectTemporaryComputerLaunchStatus(projection('claimed', { reviewed: true }))).toBe('waiting_for_approval');
        expect(projectTemporaryComputerLaunchStatus(projection('consented'))).toBe('installing_agent');
        expect(projectTemporaryComputerLaunchStatus(projection('consented', { progressPhase: 'checking_ai_access' }))).toBe('checking_ai_access');
        expect(projectTemporaryComputerLaunchStatus(projection('consented', { ready: true }))).toBe('creating_session');
        // A readied endpoint is creating the Session; a stale reported phase
        // must not drag the surface back to an earlier step.
        expect(projectTemporaryComputerLaunchStatus(
            projection('consented', { ready: true, progressPhase: 'checking_ai_access' }),
        )).toBe('creating_session');
    });

    it('fails a launch attempt visibly when activation dependencies are unavailable', async () => {
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: null,
            draftId: 'draft-unavailable',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
        }));

        await expect(invokeHookActionAndCaptureError(() => hook.getCurrent().start())).resolves.toMatchObject({
            name: 'TemporaryComputerLaunchDependencyUnavailableError',
            dependency: 'activation',
        } satisfies Partial<TemporaryComputerLaunchDependencyUnavailableError>);
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().error).toBeInstanceOf(TemporaryComputerLaunchDependencyUnavailableError);
    });

    it('aborts preparation and returns to the preserved draft when canceled', async () => {
        const preparationSignals: AbortSignal[] = [];
        const onAbandoned = vi.fn(async () => undefined);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: {
                readByDraft: vi.fn(async () => { throw new RunnerActivationClientError('not_found', 404, false); }),
            } as unknown as RunnerActivationClient,
            draftId: 'draft-preparing',
            existingPublicRef: null,
            prepareActivation: vi.fn(async (signal: AbortSignal) => {
                preparationSignals.push(signal);
                await new Promise<never>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
                throw new Error('unreachable');
            }),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
            onAbandoned,
        }));

        const starting = beginHookAction(() => hook.getCurrent().start());
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('preparing'));
        await act(async () => { await hook.getCurrent().cancel(); });
        await settleHookAction(starting);

        expect(preparationSignals[0]?.aborted).toBe(true);
        expect(onAbandoned).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().status).toBe('idle');
    });

    it('cancels an in-flight safe projection read when the mounted creator goes away', async () => {
        const observedSignals: (AbortSignal | undefined)[] = [];
        const readByDraft = vi.fn(async (_draftId: string, signal?: AbortSignal) => {
            observedSignals.push(signal);
            return await new Promise<ReturnType<typeof projection>>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft } as unknown as RunnerActivationClient,
            draftId: 'draft-refresh-signal',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
        }));
        await vi.waitFor(() => expect(observedSignals).toHaveLength(1));
        expect(observedSignals[0]?.aborted).toBe(false);

        await hook.unmount();

        expect(observedSignals[0]?.aborted).toBe(true);
        // A canceled observation is not a failed launch attempt.
        expect(hook.getCurrent().status).toBe('idle');
        expect(hook.getCurrent().error).toBeNull();
    });

    it('recovers and closes a live activation even when cancel arrives during the reconciliation read', async () => {
        const recovered: RunnerActivationProjectionV1 = { ...projection('pending'), activationId: 'activation-reconciled' };
        const closed: RunnerActivationProjectionV1 = { ...projection('closed'), activationId: 'activation-reconciled' };
        const reconciliationSignals: (AbortSignal | undefined)[] = [];
        const readByDraft = vi.fn<(draftId: string, signal?: AbortSignal) => Promise<ReturnType<typeof projection>>>()
            // The mounted observation read.
            .mockImplementationOnce(async () => { throw new RunnerActivationClientError('not_found', 404, false); })
            // The reconciliation read taken by `start`.
            .mockImplementationOnce(async (_draftId, signal) => {
                reconciliationSignals.push(signal);
                return recovered;
            });
        const cancel = vi.fn(async () => closed);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft, cancel } as unknown as RunnerActivationClient,
            draftId: 'draft-reconcile-cancel',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
            onClosed: vi.fn(async () => undefined),
        }));
        await vi.waitFor(() => expect(readByDraft).toHaveBeenCalledTimes(1));

        const starting = beginHookAction(() => hook.getCurrent().start());
        await act(async () => { await hook.getCurrent().cancel(); });
        await settleHookAction(starting);

        // The reconciliation read is deliberately not signal-bound: aborting it
        // would settle the attempt to idle while the package stayed open.
        expect(reconciliationSignals).toEqual([undefined]);
        expect(cancel).toHaveBeenCalledWith('activation-reconciled');
    });

    it('finishes an in-flight activation create and immediately closes the exact activation when cancel was requested', async () => {
        let resolveCreate: ((value: ReturnType<typeof projection>) => void) | null = null;
        const created: RunnerActivationProjectionV1 = {
            ...projection('pending'),
            activationId: 'activation-created-during-cancel',
        };
        const canceled: RunnerActivationProjectionV1 = {
            ...projection('closed'),
            activationId: 'activation-created-during-cancel',
            closeReason: 'canceled',
        };
        const create = vi.fn(async () => await new Promise<ReturnType<typeof projection>>((resolve) => {
            resolveCreate = resolve;
        }));
        const cancel = vi.fn(async () => canceled);
        const persistPublicRef = vi.fn();
        const onClosed = vi.fn(async () => undefined);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: {
                readByDraft: vi.fn(async () => { throw new RunnerActivationClientError('not_found', 404, false); }),
                create,
                cancel,
            } as unknown as RunnerActivationClient,
            draftId: 'draft-create-race',
            existingPublicRef: null,
            prepareActivation: vi.fn(async () => ({
                request: {} as never,
                createdOnDeviceLabel: 'This device',
            })),
            persistPublicRef,
            onMaterialized: vi.fn(),
            onClosed,
        }));

        const starting = beginHookAction(() => hook.getCurrent().start());
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        await act(async () => { await hook.getCurrent().cancel(); });
        expect(hook.getCurrent().status).toBe('canceling');
        await act(async () => { resolveCreate?.(created); });
        await settleHookAction(starting);

        expect(persistPublicRef).toHaveBeenCalledWith(expect.objectContaining({
            activationId: 'activation-created-during-cancel',
        }));
        expect(cancel).toHaveBeenCalledWith('activation-created-during-cancel');
        await vi.waitFor(() => expect(onClosed).toHaveBeenCalledWith(canceled));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('failed'));
    });

    it('closes an activation recovered after cancel was requested during the recovery read', async () => {
        let resolveRecovery: ((value: ReturnType<typeof projection>) => void) | null = null;
        const recovered: RunnerActivationProjectionV1 = { ...projection('pending'), activationId: 'activation-recovered-during-cancel' };
        const closed: RunnerActivationProjectionV1 = { ...projection('closed'), activationId: 'activation-recovered-during-cancel' };
        const readByDraft = vi.fn()
            .mockRejectedValueOnce(new RunnerActivationClientError('not_found', 404, false))
            .mockImplementationOnce(async () => await new Promise<ReturnType<typeof projection>>((resolve) => {
                resolveRecovery = resolve;
            }));
        const cancel = vi.fn(async () => closed);
        const client = { readByDraft, cancel } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-recovery-cancel',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
            onClosed: vi.fn(async () => undefined),
        }));
        await vi.waitFor(() => expect(readByDraft).toHaveBeenCalledTimes(1));

        const starting = beginHookAction(() => hook.getCurrent().start());
        await vi.waitFor(() => expect(readByDraft).toHaveBeenCalledTimes(2));
        await act(async () => { await hook.getCurrent().cancel(); });
        await act(async () => { resolveRecovery?.(recovered); });
        await settleHookAction(starting);

        expect(cancel).toHaveBeenCalledWith('activation-recovered-during-cancel');
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('failed'));
    });

    it('keeps acknowledged closure visible and retries local cleanup after a cleanup failure', async () => {
        const closed: RunnerActivationProjectionV1 = { ...projection('closed'), activationId: 'activation-closed-cleanup-retry' };
        const onClosed = vi.fn()
            .mockRejectedValueOnce(new Error('custody busy'))
            .mockResolvedValueOnce(undefined);
        const readByDraft = vi.fn(async () => closed);
        const client = { readByDraft } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-closed-cleanup', existingPublicRef: null,
            prepareActivation: vi.fn(), persistPublicRef: vi.fn(), onMaterialized: vi.fn(), onClosed,
        }));

        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('cancel_failed'));
        expect(hook.getCurrent().projection?.state).toBe('closed');
        await act(async () => { await hook.getCurrent().retry(); });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(onClosed).toHaveBeenCalledTimes(2);
    });

    it('projects each server lifecycle state to creator copy', () => {
        expect(projectTemporaryComputerLaunchStatus(projection('pending'))).toBe('waiting_for_computer');
        expect(projectTemporaryComputerLaunchStatus(projection('claimed'))).toBe('connected');
        expect(projectTemporaryComputerLaunchStatus(projection('claimed', { reviewed: true }))).toBe('waiting_for_approval');
        expect(projectTemporaryComputerLaunchStatus(projection('consented'))).toBe('installing_agent');
        expect(projectTemporaryComputerLaunchStatus(projection('materialized'))).toBe('succeeded');
        expect(projectTemporaryComputerLaunchStatus(projection('closed'))).toBe('failed');
    });

    it('reopens a public draft reference and retains an offline cancellation failure', async () => {
        const read = vi.fn(async () => projection('pending'));
        const cancel = vi.fn(async () => { throw new Error('offline'); });
        const client = { read, cancel } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-1',
            existingPublicRef: { v: 1, activationId: '00000000-0000-4000-8000-000000000001', createdOnDeviceLabel: 'This device' },
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
        }));
        expect(read).toHaveBeenCalledWith(
            '00000000-0000-4000-8000-000000000001',
            expect.any(AbortSignal),
        );
        expect(hook.getCurrent().status).toBe('waiting_for_computer');
        await act(async () => { await hook.getCurrent().cancel(); });
        expect(hook.getCurrent().status).toBe('cancel_failed');
        expect(hook.getCurrent().projection).not.toBeNull();
    });

    it('resumes review preparation after reloading a claimed activation without showing review unavailable', async () => {
        const claimed = projection('claimed');
        const prepareReview = vi.fn(async () => await new Promise<never>(() => undefined));
        const client = { read: vi.fn(async () => claimed) } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-claimed-reload',
            existingPublicRef: {
                v: 1,
                activationId: '00000000-0000-4000-8000-000000000001',
                createdOnDeviceLabel: 'This device',
            },
            prepareActivation: vi.fn(),
            prepareReview,
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(prepareReview).toHaveBeenCalledWith(claimed, expect.any(AbortSignal)));
        expect(hook.getCurrent().status).toBe('preparing_encryption');
        expect(hook.getCurrent().error).toBeNull();
    });

    it('recovers an activation by draft without creating a duplicate and completes it once', async () => {
        const materialized = projection('materialized');
        const readByDraft = vi.fn(async () => materialized);
        const create = vi.fn();
        const onMaterialized = vi.fn();
        const client = { readByDraft, create } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-recover',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized,
        }));

        expect(readByDraft).toHaveBeenCalledWith('draft-recover', expect.any(AbortSignal));
        expect(create).not.toHaveBeenCalled();
        expect(onMaterialized).toHaveBeenCalledTimes(1);
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(onMaterialized).toHaveBeenCalledTimes(1);
    });

    it('retains a materialized activation for retry when creator-side first-input completion fails', async () => {
        const materialized = projection('materialized');
        const onMaterialized = vi.fn()
            .mockRejectedValueOnce(new Error('digest mismatch'))
            .mockResolvedValueOnce(undefined);
        const client = { readByDraft: vi.fn(async () => materialized) } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-materialized',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized,
        }));

        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().projection?.state).toBe('materialized');
        await act(async () => { await hook.getCurrent().retry(); });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('succeeded'));
        expect(onMaterialized).toHaveBeenCalledTimes(2);
    });

    it('publishes the exact creator review when the endpoint claim is ready', async () => {
        const claimed = projection('claimed');
        const reviewed = projection('claimed', { reviewed: true });
        const prepareReview = vi.fn(async () => undefined);
        const readByDraft = vi.fn()
            .mockResolvedValueOnce(claimed)
            .mockResolvedValueOnce(reviewed);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft } as unknown as RunnerActivationClient,
            draftId: 'draft-review',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            prepareReview,
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(prepareReview).toHaveBeenCalledWith(claimed, expect.any(AbortSignal)));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('waiting_for_approval'));
        expect(readByDraft).toHaveBeenCalledTimes(2);
    });

    it('keeps one live review producer when an identical projection is refetched mid-review', async () => {
        // Real activation client; only the Home HTTP boundary is held open so the
        // review's first safe request is still pending when the refetch lands.
        const claimed = projection('claimed');
        const reviewSignals: AbortSignal[] = [];
        const client = createRunnerActivationClient(async (path, init) => {
            if (path.includes('credential-selection')) {
                const signal = init?.signal;
                if (!signal) throw new Error('Expected a cancellable review request');
                reviewSignals.push(signal);
                return await new Promise<Response>((_, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            return Response.json(claimed);
        });
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-a',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            prepareReview: async (current, signal) => {
                await client.resolveCredentialSelection(current.activationId, {
                    v: 1,
                    selection: {
                        kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                        expectedResourceRevision: 1, agentTargetKey: 'agent:happier.agent.codex/codex',
                        modelId: 'gpt-5', deliveryMode: 'brokered',
                    },
                    application: {
                        agentTargetKey: 'agent:happier.agent.codex/codex',
                        implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                        endpointTemplateId: 'responses', protocol: 'openai_responses',
                    },
                    sourceRevision: 'source-1',
                    plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
                }, signal);
            },
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(reviewSignals).toHaveLength(1));
        await act(async () => { await hook.getCurrent().refresh(); });

        // The claimed, unreviewed activation still has a live producer.
        expect(reviewSignals.some((signal) => !signal.aborted)).toBe(true);
        expect(hook.getCurrent().status).toBe('preparing_encryption');
        await hook.unmount();
    });

    it('retires creator signing-key custody once for a published creator proof', async () => {
        const claimed = projection('claimed', { reviewed: true });
        const onClaimed = vi.fn(async () => undefined);
        const readByDraft = vi.fn(async () => claimed);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft } as unknown as RunnerActivationClient,
            draftId: 'draft-claimed-custody',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onClaimed,
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledWith(claimed));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(onClaimed).toHaveBeenCalledTimes(1);
    });

    it('prepares the e2ee review while creator signing custody is still retained, then retires it', async () => {
        // The e2ee review signs the scoped Machine content key with the
        // activation signing identity, so a review prepared after retirement
        // fails closed at `runner_activation_signing_custody_unavailable`.
        const claimed = projection('claimed');
        const reviewed = projection('claimed', { reviewed: true });
        let custodyRetired = false;
        let reviewPublished = false;
        const reviewPublication = createDeferred<void>();
        const onClaimed = vi.fn(async () => { custodyRetired = true; });
        const prepareReview = vi.fn(async () => {
            if (custodyRetired) throw new Error('runner_activation_signing_custody_unavailable');
            await reviewPublication.promise;
            reviewPublished = true;
        });
        // The published review only becomes visible once the creator proof lands.
        const readByDraft = vi.fn(async () => (reviewPublished ? reviewed : claimed));
        await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft } as unknown as RunnerActivationClient,
            draftId: 'draft-claim-retirement',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onClaimed,
            prepareReview,
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(prepareReview).toHaveBeenCalledWith(claimed, expect.any(AbortSignal)));
        // Still signing: the key the proof needs must not have been retired.
        expect(onClaimed).not.toHaveBeenCalled();
        await act(async () => reviewPublication.resolve());
        await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledWith(reviewed));
    });

    it('retries a failed custody retirement without losing the published proof', async () => {
        const reviewed = projection('claimed', { reviewed: true });
        const retirement = createDeferred<void>();
        const onClaimed = vi.fn()
            .mockImplementationOnce(async () => retirement.promise)
            .mockResolvedValueOnce(undefined);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft: vi.fn(async () => reviewed) } as unknown as RunnerActivationClient,
            draftId: 'draft-claim-retirement-retry',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onClaimed,
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
        await act(async () => retirement.reject(new Error('secure storage busy')));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('failed'));

        await act(async () => { await hook.getCurrent().retry(); });
        await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('waiting_for_approval'));
    });

    it('does not materialize until claim custody retirement succeeds', async () => {
        const consented = projection('consented', { reviewed: true, ready: true });
        const retirement = createDeferred<void>();
        const onClaimed = vi.fn(async () => retirement.promise);
        const materialize = vi.fn(async () => await new Promise<never>(() => undefined));
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft: vi.fn(async () => consented) } as unknown as RunnerActivationClient,
            draftId: 'draft-materialization-custody-retirement',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onClaimed,
            materialize,
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
        expect(materialize).not.toHaveBeenCalled();
        await act(async () => retirement.resolve());
        await vi.waitFor(() => expect(materialize).toHaveBeenCalledWith(consented));
    });

    it('materializes only after exact reviewed readiness is present', async () => {
        const consented = projection('consented', { reviewed: true, ready: true });
        const materialized = projection('materialized');
        const materialize = vi.fn(async () => ({
            status: 'materialized',
            result: {
                v: 1,
                activationId: '00000000-0000-4000-8000-000000000001',
                sessionId: 'session-1',
                machineId: 'machine-1',
            },
        } as const));
        const readByDraft = vi.fn()
            .mockResolvedValueOnce(consented)
            .mockResolvedValueOnce(materialized);
        const onMaterialized = vi.fn(async () => undefined);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft } as unknown as RunnerActivationClient,
            draftId: 'draft-materialize',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            materialize,
            onMaterialized,
        }));

        await vi.waitFor(() => expect(materialize).toHaveBeenCalledWith(consented));
        await vi.waitFor(() => expect(onMaterialized).toHaveBeenCalledWith('session-1', materialized));
        expect(readByDraft).toHaveBeenCalledTimes(2);
    });

    it('does not retry a definitive materialization conflict as a transient transport failure', async () => {
        const consented = projection('consented', { reviewed: true, ready: true });
        const materialize = vi.fn(async () => ({ status: 'conflict', reason: 'manifest_mismatch' } as const));
        const readByDraft = vi.fn(async () => consented);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft } as unknown as RunnerActivationClient,
            draftId: 'draft-materialization-conflict',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            materialize,
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(materialize).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().error).toMatchObject({
            name: 'TemporaryComputerMaterializationResultError',
            status: 'conflict',
            reason: 'manifest_mismatch',
            retryable: false,
        });
        await act(async () => { await hook.getCurrent().retry(); });
        expect(materialize).toHaveBeenCalledTimes(1);
    });

    it('reconciles a terminal materialization result through the canonical activation projection', async () => {
        const consented = projection('consented', { reviewed: true, ready: true });
        const closed: RunnerActivationProjectionV1 = { ...projection('closed'), closeReason: 'expired' };
        const readByDraft = vi.fn()
            .mockResolvedValueOnce(consented)
            .mockResolvedValueOnce(closed);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft } as unknown as RunnerActivationClient,
            draftId: 'draft-materialization-closed',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            materialize: vi.fn(async () => ({ status: 'unavailable', reason: 'activation_expired' } as const)),
            onMaterialized: vi.fn(),
        }));

        await vi.waitFor(() => expect(hook.getCurrent().projection).toBe(closed));
        expect(readByDraft).toHaveBeenCalledTimes(2);
    });

    it('fails closed at typed dependency states without fabricating review or materialization input', async () => {
        const claimed = projection('claimed');
        const claimedHook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft: vi.fn(async () => claimed) } as unknown as RunnerActivationClient,
            draftId: 'draft-missing-review-dependency', existingPublicRef: null,
            prepareActivation: vi.fn(), persistPublicRef: vi.fn(), onMaterialized: vi.fn(),
        }));
        expect(claimedHook.getCurrent().status).toBe('review_unavailable');

        const consented = projection('consented', { reviewed: true, ready: true });
        const consentedHook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: { readByDraft: vi.fn(async () => consented) } as unknown as RunnerActivationClient,
            draftId: 'draft-missing-materialization-dependency', existingPublicRef: null,
            prepareActivation: vi.fn(), persistPublicRef: vi.fn(), onMaterialized: vi.fn(),
        }));
        expect(consentedHook.getCurrent().status).toBe('materialization_unavailable');
    });

    it('clears local/public custody only after acknowledged cancellation', async () => {
        const canceled: RunnerActivationProjectionV1 = { ...projection('closed'), closeReason: 'canceled' };
        const onClosed = vi.fn(async () => undefined);
        const client = {
            read: vi.fn(async () => projection('pending')),
            cancel: vi.fn(async () => canceled),
        } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-cancel',
            existingPublicRef: { v: 1, activationId: '00000000-0000-4000-8000-000000000001', createdOnDeviceLabel: 'This device' },
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
            onClosed,
        }));

        await act(async () => { await hook.getCurrent().cancel(); });
        expect(onClosed).toHaveBeenCalledWith(canceled);
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            status: 'failed',
            projection: canceled,
            error: { name: 'TemporaryComputerActivationClosedError', reason: 'canceled' },
        }));
        await act(async () => { hook.getCurrent().dismissTerminal(); });
        expect(hook.getCurrent().status).toBe('idle');
    });

    it('abandons pre-activation custody only for a definitive setup failure', async () => {
        const onAbandoned = vi.fn(async () => undefined);
        const definitive = new RunnerActivationClientError('malformed_request', 400, false);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: {
                readByDraft: vi.fn(async () => { throw new RunnerActivationClientError('not_found', 404, false); }),
            } as unknown as RunnerActivationClient,
            draftId: 'draft-definitive-setup-failure',
            existingPublicRef: null,
            prepareActivation: vi.fn(async () => { throw definitive; }),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
            onAbandoned,
        }));

        await expect(invokeHookActionAndCaptureError(() => hook.getCurrent().start())).resolves.toBe(definitive);
        expect(onAbandoned).toHaveBeenCalledOnce();
        expect(hook.getCurrent().status).toBe('failed');

        const retryableAbandon = vi.fn(async () => undefined);
        const retryable = new RunnerActivationClientError('unavailable', 503, true);
        const retryableHook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: {
                readByDraft: vi.fn(async () => { throw new RunnerActivationClientError('not_found', 404, false); }),
            } as unknown as RunnerActivationClient,
            draftId: 'draft-retryable-setup-failure',
            existingPublicRef: null,
            prepareActivation: vi.fn(async () => { throw retryable; }),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
            onAbandoned: retryableAbandon,
        }));

        await expect(invokeHookActionAndCaptureError(() => retryableHook.getCurrent().start())).resolves.toBe(retryable);
        expect(retryableAbandon).not.toHaveBeenCalled();
        expect(retryableHook.getCurrent().status).toBe('failed');
    });

    it('keeps a failed pre-activation cleanup frozen and retryable', async () => {
        const cleanupFailure = new Error('creator custody busy');
        const onAbandoned = vi.fn(async () => undefined);
        const pending = projection('pending');
        const create = vi.fn()
            .mockRejectedValueOnce(new RunnerActivationClientError('malformed_request', 400, false))
            .mockResolvedValueOnce(pending);
        const prepared = {
            request: {} as never,
            createdOnDeviceLabel: 'This device',
            discard: vi.fn(async () => { throw cleanupFailure; }),
        };
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client: {
                readByDraft: vi.fn(async () => { throw new RunnerActivationClientError('not_found', 404, false); }),
                create,
            } as unknown as RunnerActivationClient,
            draftId: 'draft-cleanup-failure',
            existingPublicRef: null,
            prepareActivation: vi.fn(async () => prepared),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
            onAbandoned,
        }));

        await expect(invokeHookActionAndCaptureError(() => hook.getCurrent().start())).resolves.toBe(cleanupFailure);
        expect(onAbandoned).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toMatchObject({ status: 'failed', error: cleanupFailure });

        await act(async () => { await hook.getCurrent().retry(); });
        expect(create).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().status).toBe('waiting_for_computer');
    });

    it('creates a new package for the same draft only after its closed outcome is dismissed', async () => {
        const closed: RunnerActivationProjectionV1 = { ...projection('closed'), closeReason: 'declined' };
        const pending = projection('pending');
        const client = {
            readByDraft: vi.fn(async () => closed),
            create: vi.fn(async () => pending),
        } as unknown as RunnerActivationClient;
        const prepared = {
            request: { v: 1 },
            createdOnDeviceLabel: 'This device',
        } as never;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1', client, draftId: 'draft-new-package', existingPublicRef: null,
            prepareActivation: vi.fn(async () => prepared), persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(), onClosed: vi.fn(async () => undefined),
        }));

        await vi.waitFor(() => expect(hook.getCurrent().projection).toBe(closed));
        await act(async () => { hook.getCurrent().dismissTerminal(); });
        await act(async () => { await hook.getCurrent().start(); });
        expect(client.create).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().projection).toBe(pending);
    });

    it('replaces an acknowledged terminal activation through the one submission owner', async () => {
        const closed: RunnerActivationProjectionV1 = { ...projection('closed'), closeReason: 'revoked' };
        const pending = projection('pending');
        const client = {
            readByDraft: vi.fn(async () => closed),
            create: vi.fn(async () => pending),
        } as unknown as RunnerActivationClient;
        // A replacement package needs a fresh submission and its settlement, and
        // only the composer's Send owner can allocate those. Starting the
        // controller directly reuses custody the closure already released, so
        // the advertised action could never succeed.
        const requestReplacementLaunch = vi.fn(async () => undefined);
        const prepareActivation = vi.fn(async () => ({ request: { v: 1 }, createdOnDeviceLabel: 'This device' }) as never);
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1', client, draftId: 'draft-replacement', existingPublicRef: null,
            prepareActivation,
            requestReplacementLaunch,
            persistPublicRef: vi.fn(), onMaterialized: vi.fn(), onClosed: vi.fn(async () => undefined),
        }));

        await vi.waitFor(() => expect(hook.getCurrent().projection).toBe(closed));
        await act(async () => { await hook.getCurrent().replaceTerminal(); });

        expect(requestReplacementLaunch).toHaveBeenCalledTimes(1);
        expect(prepareActivation).not.toHaveBeenCalled();
        expect(client.create).not.toHaveBeenCalled();
        expect(hook.getCurrent().projection).toBeNull();
    });

    // A frozen submission that names a Profile the target Account no longer
    // resolves cannot succeed by being sent again. The creator preflight already
    // refuses it; these cases pin the recovery the user is actually offered.
    describe('deterministic Profile preflight incompatibility', () => {
        // The schema stamps `createdAt`/`updatedAt` from the clock by default, so
        // both are pinned here: only `updatedAt` may differ, and only when the
        // case under test means the Account's Profile record actually changed.
        const reviewedProfile = (updatedAt = 1) => AIBackendProfileSchema.parse({
            id: 'work',
            name: 'Work',
            environmentVariables: [{ name: 'PROFILE_MODE', value: 'reviewed' }],
            envVarRequirements: [{ name: 'RUNNER_PROFILE_TOKEN', required: true, kind: 'secret' }],
            createdAt: 0,
            updatedAt,
        });

        /**
         * The exact creator preflight the mounted New Session model runs inside
         * `prepareActivation`: the reviewed Profile is re-resolved against the
         * target Account's current Profile record and current secrets, so both
         * failures below are produced by the real canonical owners rather than
         * by a stand-in error.
         */
        function prepareActivationAgainstTargetAccount(input: Readonly<{
            currentProfile: AIBackendProfile | null;
            secrets: readonly SavedSecret[];
        }>) {
            return vi.fn(async () => {
                const currentProfile = input.currentProfile;
                assertLaunchProfileReviewCurrent(reviewedProfile(), currentProfile);
                const materialized = materializeLaunchProfileEnvironment({
                    profile: currentProfile,
                    selectedAgentProviderOwnedEnvironmentKeys: [],
                    secrets: input.secrets,
                    resolveSavedSecretReference: (ref) => resolveSavedSecretReference(null, input.secrets, ref),
                    selectedSecretIds: { RUNNER_PROFILE_TOKEN: 'secret-work' },
                    machineEnvReadyByName: { RUNNER_PROFILE_TOKEN: false },
                    decryptSecretValue: (value) => value?.value ?? null,
                });
                if (!materialized.ok) throw new LaunchProfileEnvironmentUnavailableError(materialized.reason);
                throw new Error('unreachable: the preflight must reject before activation creation');
            });
        }

        async function renderPreflight(input: Readonly<{
            draftId: string;
            currentProfile: AIBackendProfile | null;
            secrets: readonly SavedSecret[];
        }>) {
            const create = vi.fn();
            const readByDraft = vi.fn(async () => { throw new RunnerActivationClientError('not_found', 404, false); });
            const onAbandoned = vi.fn(async () => undefined);
            const prepareActivation = prepareActivationAgainstTargetAccount(input);
            const hook = await renderHook(() => useTemporaryComputerLaunch({
                serverId: 'server-1',
                client: { readByDraft, create } as unknown as RunnerActivationClient,
                draftId: input.draftId,
                existingPublicRef: null,
                prepareActivation,
                persistPublicRef: vi.fn(),
                onMaterialized: vi.fn(),
                onAbandoned,
            }));
            await vi.waitFor(() => expect(readByDraft).toHaveBeenCalled());
            return { hook, create, prepareActivation, onAbandoned };
        }

        it('refuses the launch, explains it and restores editing when a reviewed Profile secret is gone', async () => {
            const { hook, create, prepareActivation, onAbandoned } = await renderPreflight({
                draftId: 'draft-profile-secret-removed',
                currentProfile: reviewedProfile(),
                // The exact target-Account secret was deleted after review.
                secrets: [],
            });

            // The launch owner presents this outcome with its own recovery, so
            // the Send caller is not handed an unhandled failure to re-report.
            await expect(invokeHookActionAndCaptureError(() => hook.getCurrent().start())).resolves.toBeUndefined();

            expect(create).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toBe('profile_environment_unavailable');
            expect(hook.getCurrent().error).toMatchObject({ code: 'runner_profile_environment_unavailable' });
            expect(isTemporaryComputerLaunchErrorRetryable(hook.getCurrent().error)).toBe(false);
            // Local custody is abandoned and the ordinary draft is unfrozen.
            expect(onAbandoned).toHaveBeenCalledTimes(1);

            // Retrying the same frozen submission would deterministically repeat
            // the same answer, so the controller refuses it outright.
            await act(async () => { await hook.getCurrent().retry(); });
            expect(prepareActivation).toHaveBeenCalledTimes(1);
            expect(create).not.toHaveBeenCalled();

            await act(async () => { hook.getCurrent().dismissTerminal(); });
            expect(hook.getCurrent().status).toBe('idle');
            expect(hook.getCurrent().error).toBeNull();
            await hook.unmount();
        });

        it('separates a changed or deleted reviewed Profile from a missing secret', async () => {
            const changed = await renderPreflight({
                draftId: 'draft-profile-changed',
                currentProfile: reviewedProfile(2),
                secrets: [],
            });
            await expect(invokeHookActionAndCaptureError(() => changed.hook.getCurrent().start())).resolves.toBeUndefined();
            expect(changed.create).not.toHaveBeenCalled();
            expect(changed.hook.getCurrent().status).toBe('profile_changed');
            expect(changed.hook.getCurrent().error).toMatchObject({ code: 'runner_profile_selection_changed' });
            await act(async () => { changed.hook.getCurrent().dismissTerminal(); });
            expect(changed.hook.getCurrent().status).toBe('idle');
            await changed.hook.unmount();

            const deleted = await renderPreflight({
                draftId: 'draft-profile-deleted',
                currentProfile: null,
                secrets: [],
            });
            await expect(invokeHookActionAndCaptureError(() => deleted.hook.getCurrent().start())).resolves.toBeUndefined();
            expect(deleted.create).not.toHaveBeenCalled();
            expect(deleted.hook.getCurrent().status).toBe('profile_changed');
            await deleted.hook.unmount();
        });
    });

    it('retains a closed server projection for read-only waiting-draft consumers', async () => {
        const closed: RunnerActivationProjectionV1 = { ...projection('closed'), activationId: 'activation-closed', closeReason: 'canceled' };
        const client = { readByDraft: vi.fn(async () => closed) } as unknown as RunnerActivationClient;
        const hook = await renderHook(() => useTemporaryComputerLaunch({
            serverId: 'server-1',
            client,
            draftId: 'draft-closed',
            existingPublicRef: null,
            prepareActivation: vi.fn(),
            persistPublicRef: vi.fn(),
            onMaterialized: vi.fn(),
        }));

        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().projection).toBe(closed);
    });
});
