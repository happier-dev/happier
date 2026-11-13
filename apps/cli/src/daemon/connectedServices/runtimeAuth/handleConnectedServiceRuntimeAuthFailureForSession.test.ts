import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeAuthFailureSourceProfile } from './resolveRuntimeAuthFailureSourceProfile';
import {
    authorizeConnectedServiceRuntimeAuthFailureSource,
    applyAuthorizedRuntimeAuthFailureSourceBinding,
    handleConnectedServiceRuntimeAuthFailureForSession,
} from './handleConnectedServiceRuntimeAuthFailureForSession';
import type { RuntimeAuthRecoveryIntent } from './RuntimeAuthRecoveryScheduler';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { readConnectedServiceRuntimeAuthFailureSourceBinding, applyConnectedServiceRuntimeAuthFailureSourceBinding } from './handleConnectedServiceRuntimeAuthFailure';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry, type ConnectedServiceAuthGroupSwitchState } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { settleSupersedingRuntimeAuthGenerationForSource } from './supersedingGeneration';
import { RuntimeAuthRecoveryScheduler } from './RuntimeAuthRecoveryScheduler';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('handleConnectedServiceRuntimeAuthFailureForSession', () => {
  it.each(['plan', 'usage_limit', 'rate_limit'] as const)('does not replay model-scoped %s as account recovery', async kind => {
    expect(await handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [], switchCoordinator: null, sessionId: 'model-refusal',
      recoveryInvocationSource: 'scheduler_retry',
      classification: { kind, serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary',
        groupId: 'pool', quotaScope: 'model', providerLimitId: 'gpt-6.1-sol',
        resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
    })).toEqual({ status: 'not_classified' });
  });
    it.each([null, 'csr_aaaaaaaaaaaaaaaaaaaaaa'] as const)('preserves the issued credential tuple after current registration advances: %s', (expectedCredentialRevision) => {
        const failure: ConnectedServiceRuntimeFailureClassification = {
            kind: 'usage_limit', serviceId: 'happier.agent.claude/claude-subscription', profileId: 'work', groupId: 'pool',
            groupGeneration: expectedCredentialRevision ? 4 : null, expectedCredentialRevision,
            providerReportedOrganizationId: 'org-work', resetsAtMs: null, planType: null,
            rateLimits: null, source: 'structured_provider_error',
        };
        expect(applyAuthorizedRuntimeAuthFailureSourceBinding(failure, {
            status: 'authorized', tracked: null, inactive: null,
            sourceBinding: { serviceId: failure.serviceId, profileId: 'work', groupId: 'pool', generation: 8,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' },
        })).toEqual(failure);
    });
    it.each([
        ['A', 'daemon_report', true], ['A', 'scheduler_retry', true], ['B', 'daemon_report', true], ['B', 'scheduler_retry', true],
        ['A', 'scheduler_retry', false],
    ] as const)('admits predecessor failure %s from %s with coordinator available=%s once', async (failedProfile, recoveryInvocationSource, coordinatorAvailable) => {
        const serviceId = 'happier.agent.codex/openai-codex';
        const tracked = { trackingKey: legacyPidSessionTrackingKey(100), startedBy: 'daemon' as const, pid: 100, happySessionId: 'legacy-report', spawnOptions: {
            directory: '/project', environmentVariables: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                { kind: 'group', serviceId, groupId: 'pool', activeProfileId: 'A', fallbackProfileId: 'A', generation: 1 },
            ]) },
        } };
        const registry = new ConnectedServiceRuntimeRegistry();
        registry.registerTarget({ pid: tracked.pid, sessionId: tracked.happySessionId, agentId: 'codex',
            connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: {
                source: 'connected', selection: 'group', groupId: 'pool', profileId: 'A',
            } } }, connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                { kind: 'group', serviceId, groupId: 'pool', activeProfileId: 'B', fallbackProfileId: 'A', generation: 2,
                    credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' },
            ]) } });
        let current: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'B', generation: 2,
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, strategy: 'priority', autoSwitch: true },
            members: ['A', 'B', 'C'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
            memberStatesByProfileId: new Map(['A', 'B', 'C'].map(profileId => [profileId, {
                quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: profileId === 'A' ? 0 : 60 },
            }])),
        };
        const effects: string[] = [];
        const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
            leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
            loadState: async () => current,
            commitSwitch: async ({ toProfileId }) => { effects.push(`select:${toProfileId}`);
                current = { ...current, activeProfileId: toProfileId, generation: 3, credentialRevision: 'csr_cccccccccccccccccccccc' }; return current; },
            applyGeneration: async ({ activeProfileId }) => { effects.push(`apply:${activeProfileId}`); return { ok: true, mode: 'hot_apply' }; },
        });
        const result = await handleConnectedServiceRuntimeAuthFailureForSession({ getChildren: () => [tracked],
            sessionId: tracked.happySessionId, switchesThisTurn: 0, switchCoordinator: coordinatorAvailable ? coordinator : null, recoveryInvocationSource,
            resolveRegisteredRuntimeAuthFailureSource: async () => {
                const target = registry.getBySessionId(tracked.happySessionId);
                return target ? readConnectedServiceRuntimeAuthFailureSourceBinding(target, serviceId) : null;
            }, classification: { kind: 'usage_limit', serviceId, groupId: recoveryInvocationSource === 'daemon_report' ? null : 'pool', profileId: failedProfile,
                resetsAtMs: null, planType: null, rateLimits: null, quotaScope: 'account', source: 'structured_provider_error' },
        });
        if (!coordinatorAvailable) {
            expect(result).toMatchObject({ status: 'switch_coordinator_unavailable' });
            expect(effects).toEqual([]);
        } else if (failedProfile === 'A' && recoveryInvocationSource === 'daemon_report') {
            expect(result).toMatchObject({ status: 'recovery_superseded' });
            expect(effects).toEqual([]);
        } else if (failedProfile === 'A') {
            expect(result).toMatchObject({ status: 'switch_attempted', result: { status: 'observed_generation', activeProfileId: 'B' } });
            expect(effects).toEqual([]);
        } else if (recoveryInvocationSource === 'scheduler_retry') {
            // A retry can reuse the failed current member after reliable quota recovery.
            expect(result).toMatchObject({ status: 'switch_attempted', result: { status: 'observed_generation', activeProfileId: 'B' } });
            expect(effects).toEqual(['apply:B']);
        } else {
            expect(result).toMatchObject({ status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'C' } });
            expect(effects).toEqual(['select:C', 'apply:C']);
        }
    });
    it('preserves the no-binding predecessor protection for a healthy live replacement', async () => {
        const serviceId = 'happier.agent.codex/openai-codex';
        const effects: string[] = [];
        let current: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'A', generation: 1,
            policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, strategy: 'priority', autoSwitch: true },
            members: ['A', 'B'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
            memberStatesByProfileId: new Map(['A', 'B'].map(profileId => [profileId, {
                quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: profileId === 'A' ? 0 : 60 },
            }])),
        };
        const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
            leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
            loadState: async () => current, commitSwitch: async ({ toProfileId }) => {
                current = { ...current, activeProfileId: toProfileId, generation: 2 }; return current;
            }, applyGeneration: async () => ({ ok: true, mode: 'spawn_next_turn' }),
        });
        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{ trackingKey: legacyPidSessionTrackingKey(101), startedBy: 'daemon', pid: 101, happySessionId: 'unqualified', spawnOptions: {
                directory: '/project', environmentVariables: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                    { kind: 'group', serviceId, groupId: 'pool', activeProfileId: 'B', fallbackProfileId: 'B', generation: 2 },
                ]) },
            } }], sessionId: 'unqualified', switchesThisTurn: 0, switchCoordinator: coordinator,
            restartSession: async () => { effects.push('restart'); }, continueAfterRuntimeAuthSwitch: async () => { effects.push('continue'); },
            classification: { kind: 'usage_limit', serviceId, groupId: 'pool', profileId: 'A',
                quotaScope: 'account', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
        });
        expect(result).toMatchObject({ status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'B' } });
        expect(effects).toEqual([]);
    });
    it.each(['observe', 'ordinary', 'unsettled', 'predecessor', 'unacknowledged', 'exhausted', 'unknown'] as const)(
        'retains stopped work and exact redirected provider proof (%s)', async (scenario) => {
        const serviceId = 'happier.agent.codex/openai-codex';
        const ordinary = scenario === 'ordinary' || scenario === 'unsettled';
        const effects: string[] = [];
        const revisionA = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const revisionB = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        const revisionC = 'csr_cccccccccccccccccccccc';
        const targetD = { serviceId, groupId: 'team', profileId: 'D', generation: 4,
            credentialRevision: 'csr_dddddddddddddddddddddd' } as const;
        let current: ConnectedServiceAuthGroupSwitchState = {
            serviceId, groupId: 'team', activeProfileId: ordinary ? 'A' : 'C', generation: ordinary ? 1 : 3,
            credentialRevision: ordinary ? revisionA : revisionC,
            policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, strategy: 'priority', autoSwitch: true },
            members: ['A', 'B', 'C', 'D'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
            memberStatesByProfileId: new Map(['B', 'C', 'D'].map(profileId => [profileId, scenario === 'unknown' ? {} : {
                quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: scenario === 'exhausted' ? 0 : 60 },
            }])),
        };
        const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
            leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
            loadState: async () => current,
            commitSwitch: async ({ toProfileId }) => { effects.push(`select:${toProfileId}`);
                current = { ...current, activeProfileId: toProfileId, generation: 2, credentialRevision: revisionB }; return current; },
            applyGeneration: async ({ activeProfileId, generation, credentialRevision: appliedRevision }) => {
                effects.push(`apply:${activeProfileId}`);
                if (activeProfileId === 'B') {
                    current = { ...current, activeProfileId: 'C', generation: 3, credentialRevision: revisionC };
                    return { ok: true, mode: 'hot_apply' };
                }
                if (!activeProfileId || !appliedRevision) throw new Error('Fixture requires an exact native target');
                return { ok: true, mode: 'hot_apply', providerApplication: 'applied', verificationByServiceId: {
                    [serviceId]: { status: 'verified', proofStrength: 'exact', providerAccountId: activeProfileId,
                        generationApplication: { serviceId, groupId: 'team', profileId: activeProfileId, generation,
                            credentialRevision: appliedRevision, credentialFingerprint: `${activeProfileId}:${generation}` } },
                } };
            },
        });
        const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
            resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'runner' }),
            verifySharedGenerationApplication: async () => null,
            clearAdoptedGeneration: async () => {},
            applyCommittedGeneration: async ({ committedGeneration }) => {
                effects.push(`apply:${committedGeneration.decisionCommittedTarget.profileId}`);
                if (scenario === 'unacknowledged') return { reconciliationDisposition: 'failed', errorCode: 'recipient_not_adopted' };
                if (committedGeneration.decisionCommittedTarget.profileId === 'C') {
                    current = { ...current, activeProfileId: 'D', generation: 4, credentialRevision: targetD.credentialRevision };
                    return { reconciliationDisposition: 'superseded_after_apply', errorCode: null, authoritativeGeneration:
                        buildConnectedServiceAuthGroupCommittedGenerationFact({ decisionId: 'current-D', provenance: 'reconciliation', decisionCommittedTarget: targetD }) };
                }
                return { reconciliationDisposition: 'converged', errorCode: null, providerAdoptedTarget: { ...targetD,
                    proof: { status: 'verified', source: 'codex_app_server', providerAccountId: 'D', credentialRevision: targetD.credentialRevision } } };
            },
        });
        const failure: ConnectedServiceRuntimeFailureClassification = { kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account', serviceId, groupId: 'team',
            profileId: 'A', groupGeneration: 1, ...(scenario === 'predecessor' ? {} : { expectedCredentialRevision: revisionA }),
            resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' };
        let recovered: unknown;
        const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, jitterMs: () => 0,
            recover: async input => {
                recovered = await handleConnectedServiceRuntimeAuthFailureForSession({ ...input,
                    getChildren: () => [{ trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon', happySessionId: 'stopped', pid: 123 }], switchCoordinator: coordinator,
                    resolveRegisteredRuntimeAuthFailureSource: async () => ({ serviceId, groupId: 'team', profileId: ordinary ? 'A' : 'B',
                        generation: ordinary ? 1 : 2, credentialRevision: ordinary ? revisionA : revisionB }),
                    resolveCurrentRuntimeAuthFailureSource: scenario === 'predecessor'
                      ? async () => ({ serviceId, groupId: 'team', profileId: 'B', generation: 2, credentialRevision: revisionB }) : undefined,
                    settleSupersedingRuntimeGroupGeneration: scenario === 'unsettled' ? undefined : async ({ result, ...source }) => await settleSupersedingRuntimeAuthGenerationForSource({
                        ...source, recovery: { status: 'switch_attempted', result }, consumeCommittedAuthGroupGeneration: input => consumer.consume(input) }),
                    continueAfterRuntimeAuthSwitch: async () => { effects.push('continue'); },
                });
                return recovered;
            },
        });
        try {
            expect(await scheduler.enqueueHandlerFailure({ reportId: 'runtime-auth-report:stopped', sessionId: 'stopped', switchesThisTurn: ordinary ? 0 : 999, classification: failure,
                error: Object.assign(new Error('network unavailable'), { code: 'ECONNRESET' }) })).toMatchObject({ status: 'scheduled' });
            expect(scheduler.readForSession('stopped')).toHaveLength(1);
            await scheduler.wake({ sessionId: 'stopped', reason: 'manual' });
            if (scenario === 'observe' || scenario === 'ordinary' || scenario === 'predecessor') {
                // C was superseded during its one application. The recovery owner retains the
                // failure; its next wake reads the committed D selection instead of replaying
                // the whole recipient set inside C's delivery.
                expect(scheduler.readForSession('stopped')[0]).toMatchObject({ status: 'waiting' });
                expect(effects).toEqual([...(ordinary ? ['select:B', 'apply:B'] : []), 'apply:C']);
                await scheduler.wake({ sessionId: 'stopped', reason: 'manual' });
            }
            if (scenario !== 'unacknowledged') expect.soft(recovered).toMatchObject({ status: 'switch_attempted' });
            const intent = scheduler.readForSession('stopped')[0];
            if (scenario === 'unsettled') {
                expect(recovered).toMatchObject({ status: 'switch_attempted', result: { status: 'superseded_after_apply' } });
                // 0.3 already retains local B adoption as intermediate progress. It must
                // neither continue on D nor claim D as the pending proof target.
                expect(intent).toMatchObject({ status: 'resumed_awaiting_proof' });
                expect(intent?.pendingTargetProfileId).not.toBe('D');
                expect(effects).toEqual(['select:B', 'apply:B']);
                return;
            }
            if (scenario === 'exhausted' || scenario === 'unknown' || scenario === 'unacknowledged') {
                expect(intent).toMatchObject({ status: 'waiting' });
                expect(effects).not.toContain('continue');
                expect(effects.filter(effect => effect.startsWith('select:'))).toEqual([]);
                return;
            }
            expect(effects).toEqual([...(ordinary ? ['select:B', 'apply:B'] : []), 'apply:C', 'apply:D', 'continue']);
            expect(recovered).toMatchObject({ status: 'switch_attempted', result: { status: 'observed_generation', activeProfileId: 'D', generation: 4 } });
            expect(intent).toMatchObject({ status: 'resumed_awaiting_proof', pendingTargetProfileId: 'D', pendingTargetGeneration: 4,
                pendingTargetCredentialRevision: targetD.credentialRevision });
            await scheduler.markProviderOutcomeProofByIdentity({ sessionId: 'stopped', serviceId, groupId: 'team', profileId: 'D',
                groupGeneration: 4, credentialRevision: targetD.credentialRevision, proofKind: 'provider_activity', observedAtMs: 1_001 });
            expect(scheduler.readForSession('stopped')[0]).toMatchObject({ status: 'recovered' });
        } finally { scheduler.dispose(); }
    });
    it('declines an unattributed native-login failure without creating account recovery', async () => {
        const tracked = { trackingKey: legacyPidSessionTrackingKey(112), startedBy: 'daemon' as const, pid: 112, happySessionId: 'native-session',
            spawnOptions: { directory: '/project' } };
        await expect(authorizeConnectedServiceRuntimeAuthFailureSource({ getChildren: () => [tracked],
            sessionId: tracked.happySessionId, classification: { kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex', profileId: null, groupId: null, quotaScope: 'account',
                resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
            resolveRegisteredRuntimeAuthFailureSource: async () => null,
        })).resolves.toMatchObject({ status: 'not_applicable', reason: 'no_connected_service_binding' });
    });
    it('does not authorize a stale launch member after actual organization attribution abstains', async () => {
        const classification: ConnectedServiceRuntimeFailureClassification = {
            kind: 'usage_limit', serviceId: 'happier.agent.claude/claude-subscription', profileId: 'launch', groupId: 'pool',
            groupGeneration: 7, expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
            sourceProviderAccountId: 'same-user', sourceProviderOrganizationId: 'org-absent',
            resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
        };
        await expect(authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{ trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon', pid: 123, happySessionId: 'session-context', spawnOptions: { directory: '/project' } }],
            sessionId: 'session-context', classification,
            resolveProviderQualifiedRuntimeAuthFailureSource: async ({ classification }) => await resolveRuntimeAuthFailureSourceProfile({
                classification, getGroupMembers: async () => [{ profileId: 'launch' }, { profileId: 'other' }],
                resolveProviderAccountIdentity: async (profileId) => ({ providerAccountId: 'same-user', providerOrganizationId: profileId }),
            }),
        })).resolves.toMatchObject({ status: 'recovery_superseded', reason: 'source_tuple_unavailable', profileId: null });
    });

    it.each([false, true])('routes unattributed native failure through the registered pool without blaming its current member (provider evidence=%s)', async (modern) => {
        const serviceId = 'happier.agent.claude/claude-subscription';
        const tracked = { trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const, pid: 111, happySessionId: 'session', spawnOptions: {
            directory: '/project', environmentVariables: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                { kind: 'group', serviceId, groupId: 'pool', activeProfileId: 'old', fallbackProfileId: 'old', generation: 1 },
            ]) },
        } };
        const registry = new ConnectedServiceRuntimeRegistry();
        registry.registerTarget({ pid: tracked.pid, sessionId: tracked.happySessionId, agentId: 'claude',
            connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: {
                source: 'connected', selection: 'group', groupId: 'pool', profileId: 'old',
            } } },
            connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                { kind: 'group', serviceId, groupId: 'pool', activeProfileId: 'current', fallbackProfileId: 'old', generation: 2,
                    credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
            ]) } });
        const classification: ConnectedServiceRuntimeFailureClassification = { kind: 'usage_limit', serviceId, profileId: null, groupId: null,
            quotaScope: 'account', groupGeneration: null, expectedCredentialRevision: null, resetsAtMs: null, planType: null,
            rateLimits: null, source: 'structured_provider_error', ...(modern ? {
                profileId: 'old', groupId: 'pool', sourceProviderAccountId: null, providerReportedOrganizationId: null,
            } : {}) };
        const resolveRegisteredRuntimeAuthFailureSource = async () => {
            const target = registry.getBySessionId(tracked.happySessionId);
            return target ? readConnectedServiceRuntimeAuthFailureSourceBinding(target, serviceId) : null;
        };
        const authorization = await authorizeConnectedServiceRuntimeAuthFailureSource({ getChildren: () => [tracked],
            sessionId: tracked.happySessionId, classification, resolveRegisteredRuntimeAuthFailureSource,
            resolveProviderQualifiedRuntimeAuthFailureSource: async ({ classification }) => await resolveRuntimeAuthFailureSourceProfile({
                classification, getGroupMembers: async () => [{ profileId: 'old' }, { profileId: 'current' }],
                resolveProviderAccountIdentity: async () => null,
            }) });
        expect(authorization).toMatchObject({ status: 'authorized', sourceBinding: { profileId: 'current', generation: 2 } });
        expect(applyAuthorizedRuntimeAuthFailureSourceBinding(classification, authorization))
            .toMatchObject({ profileId: null, groupId: 'pool', groupGeneration: null, expectedCredentialRevision: null });
    });
    it('authorizes a provider-qualified shared-auth failure from the live group member instead of stale launch metadata', async () => {
        const tracked = {
            trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_provider_qualified_shared_auth',
            spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
        };
        const resolveProviderQualifiedRuntimeAuthFailureSource = vi.fn(async ({ classification }) => ({
            ...classification,
            profileId: 'live-profile',
            groupGeneration: null,
            expectedCredentialRevision: null,
        }));

        await expect(authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'launch-profile',
                groupId: 'claude',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                sourceProviderAccountId: 'acct-live',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            resolveProviderQualifiedRuntimeAuthFailureSource,
        })).resolves.toMatchObject({
            status: 'authorized',
            sourceBinding: {
                serviceId: 'happier.agent.claude/claude-subscription',
                groupId: 'claude',
                profileId: 'live-profile',
                generation: null,
                credentialRevision: null,
            },
        });
        expect(resolveProviderQualifiedRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it.each([
        'happier.agent.codex/openai-codex',
        'happier.agent.claude/claude-subscription',
    ] as const)('uses generic host currentness, not service id, for %s source authorization', async (
        serviceId,
    ) => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_capability',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_capability',
            classification: {
                kind: 'usage_limit',
                serviceId,
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
        });

        expect(result.status).toBe('recovery_superseded');
    });

    it('authorizes an exact quota report from a reattached live runtime when spawn selections are absent', async () => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_reattached_exact_runtime',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_reattached_exact_runtime',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
        });

        expect(result).toMatchObject({ status: 'authorized' });
    });

    it('authorizes a hot-applied tracked quota report from the registered exact binding when the auxiliary probe is unavailable', async () => {
        const tracked = {
            trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_hot_applied_exact_runtime',
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'happier.agent.codex/openai-codex',
                        groupId: 'main',
                        activeProfileId: 'spawn-profile',
                        fallbackProfileId: 'spawn-profile',
                        generation: 7,
                        policy: null,
                        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                    }]),
                },
            },
        };
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'live-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw' as const,
        }));
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => {
            throw new Error('auxiliary runtime probe unavailable');
        });

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'live-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource,
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'live-profile',
                generation: 8,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            },
        });
        expect(resolveRegisteredRuntimeAuthFailureSource).toHaveBeenCalledOnce();
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('terminally supersedes a modern report that mismatches the registered exact binding', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'registered-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }));
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_registered_mismatch',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_registered_mismatch',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'reported-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'registered-profile',
                generation: 8,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_mismatch',
        });
        expect('adoptedTarget' in result).toBe(false);
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('terminally supersedes report A when exact current B disproves a matching stale registry A', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'current-profile',
            generation: 7,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_exact_current_disproves_registry',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_exact_current_disproves_registry',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'reported-profile',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'reported-profile',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_mismatch',
        });
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('keeps the settled binding authoritative when a newer attempted generation was not acknowledged', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'live-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_stale_bootstrap',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_stale_bootstrap',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'live-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'bootstrap-profile',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                profileId: 'bootstrap-profile',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            },
        });
        expect(resolveCurrentRuntimeAuthFailureSource).not.toHaveBeenCalled();
    });

    it('propagates unavailable registered runtime truth so the existing report outbox retains custody', async () => {
        await expect(authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_registry_unavailable',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_registry_unavailable',
            classification: {
                kind: 'auth_expired',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => null,
            resolveCurrentRuntimeAuthFailureSource: vi.fn(),
        })).rejects.toThrow('registered runtime binding unavailable');
    });

    it('authorizes a complete hot-applied credential failure from the exact live binding', async () => {
        const tracked = {
            trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_hot_applied_auth_expired',
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'happier.agent.codex/openai-codex',
                        groupId: 'main',
                        activeProfileId: 'spawn-profile',
                        fallbackProfileId: 'spawn-profile',
                        generation: 7,
                        policy: null,
                        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                    }]),
                },
            },
        };
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'live-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw' as const,
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            classification: {
                kind: 'auth_expired',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'live-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            resolveRegisteredRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                profileId: 'live-profile',
                generation: 8,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            },
        });
        expect(resolveRegisteredRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('keeps an actionful exact-identity credential failure passive without current-source authorization', async () => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_reattached_auth_expired',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_reattached_auth_expired',
            classification: {
                kind: 'auth_expired',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: null,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_unavailable',
        });
    });

    it('authorizes a predecessor quota report without a revision when the live resolver proves the exact current tuple', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 7,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 7,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_reattached_predecessor',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_reattached_predecessor',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: null,
                sourceProviderAccountId: 'acct_primary',
                failingAccessTokenFingerprint: 'sha256:deadbeef',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource,
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({ status: 'authorized' });
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('adopts the current generation for a predecessor report after exact same-identity proof', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 8,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_predecessor_generation',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_predecessor_generation',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: null,
                sourceProviderAccountId: 'acct_primary',
                failingAccessTokenFingerprint: 'sha256:deadbeef',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'primary',
                generation: 8,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                generation: 8,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            },
        });
    });

    it('uses the exact live binding throughout scheduler recovery instead of falling back to stale launch metadata', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 7,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'happier.agent.codex/openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 7,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));

        await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_scheduler_reattached_predecessor',
                reattachedFromDiskMarker: true,
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'happier.agent.codex/openai-codex',
                            groupId: 'main',
                            activeProfileId: 'stale-predecessor',
                            fallbackProfileId: 'primary',
                            generation: 6,
                            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                        }]),
                    },
                },
            }],
            resolveRegisteredRuntimeAuthFailureSource,
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_scheduler_reattached_predecessor',
            recoveryInvocationSource: 'scheduler_retry',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                sourceProviderAccountId: 'acct_primary',
                failingAccessTokenFingerprint: 'sha256:deadbeef',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
        });

        expect(resolveRegisteredRuntimeAuthFailureSource).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'main',
            observedProfileId: 'primary',
            allowCurrentProfileRetry: true,
        }));
    });

    it.each([
        ['the same profile and opaque revision', {
            profileId: 'primary',
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }, 'authorized'],
        ['a different profile', {
            profileId: 'backup',
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }, 'recovery_superseded'],
        ['a different opaque revision', {
            profileId: 'primary',
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }, 'recovery_superseded'],
    ] as const)('classifies an older-generation exact report against a newer registered binding with %s', async (
        _label,
        registeredTarget,
        expectedStatus,
    ) => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_newer_registered_generation',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_newer_registered_generation',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 6,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                generation: 7,
                ...registeredTarget,
            }),
        });

        if (expectedStatus === 'authorized') {
            expect(result).toMatchObject({
                status: 'authorized',
                sourceBinding: {
                    serviceId: 'happier.agent.codex/openai-codex',
                    groupId: 'main',
                    profileId: 'primary',
                    generation: 7,
                    credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                },
            });
            return;
        }
        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_mismatch',
        });
    });

    it('supersedes a late report without continuation when an exact newer group target is already adopted', async () => {
        const tracked = {
            trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_adopted_newer_target',
            spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
        };
        const switchAfterClassifiedFailure = vi.fn();
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'exhausted',
                groupId: 'main',
                groupGeneration: 6,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'replacement',
                generation: 7,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            }),
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
        })).resolves.toEqual({
            status: 'recovery_superseded',
            reason: 'source_tuple_mismatch',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'main',
            profileId: 'exhausted',
        });

        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
        expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    });

    it('continues a scheduled recovery on the refreshed revision of the same profile without attributing the old failure to it', async () => {
        const tracked = {
            trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_scheduled_same_profile_refresh',
            spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
        };
        const switchAfterClassifiedFailure = vi.fn();
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            recoveryInvocationSource: 'scheduler_retry',
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 6,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            }),
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
        })).resolves.toMatchObject({
            status: 'credential_refreshed',
            restartRequested: false,
            pendingProviderOutcome: true,
            activeProfileId: 'primary',
            generation: 7,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        });

        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: tracked.happySessionId,
            action: 'hot_applied',
            normalizedBindings: {
                v: 2,
                bindingsByServiceId: {
                    'happier.agent.codex/openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'main',
                    },
                },
            },
        }));
    });

    it.each([
        ['missing revision', { expectedCredentialRevision: undefined }],
        ['revision mismatch', { expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw' }],
        ['profile mismatch', { expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv', profileId: 'other' }],
        ['group mismatch', { expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv', groupId: 'other' }],
    ] as const)('passively supersedes Codex quota recovery when the source tuple has %s', async (_label, overrides) => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 7,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn();
        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_exact_tuple',
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'happier.agent.codex/openai-codex',
                            groupId: 'main',
                            activeProfileId: 'primary',
                            fallbackProfileId: 'primary',
                            generation: 7,
                            policy: null,
                            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                        }]),
                    },
                },
            }],
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                profileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_exact_tuple',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
                recoveryAction: { kind: 'quota_recovery_required' as const },
                ...overrides,
            },
        });

        expect(result).toMatchObject({ status: 'recovery_superseded' });
        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });
    it.each([null, 7])('refreshes the active profile without inventing an issued generation from registration %s', async generation => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 1,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshDiagnostic = {
            serviceId: 'claude-subscription' as const,
            profileId: 'primary',
            reason: 'runtime_auth_failure' as const,
            status: 'refreshed' as const,
            expiresAt: null,
            expiryAgeMs: null,
            refreshWindowMs: 0,
        };
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            diagnostic: refreshDiagnostic,
        }));
        const continueAfterRuntimeAuthSwitch = vi.fn(async (_input: { serviceIds: ReadonlySet<string> }) => {});
        const trackedSession = {
            trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_claude_group',
            spawnOptions: {
                directory: '/tmp/project',
                connectedServices: {
                    v: 1 as const,
                    bindingsByServiceId: {
                        'happier.agent.claude/claude-subscription': {
                            source: 'connected' as const,
                            selection: 'group' as const,
                            groupId: 'claude',
                            profileId: 'primary',
                        },
                    },
                },
            },
        };
        const input = {
            getChildren: () => [trackedSession],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_claude_group',
            switchesThisTurn: 0,
            resolveRegisteredRuntimeAuthFailureSource: generation === null ? undefined : async () => ({
                serviceId: 'happier.agent.claude/claude-subscription', groupId: 'claude', profileId: 'primary', generation,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }),
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toEqual({
            status: 'credential_refreshed',
            serviceId: 'happier.agent.claude/claude-subscription',
            profileId: 'primary',
            groupId: 'claude',
            refresh: {
                status: 'refreshed',
                credential: null,
                diagnostic: refreshDiagnostic,
            },
            restartRequested: false,
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
            serviceId: 'happier.agent.claude/claude-subscription',
            profileId: 'primary',
            sessionId: 'sess_claude_group',
        });
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            tracked: trackedSession,
            sessionId: 'sess_claude_group',
            attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.claude/claude-subscription:group:claude:primary:',
            normalizedBindings: {
                v: 2,
                bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'claude',
                    },
                },
            },
            action: 'hot_applied',
            switchReason: 'automatic_runtime_failure',
        }));
        const continuationCall = continueAfterRuntimeAuthSwitch.mock.calls[0]?.[0];
        expect(continuationCall).toBeDefined();
        expect([...continuationCall!.serviceIds]).toEqual(['happier.agent.claude/claude-subscription']);
    });

    it('switches to another group member when the active credential cannot be refreshed', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'hot_apply' as const,
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refresh_failed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'openai-codex' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refresh_failed' as const,
                category: 'provider_401' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_codex_group',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'main',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_codex_group',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'switched',
                activeProfileId: 'backup',
                generation: 2,
                mode: 'hot_apply',
            },
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    });

    it('adopts current group truth when the refreshed failing member was already superseded', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            runtimeAuthDisposition: 'superseded_by_current_group' as const,
            diagnostic: {
                serviceId: 'claude-subscription' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refreshed' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));
        const continueAfterRuntimeAuthSwitch = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_claude_group',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'happier.agent.claude/claude-subscription': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_claude_group',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'observed_generation',
                activeProfileId: 'backup',
                generation: 2,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_claude_group',
            action: 'hot_applied',
            attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.claude/claude-subscription:group:claude:backup:2',
        }));
    });

    it('requires reconnect when an expired credential cannot refresh and the group has no replacement', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 1,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refresh_failed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'openai-codex' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refresh_failed' as const,
                category: 'provider_401' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_codex_exhausted',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'main',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_codex_exhausted',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toEqual({
            status: 'recovery_action_required',
            action: {
                kind: 'reconnect_profile',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'main',
                reason: 'auth_expired',
            },
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    });

    it.each([
        ['resumed_awaiting_proof', 'auth_expired'],
        ['checking', 'recovery_unproven_awaiting_provider_outcome'],
    ] as const)(
        'refreshes the exact active binding even while stale provider-proof metadata is pending (%s)',
        async (status, lastError) => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 1,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'claude-subscription' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refreshed' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));
        const pendingIntent: RuntimeAuthRecoveryIntent = {
            v: 1,
            sessionId: 'sess_claude_group',
            serviceId: 'happier.agent.claude/claude-subscription',
            profileId: 'primary',
            groupId: 'claude',
            status,
            armedAtMs: 1_000,
            nextRetryAtMs: 6_000,
            attemptCount: 1,
            maxAttempts: 5,
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired',
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            failurePhase: 'handler',
            failureReason: 'classified_failure_reported',
            lastError,
            lastErrorClassification: { kind: 'auth_failed', retryable: true },
            pendingTargetProfileId: 'primary',
            pendingTargetGeneration: null,
            terminalAtMs: null,
            terminalReason: null,
        };
        const input = {
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_claude_group',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'happier.agent.claude/claude-subscription': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            runtimeAuthRecovery: {
                readForSession: () => [pendingIntent],
            },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_claude_group',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toMatchObject({
            status: 'credential_refreshed',
            serviceId: 'happier.agent.claude/claude-subscription',
            profileId: 'primary',
            groupId: 'claude',
            restartRequested: false,
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('routes account-changed group failures to profile reconnect without refreshing or switching the pool', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'hot_apply' as const,
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'claude-subscription' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refreshed' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_changed_account',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.claude/claude-subscription': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_changed_account',
            switchesThisTurn: 0,
            classification: {
                kind: 'account_changed',
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'recovery_action_required',
            action: {
                kind: 'reconnect_profile',
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                reason: 'account_changed',
            },
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('surfaces a failed tracked runtime group apply as a switch-attempt transcript event', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'generation_apply_failed' as const,
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'hot_apply_restart_required',
        }));
        const emitSessionEvent = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'generation_apply_failed',
                activeProfileId: 'backup',
                generation: 2,
                errorCode: 'hot_apply_restart_required',
            },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
            retryAfterMs: 30_000,
            resetsAtMs: null,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            providerLimitId: 'weekly',
            action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
            planType: null,
        }));
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', {
            type: 'connected_service_account_switch_attempt',
            ok: false,
            action: 'hot_applied',
            reason: 'usage_limit',
            attemptedContinuityMode: 'hot_apply',
            outcome: 'failed',
            outcomeAction: 'none',
            errorCode: 'hot_apply_restart_required',
            groupGeneration: 2,
            partialState: null,
        });
    });

    it('resolves canonical group context without replacing the provider-reported failed profile', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup-2',
            generation: 3,
            mode: 'hot_apply' as const,
        }));
        const emitSessionEvent = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'happier.agent.codex/openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'active-now',
                            fallbackProfileId: 'primary',
                            generation: 2,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup-2', generation: 3, mode: 'hot_apply' },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            observedProfileId: 'primary',
        }));
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('uses the tracked auth group to rotate after a provider-state-sharing usage-limit hint', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                recoveryAction: { kind: 'provider_state_sharing_required' },
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
        }));
    });

    it('requests a session restart when runtime recovery switches a group account for the next turn', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'spawn_next_turn' as const,
        }));
        const restartSession = vi.fn(async () => {});
        const trackedSession = {
            trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_1',
            spawnOptions: {
                directory: '/tmp/project',
                connectedServices: {
                    v: 1 as const,
                    bindingsByServiceId: {
                        'happier.agent.codex/openai-codex': {
                            source: 'connected' as const,
                            selection: 'group' as const,
                            groupId: 'group-1',
                            profileId: 'primary',
                        },
                    },
                },
            },
        };
        const input = {
            getChildren: () => [trackedSession],
            switchCoordinator: { switchAfterClassifiedFailure },
            restartSession,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            } satisfies ConnectedServiceRuntimeFailureClassification,
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'switched',
                activeProfileId: 'backup',
                generation: 2,
                mode: 'spawn_next_turn',
            },
        });

        expect(restartSession).toHaveBeenCalledWith(trackedSession);
    });

    it('still runs the switch pipeline for a scheduler replay when the failing profile IS the live profile', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 8,
            mode: 'spawn_next_turn' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'happier.agent.codex/openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'current',
                            fallbackProfileId: 'current',
                            generation: 7,
                            policy: null,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            recoveryInvocationSource: 'scheduler_retry',
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'current',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toMatchObject({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup' },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    });

    it('still restarts the live session when the failing profile IS the profile it runs on', async () => {
        const restartSession = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 8,
            mode: 'spawn_next_turn' as const,
        }));
        const trackedSession = {
            trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon' as const,
            happySessionId: 'sess_1',
            pid: 123,
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'happier.agent.codex/openai-codex',
                        groupId: 'group-1',
                        activeProfileId: 'current',
                        fallbackProfileId: 'current',
                        generation: 7,
                        policy: null,
                    }]),
                },
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [trackedSession],
            switchCoordinator: { switchAfterClassifiedFailure },
            restartSession,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'current',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toMatchObject({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup' },
        });

        expect(restartSession).toHaveBeenCalledWith(trackedSession);
    });


    it('refuses to qualify unattributed evidence from immutable child launch selections', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'secondary',
            generation: 3,
        }));
        const emitSessionEvent = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            gemini: {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'gemini',
                            groupId: 'group-1',
                            activeProfileId: 'backup',
                            fallbackProfileId: 'primary',
                            generation: 2,
                            policy: null,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'gemini',
                profileId: null,
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 45_000,
                limitCategory: 'usage_limit',
                quotaScope: 'account',
                providerLimitId: 'daily',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'recovery_superseded', reason: 'source_tuple_unavailable',
            serviceId: 'gemini',
            groupId: null, profileId: null,
        });

        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('uses inactive session bindings when the tracked child has already exited', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));
        const resolveInactiveSession = vi.fn(async () => ({
            connectedServices: {
                v: 2 as const,
                bindingsByServiceId: {
                    'happier.agent.codex/openai-codex': {
                        source: 'connected' as const,
                        selection: 'group' as const,
                        groupId: 'group-1',
                        profileId: 'fallback',
                    },
                },
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [],
            resolveInactiveSession,
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(resolveInactiveSession).toHaveBeenCalledWith({ sessionId: 'sess_1' });
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'group-1',
            observedProfileId: 'primary',
            reason: 'usage_limit',
        }));
    });

    it('uses durable tracked session metadata bindings when active spawn options lost connected services', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                happySessionMetadataFromLocalWebhook: {
                    path: '/tmp/project',
                    homeDir: '/tmp/home',
                    happyHomeDir: '/tmp/home/.happier',
                    happyLibDir: '/tmp/home/.happier/lib',
                    happyToolsDir: '/tmp/home/.happier/tools',
                    host: 'test-host',
                    connectedServices: {
                        v: 2,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
                spawnOptions: {
                    directory: '/tmp/project',
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
        }));
    });

    it('prefers durable metadata group bindings over profile-only spawn and child-env fallbacks', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                happySessionMetadataFromLocalWebhook: {
                    path: '/tmp/project',
                    homeDir: '/tmp/home',
                    happyHomeDir: '/tmp/home/.happier',
                    happyLibDir: '/tmp/home/.happier/lib',
                    happyToolsDir: '/tmp/home/.happier/tools',
                    host: 'test-host',
                    connectedServices: {
                        v: 2,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'profile',
                                profileId: 'primary',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'profile',
                            serviceId: 'happier.agent.codex/openai-codex',
                            profileId: 'primary',
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
        }));
    });

    it('continues the interrupted turn when runtime recovery observes an already-applied generation', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const emitSessionEvent = vi.fn();
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 2 },
        });

        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            tracked: expect.objectContaining({ happySessionId: 'sess_1' }),
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.codex/openai-codex:group:group-1:backup:2',
            action: 'hot_applied',
            normalizedBindings: {
                v: 2,
                bindingsByServiceId: {
                    'happier.agent.codex/openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'group-1',
                    },
                },
            },
        }));
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('does not continue when an observed generation still names the failed account', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'primary',
            generation: 2,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_same_failed_account',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.claude/claude-subscription': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_same_failed_account',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.claude/claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                resetsAtMs: null,
                retryAfterMs: null,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'observed_generation',
                activeProfileId: 'primary',
                generation: 2,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });

        expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    });

    it('settles a superseding generation before continuing the interrupted turn', async () => {
        const order: string[] = [];
        const settleSupersedingRuntimeGroupGeneration = vi.fn(async () => {
            order.push('settled');
            return { serviceId: 'happier.agent.codex/openai-codex', groupId: 'group-1', profileId: 'current', generation: 3,
                credentialRevision: 'csr_cccccccccccccccccccccc', proof: { status: 'verified' as const, source: 'provider_application' } };
        });
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {
            order.push('continued');
        });
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'superseded_after_apply' as const,
            activeProfileId: 'current',
            generation: 3,
            credentialRevision: 'csr_cccccccccccccccccccccc',
            adoptedProfileId: 'backup',
            adoptedGeneration: 2,
            adoptedCredentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            reconciliationDisposition: 'superseded_after_apply' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            settleSupersedingRuntimeGroupGeneration,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired',
                limitCategory: 'auth_invalid',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: null,
                quotaScope: 'account',
                providerLimitId: null,
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toMatchObject({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'current', generation: 3 },
        });

        expect(settleSupersedingRuntimeGroupGeneration).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'group-1',
            fromProfileId: 'primary',
            result: expect.objectContaining({ status: 'superseded_after_apply', activeProfileId: 'current', generation: 3 }),
        });
        expect(order).toEqual(['settled', 'continued']);
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            action: 'hot_applied',
            attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.codex/openai-codex:group:group-1:current:3',
        }));
    });

    it('keeps the provider-reported failed profile when the tracked group selection already advanced', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const emitSessionEvent = vi.fn();
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'hot_apply' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(111), startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'backup',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'happier.agent.codex/openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'backup',
                            fallbackProfileId: 'primary',
                            generation: 2,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 2, mode: 'hot_apply' },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'group-1',
            observedProfileId: 'primary',
        }));
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.codex/openai-codex:group:group-1:backup:2',
            action: 'hot_applied',
        }));
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('does not let stale provider-proof metadata veto a newer observed generation', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 5,
        }));
        const pendingIntent: RuntimeAuthRecoveryIntent = {
            v: 1,
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            profileId: null,
            groupId: 'group-1',
            status: 'resumed_awaiting_proof',
            armedAtMs: 1_000,
            nextRetryAtMs: 6_000,
            attemptCount: 1,
            maxAttempts: 5,
            switchesThisTurn: 1,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            failurePhase: 'handler',
            failureReason: 'classified_failure_reported',
            lastError: 'usage_limit',
            lastErrorClassification: { kind: 'rate_limited', retryable: true },
            pendingTargetProfileId: 'backup',
            pendingTargetGeneration: 2,
            terminalAtMs: null,
            terminalReason: null,
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                profileId: 'primary',
                                groupId: 'group-1',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 5 },
        });

        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.codex/openai-codex:group:group-1:backup:5',
            action: 'hot_applied',
        }));
    });

    it('re-enqueues the deterministic continuation when stale provider-proof metadata still exists', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));
        const pendingIntent: RuntimeAuthRecoveryIntent = {
            v: 1,
            sessionId: 'sess_1',
            serviceId: 'happier.agent.codex/openai-codex',
            profileId: null,
            groupId: 'group-1',
            status: 'resumed_awaiting_proof',
            armedAtMs: 1_000,
            nextRetryAtMs: 6_000,
            attemptCount: 1,
            maxAttempts: 5,
            switchesThisTurn: 1,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            failurePhase: 'handler',
            failureReason: 'classified_failure_reported',
            lastError: 'usage_limit',
            lastErrorClassification: { kind: 'rate_limited', retryable: true },
            pendingTargetProfileId: 'backup',
            pendingTargetGeneration: 2,
            terminalAtMs: null,
            terminalReason: null,
        };

        const legacyRecoveryMetadata = {
            runtimeAuthRecovery: {
                readForSession: () => [pendingIntent],
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            ...legacyRecoveryMetadata,
            getChildren: () => [{
                trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                profileId: 'primary',
                                groupId: 'group-1',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 2 },
        });

        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.codex/openai-codex:group:group-1:backup:2',
            action: 'hot_applied',
        }));
    });
});
