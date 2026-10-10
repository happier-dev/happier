import { describe, expect, it } from 'vitest';

import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { deterministicStringify } from '@/utils/deterministicJson';
import { applyRegisteredSessionStateFieldMutationToMetadata } from './applyRegisteredSessionStateFieldMutation';
import type { RegisteredSessionStateFieldMutationV1 } from './sessionClientDurableMutationTypes';
import { createRegisteredSessionStateFieldMutation } from './sessionClientDurableMutationTypes';
import { parseRuntimeSessionClientDurableMutation } from './sessionClientDurableMutationPersistence';

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
    it('requires the reviewed revision for durable Session voice preference mutations', () => {
        expect(() => createRegisteredSessionStateFieldMutation({ sessionId: 'sess-1', fieldId: 'intent.voicePreference',
            source: 'ui', op: { kind: 'set', value: null } })).toThrow('reviewed Session metadata revision');
        expect(createRegisteredSessionStateFieldMutation({ sessionId: 'sess-1', fieldId: 'intent.voicePreference',
            source: 'ui', expectedMetadataRevision: 4, op: { kind: 'set', value: null } }))
            .toMatchObject({ expectedMetadataRevision: 4, deliveryClass: 'durable_required' });
    });
    it('rehydrates only a reviewed canonical Session voice preference from the durable outbox', () => {
        const preference = { providerContributionId: 'acme.voice/conversation', settingFieldPath: 'voice', value: 'custom' };
        const payload = { ...mutation({ kind: 'set', value: preference }, 'intent.voicePreference'),
            source: 'ui' as const, deliveryClass: 'durable_required' as const, expectedMetadataRevision: 4 };
        const queued = { kind: 'registered_session_state_field', payload, mutationId: payload.mutationId, attempts: 0, createdAt: 1 };
        expect(parseRuntimeSessionClientDurableMutation(queued, 'sess-1').mutations).toHaveLength(1);
        expect(parseRuntimeSessionClientDurableMutation({ ...queued, payload: { ...payload, expectedMetadataRevision: undefined } }, 'sess-1').mutations).toEqual([]);
        expect(parseRuntimeSessionClientDurableMutation({ ...queued, payload: { ...payload,
            op: { kind: 'set', value: { ...preference, futureAnnotation: true } } } }, 'sess-1').mutations[0]?.payload)
            .toEqual(payload);
        expect(parseRuntimeSessionClientDurableMutation({ ...queued, payload: { ...payload,
            op: { kind: 'set', value: { ...preference, settingFieldPath: 'constructor.voice' } } } }, 'sess-1').mutations).toEqual([]);
    });
    it('applies and clears the registered Session voice without altering neighboring work', () => {
        const preference = { providerContributionId: 'acme.voice/conversation', settingFieldPath: 'voice', value: 'custom' };
        const original = { ...baseMetadata, work: { memoryEnabled: false } };
        const applied = applyRegisteredSessionStateFieldMutationToMetadata(original,
            mutation({ kind: 'set', value: preference }, 'intent.voicePreference'));
        expect(applied).toEqual({ ...original, work: { ...original.work, voicePreference: preference } });
        expect(applyRegisteredSessionStateFieldMutationToMetadata(applied,
            mutation({ kind: 'clear' }, 'intent.voicePreference'))).toEqual(original);
        expect(() => applyRegisteredSessionStateFieldMutationToMetadata(original,
            mutation({ kind: 'set', value: { ...preference, forged: true } }, 'intent.voicePreference'))).toThrow();
    });
    it('applies context entry and inherited-switch intents without replacing neighboring work', () => {
        const first = { id: 'first', ref: { kind: 'doc' as const, artifactId: 'first' }, enabled: true, placement: 'system_append' as const };
        const second = { ...first, id: 'second', ref: { kind: 'doc' as const, artifactId: 'second' } };
        const original = { ...baseMetadata, work: { promptStack: [first], memoryEnabled: true,
            sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' } } };
        const attached = applyRegisteredSessionStateFieldMutationToMetadata(original,
            mutation({ kind: 'set', value: { kind: 'attach', entry: second } }, 'intent.context'));
        expect(attached).toMatchObject({ work: { ...original.work, promptStack: [first, second] } });
        const disabled = applyRegisteredSessionStateFieldMutationToMetadata(attached,
            mutation({ kind: 'set', value: { kind: 'inherited_enable', entryId: 'account.context', enabled: false } }, 'intent.context'));
        expect(disabled).toMatchObject({ work: { promptStack: [first, second], disabledInheritedEntryIds: ['account.context'] } });
        const off = applyRegisteredSessionStateFieldMutationToMetadata(disabled,
            mutation({ kind: 'set', value: false }, 'intent.memoryEnabled'));
        expect(off).toMatchObject({ work: { ...disabled.work, memoryEnabled: false } });
        expect(() => applyRegisteredSessionStateFieldMutationToMetadata(off,
            mutation({ kind: 'set', value: { kind: 'attach', entry: { ...second, id: 'third', authority: 'forged' } } }, 'intent.context'))).toThrow();
    });
    it('preserves neighboring owner work metadata when applying roles and active role mutations', () => {
        const roles = { overrides: {}, sessionRoles: {}, notes: 'CURRENT_NOTES' };
        const original = { ...baseMetadata, work: { keep: 'other-lane', sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'PREVIOUS_NOTES' } } };
        const withRoles = applyRegisteredSessionStateFieldMutationToMetadata(original,
            mutation({ kind: 'set', value: roles }, 'intent.sessionRoles'));
        expect(withRoles).toMatchObject({ work: { keep: 'other-lane', sessionRolesV1: roles } });
        const selected = applyRegisteredSessionStateFieldMutationToMetadata(withRoles,
            mutation({ kind: 'set', value: 'builder' }, 'intent.role'));
        expect(selected).toMatchObject({ work: { keep: 'other-lane', sessionRolesV1: { ...roles, roleId: 'builder' } } });
        expect(applyRegisteredSessionStateFieldMutationToMetadata(selected,
            mutation({ kind: 'clear' }, 'intent.role'))).toEqual(withRoles);
        expect(() => applyRegisteredSessionStateFieldMutationToMetadata(original,
            mutation({ kind: 'set', value: { ...roles, grants: ['forged'] } }, 'intent.sessionRoles'))).toThrow();
    });

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
