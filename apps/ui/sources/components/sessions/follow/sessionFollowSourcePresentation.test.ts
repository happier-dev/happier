import { describe, expect, it } from 'vitest';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

import {
    listEligibleSessionFollowSourceCandidates,
    refineSessionFollowSourceStateWithPreparationReason,
    resolveSessionFollowSourceRuntimeState,
    sessionFollowSourceRuntimeStateLabel,
} from './sessionFollowSourcePresentation';

const followScope = { serverId: 'home-a', accountId: 'follow-account' };

describe('resolveSessionFollowSourceRuntimeState', () => {
    it('holds receiver-side personal occurrences until an authorized Account lifetime can evaluate them', () => {
        for (const [production, ownerAccountId] of [['source', 'other-account'], ['recovery', 'follow-account']] as const) {
            for (const authorization of ['absent', 'locked', 'wrong_mode'] as const) {
                const personRuleEvaluation = { accountId: 'follow-account', ownerAccountId, production,
                    hasPendingOccurrence: true, authorization };
                expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'eligible', machine: null, personRuleEvaluation }))
                    .toBe('waiting_for_authorized_device');
                expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'eligible', machine: null,
                    personRuleEvaluation: { ...personRuleEvaluation, authorization: 'authorized' } }))
                    .toBe('catch_up_pending');
                expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'eligible', machine: null,
                    personRuleEvaluation: { ...personRuleEvaluation, hasPendingOccurrence: false } }))
                    .toBe('eligible');
            }
        }
        // App availability never transfers same-Account source production to the receiver.
        expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'eligible', machine: null,
            personRuleEvaluation: { accountId: 'follow-account', ownerAccountId: 'follow-account', production: 'source',
                hasPendingOccurrence: true, authorization: 'absent' } })).toBe('eligible');
        expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'paused_archived', machine: null,
            personRuleEvaluation: { accountId: 'follow-account', ownerAccountId: 'other-account', production: 'source',
                hasPendingOccurrence: true, authorization: 'locked' } })).toBe('paused_archived');
    });

    it('shows a destination request failure only for its exact Account and Home', () => {
        const scope = { serverId: 'follow-home', accountId: 'follow-account' };
        const machine = { id: 'runner', active: true, activeAt: Date.now(),
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } } };
        recordMachineRequestFailed({ ...scope, machineId: machine.id });
        try {
            expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'eligible', machine, accountScope: scope }))
                .toBe('waiting_for_runtime');
            expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'eligible', machine,
                accountScope: { ...scope, accountId: 'other-account' } })).toBe('eligible');
        } finally { clearMachineRequestReachabilityForTest(); }
    });
    it('derives archived, offline, unsupported, and eligible states without persisting runtime facts', () => {
        expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'paused_archived', machine: null })).toBe('paused_archived');
        expect(resolveSessionFollowSourceRuntimeState({ deliveryState: 'eligible', machine: null })).toBe('waiting_for_runtime');
        expect(resolveSessionFollowSourceRuntimeState({
            deliveryState: 'eligible',
            accountScope: followScope,
            machine: { id: 'runner-a', active: true, operationProtocolCapabilities: {} },
        })).toBe('runtime_unsupported');
        expect(resolveSessionFollowSourceRuntimeState({
            deliveryState: 'eligible',
            accountScope: followScope,
            machine: { id: 'runner-a', active: true, operationProtocolCapabilities: { sessionFollow: { contextV1: true } } },
        })).toBe('eligible');
        expect(resolveSessionFollowSourceRuntimeState({
            deliveryState: 'eligible',
            accountScope: followScope,
            hasPendingUpdates: true,
            machine: { id: 'runner-a', active: true, operationProtocolCapabilities: { sessionFollow: { contextV1: true } } },
        })).toBe('catch_up_pending');
        expect(resolveSessionFollowSourceRuntimeState({
            deliveryState: 'eligible',
            accountScope: followScope,
            hasPendingUpdates: true,
            machine: null,
        })).toBe('waiting_for_runtime');
        expect(resolveSessionFollowSourceRuntimeState({
            deliveryState: 'eligible',
            accountScope: followScope,
            sourceEncryptionMode: 'e2ee',
            machine: {
                id: 'runner-a',
                active: true,
                kind: 'ephemeral_session_runner',
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            },
        })).toBe('waiting_for_source_key');
        expect(resolveSessionFollowSourceRuntimeState({
            deliveryState: 'eligible',
            accountScope: followScope,
            sourceEncryptionMode: 'e2ee',
            preparedInUiLifetime: true,
            machine: {
                id: 'runner-a',
                active: true,
                kind: 'ephemeral_session_runner',
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            },
        })).toBe('eligible');
    });

    it('separates a destination that cannot provide encrypted access from the transient wait', () => {
        // The four Protocol waiting reasons have one refinement owner, so the picker and
        // the sources editor cannot disagree about what a reason means.
        expect(refineSessionFollowSourceStateWithPreparationReason('waiting_for_source_key', undefined))
            .toBe('waiting_for_source_key');
        expect(refineSessionFollowSourceStateWithPreparationReason('waiting_for_source_key', 'runner_unreachable'))
            .toBe('waiting_for_runtime');
        expect(refineSessionFollowSourceStateWithPreparationReason('waiting_for_source_key', 'unsupported'))
            .toBe('runtime_unsupported');
        // Not a wait: this destination holds no key material it could ever use.
        expect(refineSessionFollowSourceStateWithPreparationReason('waiting_for_source_key', 'runner_key_unavailable'))
            .toBe('runner_key_unavailable');
        // Also not a wait: this client holds no usable encryption material for the SOURCE.
        expect(refineSessionFollowSourceStateWithPreparationReason('waiting_for_source_key', 'source_key_unavailable'))
            .toBe('source_key_unavailable');
        // A reason only refines the waiting state it explains.
        expect(refineSessionFollowSourceStateWithPreparationReason('eligible', 'runner_key_unavailable'))
            .toBe('eligible');
    });

    it('labels every runtime state through one owner, including the unavailable Runner key', () => {
        expect(sessionFollowSourceRuntimeStateLabel('runner_key_unavailable'))
            .toBe("This computer can't provide encrypted access.");
        expect(sessionFollowSourceRuntimeStateLabel('waiting_for_source_key'))
            .toBe('Waiting for encrypted access.');
        // An unavailable source key is a settled answer, so it must not read as a wait.
        expect(sessionFollowSourceRuntimeStateLabel('source_key_unavailable'))
            .not.toBe(sessionFollowSourceRuntimeStateLabel('waiting_for_source_key'));
        expect(sessionFollowSourceRuntimeStateLabel('source_key_unavailable'))
            .toBe("This session's encrypted access is not available here.");
    });

    it('keeps source candidates on the exact destination Home and excludes self and existing edges', () => {
        const sessions = [{ id: 'destination' }, { id: 'existing' }, { id: 'candidate' }, { id: 'other-home' }];
        expect(listEligibleSessionFollowSourceCandidates({
            sessions,
            destination: { serverId: 'home-a', sessionId: 'destination' },
            existingSourceSessionIds: ['existing'],
            resolveServerId: (sessionId) => sessionId === 'other-home' ? 'home-b' : 'home-a',
        })).toEqual([{ id: 'candidate' }]);
    });
});
