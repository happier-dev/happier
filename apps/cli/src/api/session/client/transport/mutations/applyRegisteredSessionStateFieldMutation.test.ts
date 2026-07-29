import { describe, expect, it } from 'vitest';

import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { deterministicStringify } from '@/utils/deterministicJson';
import { applyRegisteredSessionStateFieldMutationToMetadata } from './applyRegisteredSessionStateFieldMutation';
import type { RegisteredSessionStateFieldMutationV1 } from './sessionClientDurableMutationTypes';

const runtimeState = {
    v: 1,
    sessionId: 'sess-1',
    machineId: 'machine-1',
    daemonId: 'daemon-1',
    observedAtMs: 100,
    runner: {
        pid: 4242,
        runtimeId: 'version:1.2.3',
        cliVersion: '1.2.3',
        entrypointVersion: '1.2.3',
        processCommandHash: 'hash-1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
    },
    daemon: {
        cliVersion: '1.2.4',
        startedWithCliVersion: '1.2.4',
        currentEntrypointVersion: 'version:1.2.4',
        currentEntrypointSource: 'launch_spec',
    },
    versionState: 'stale',
    statusSource: 'process_command_inferred',
    plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
    },
} as const;

const runtimeActivityProjection = {
    state: 'active',
    activeCount: 1,
} as const;

function mutation(
    op: RegisteredSessionStateFieldMutationV1['op'],
    fieldId: RegisteredSessionStateFieldMutationV1['fieldId'] = 'runtime.sessionRunner',
): RegisteredSessionStateFieldMutationV1 {
    return {
        v: 1,
        sessionId: 'sess-1',
        mutationId: 'mutation-1',
        fieldId,
        deliveryClass: 'durable_best_effort',
        op,
        source: 'daemon',
        observedAt: 100,
    };
}

const baseMetadata: Metadata = {
    path: '/tmp/project',
    host: 'localhost',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happier',
    happyLibDir: '/tmp/.happier/lib',
    happyToolsDir: '/tmp/.happier/tools',
};

describe('applyRegisteredSessionStateFieldMutationToMetadata', () => {
    it('applies canonical display-title mutations through the shared metadata binding', () => {
        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            baseMetadata,
            mutation({ kind: 'set', value: { title: 'Unified title', updatedAt: 123 } }, 'display.title'),
        )).toEqual({
            ...baseMetadata,
            summary: {
                text: 'Unified title',
                updatedAt: 123,
            },
        });

        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            {
                ...baseMetadata,
                summary: {
                    text: 'Unified title',
                    updatedAt: 123,
                },
            },
            mutation({ kind: 'clear' }, 'display.title'),
        )).toEqual(baseMetadata);
    });

    it('applies and clears session-runner runtime state mutations', () => {
        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            baseMetadata,
            mutation({ kind: 'set', value: runtimeState }),
        )).toEqual({
            ...baseMetadata,
            [SESSION_RUNNER_RUNTIME_METADATA_KEY]: runtimeState,
        });

        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            {
                ...baseMetadata,
                [SESSION_RUNNER_RUNTIME_METADATA_KEY]: runtimeState,
            },
            mutation({ kind: 'clear' }),
        )).toEqual(baseMetadata);
    });

    it('applies and clears runtime activity projection mutations through the shared metadata binding', () => {
        const metadataWithRuntimeActivity: Metadata & Record<string, unknown> = {
            ...baseMetadata,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        };

        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            baseMetadata,
            mutation({ kind: 'set', value: runtimeActivityProjection }, 'runtime.activity'),
        )).toEqual(metadataWithRuntimeActivity);

        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            metadataWithRuntimeActivity,
            mutation({ kind: 'clear' }, 'runtime.activity'),
        )).toEqual(baseMetadata);
    });

    it('keeps newer terminal usage-limit recovery state when a stale registered mutation arrives', () => {
        const terminal = {
            v: 1 as const,
            status: 'cancelled' as const,
            issueFingerprint: 'usage-limit:codex:turn-1',
            armedAtMs: 100,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 3,
            maxAttempts: 4,
            lastProbeError: null,
            resumePromptMode: 'standard' as const,
            selectedAuth: { kind: 'native' as const },
        };
        const staleWaiting = {
            ...terminal,
            status: 'waiting' as const,
            nextCheckAtMs: 200,
            attemptCount: 1,
        };

        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            { ...baseMetadata, sessionUsageLimitRecoveryV1: terminal },
            mutation({ kind: 'set', value: staleWaiting }, 'runtime.usageLimitRecovery'),
        )).toMatchObject({
            sessionUsageLimitRecoveryV1: {
                status: 'cancelled',
                attemptCount: 3,
            },
        });
    });

    it('does not let a cancelled runtime-A mutation replace same-epoch runtime B', () => {
        const runtimeB = {
            v: 1 as const, status: 'waiting' as const, issueFingerprint: 'same', armedAtMs: 100,
            runtimeAuthRecoveryAttemptId: 'runtime-b', resetAtMs: null, nextCheckAtMs: null,
            attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard' as const,
            selectedAuth: { kind: 'native' as const },
        };
        const cancelledRuntimeA = {
            ...runtimeB,
            status: 'cancelled' as const,
            runtimeAuthRecoveryAttemptId: 'runtime-a',
            attemptCount: 2,
        };

        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            { ...baseMetadata, sessionUsageLimitRecoveryV1: runtimeB },
            mutation({ kind: 'set', value: cancelledRuntimeA }, 'runtime.usageLimitRecovery'),
        )).toMatchObject({ sessionUsageLimitRecoveryV1: runtimeB });
    });

    it('does not clear a newer usage-limit attempt with an older registered clear mutation', () => {
        const older = {
            v: 1 as const,
            status: 'waiting' as const,
            issueFingerprint: 'usage-limit:old',
            armedAtMs: 100,
            resetAtMs: null,
            nextCheckAtMs: 200,
            attemptCount: 1,
            maxAttempts: 4,
            lastProbeError: null,
            resumePromptMode: 'standard' as const,
            selectedAuth: { kind: 'native' as const },
        };
        const newer = { ...older, issueFingerprint: 'usage-limit:new', armedAtMs: 300 };

        expect(applyRegisteredSessionStateFieldMutationToMetadata(
            { ...baseMetadata, sessionUsageLimitRecoveryV1: newer },
            mutation({ kind: 'clear', previousFingerprint: deterministicStringify(older) }, 'runtime.usageLimitRecovery'),
        )).toMatchObject({ sessionUsageLimitRecoveryV1: newer });
    });
});
