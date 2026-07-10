import { describe, expect, it } from 'vitest';

import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
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
    v: 1,
    activeCount: 1,
    observedAtMs: 1_000,
    expiresAtMs: 2_000,
    sourceClass: 'provider_detached_task',
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
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityExpiresAt: 2_000,
            runtimeActivitySourceClass: 'provider_detached_task',
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
});
