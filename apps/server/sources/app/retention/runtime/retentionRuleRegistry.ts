import { accountTierWhere, type LimitTable } from '@/app/plans/accountLimits';
import type { RetentionSessionWhere } from '@/app/retention/retentionEligibleSessionWhere';
import { RETENTION_DAY_MS } from '@/app/retention/retentionNotice';
import type { RetentionDomainPolicies, RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';
import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';

import { runAccountChangeRetentionRule } from '@/app/retention/rules/accountChangeRetentionRule';
import { createAutomationRunEventRetentionRule } from '@/app/retention/rules/automationRunEventRetentionRule';
import { createAutomationRunRetentionRule } from '@/app/retention/rules/automationRunRetentionRule';
import { createAuthPairingSessionRetentionRule } from '@/app/retention/rules/authPairingSessionRetentionRule';
import { createGlobalLockRetentionRule } from '@/app/retention/rules/globalLockRetentionRule';
import { createPublicShareAccessLogRetentionRule } from '@/app/retention/rules/publicShareAccessLogRetentionRule';
import { createRepeatKeyRetentionRule } from '@/app/retention/rules/repeatKeyRetentionRule';
import {
    runSessionMessageRetentionRule,
    type SessionMessageRetentionCursor,
} from '@/app/retention/rules/sessionMessageRetentionRule';
import {
    runSessionSidechainMessageRetentionRule,
    type SidechainRetentionCursor,
} from '@/app/retention/rules/sessionSidechainMessageRetentionRule';
import { createSessionShareAccessLogRetentionRule } from '@/app/retention/rules/sessionShareAccessLogRetentionRule';
import { runSessionRetentionRule, type SessionRetentionCursor } from '@/app/retention/rules/sessionRetentionRule';
import { createTerminalAuthRequestRetentionRule } from '@/app/retention/rules/terminalAuthRequestRetentionRule';
import { createAccountAuthRequestRetentionRule } from '@/app/retention/rules/accountAuthRequestRetentionRule';
import { createUserFeedItemRetentionRule } from '@/app/retention/rules/userFeedItemRetentionRule';
import { createVoiceSessionLeaseRetentionRule } from '@/app/retention/rules/voiceSessionLeaseRetentionRule';

export type RetentionRuleResult = Readonly<{
    id: string;
    deleted: number;
    candidatesExamined?: number;
    hasMore?: boolean;
    tier?: string;
    stopReason?: 'config_invalid';
}>;

export type RetentionRule = Readonly<{
    id: string;
    requiresSessionNotice?: true;
    run: (params: {
        policy: RetentionPolicy;
        limitTable?: LimitTable;
        batchSize: number;
        dryRun: boolean;
        maxDeletesPerRulePerRun: number;
        maxCandidatesPerRulePerRun?: number;
        shouldContinue?: () => boolean;
        now: Date;
    }) => Promise<RetentionRuleResult>;
}>;

export type RetentionDomainPolicyConfig = Readonly<
    | { kind: 'inactive'; modeKey: string; durationKey: string }
    | { kind: 'age'; modeKey: string; durationKey: string }
>;

type RetentionDomainDefinition = Readonly<{
    id: keyof RetentionDomainPolicies;
    policyConfig: RetentionDomainPolicyConfig;
    createRule: () => RetentionRule;
}>;

function ageConfig(envName: string): RetentionDomainPolicyConfig {
    return {
        kind: 'age',
        modeKey: `HAPPIER_SERVER_RETENTION__${envName}__MODE`,
        durationKey: `HAPPIER_SERVER_RETENTION__${envName}__DAYS`,
    };
}

function createTieredRule(
    id: 'sessions' | 'sessionSidechainMessages',
    limitKey: 'sessionRetentionDays' | 'subagentRetentionDays',
    runTier: (params: Parameters<RetentionRule['run']>[0], cutoff: Date, tier: {
        id: string;
        sessionWhere: RetentionSessionWhere;
    }) => Promise<Omit<RetentionRuleResult, 'id'>>,
): RetentionRule {
    let index = 0;
    return {
        id,
        requiresSessionNotice: true,
        async run(params) {
            const { limitTable, now } = params;
            if (!params.policy.enabled || !limitTable) return { id, deleted: 0, hasMore: false };
            if (!limitTable.ok) return { id, deleted: 0, hasMore: false, stopReason: 'config_invalid' };
            const tiers = ['base', ...limitTable.planOrder];
            while (index < tiers.length && (!params.shouldContinue || params.shouldContinue())) {
                const tierId = tiers[index]!;
                const limits = tierId === 'base'
                    ? limitTable.base
                    : limitTable.plans.get(tierId)?.limits;
                const days = limits?.[limitKey];
                if (days == null) {
                    index++;
                    continue;
                }
                const result = await runTier(params, new Date(now.getTime() - days * RETENTION_DAY_MS), {
                    id: tierId,
                    sessionWhere: { account: { is: accountTierWhere(tierId, limitTable, now) } },
                });
                if (result.hasMore) return { id, ...result, tier: tierId };
                index++;
                if (result.deleted > 0 || result.candidatesExamined) {
                    return { id, ...result, tier: tierId, hasMore: index < tiers.length };
                }
            }
            return { id, deleted: 0, hasMore: index < tiers.length };
        },
    };
}

const RETENTION_DOMAIN_DEFINITIONS = Object.freeze({
    sessions: {
        id: 'sessions',
        policyConfig: {
            kind: 'inactive',
            modeKey: 'HAPPIER_SERVER_RETENTION__SESSIONS__MODE',
            durationKey: 'HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS',
        },
        createRule: () => {
            let after: SessionRetentionCursor | undefined;
            return createTieredRule('sessions', 'sessionRetentionDays', async (params, cutoff, tier) => {
                const result = await runSessionRetentionRule({
                    ...params,
                    cutoff,
                    batchSize: Math.min(params.batchSize, params.maxCandidatesPerRulePerRun ?? params.batchSize),
                    after,
                    tierWhere: tier.sessionWhere,
                });
                after = result.hasMore ? result.nextCursor ?? undefined : undefined;
                return result;
            });
        },
    },
    sessionMessages: {
        id: 'sessionMessages',
        policyConfig: ageConfig('SESSION_MESSAGES'),
        createRule: () => {
            let cursor: SessionMessageRetentionCursor | null = null;
            return {
                id: 'sessionMessages',
                requiresSessionNotice: true,
                run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, maxCandidatesPerRulePerRun, shouldContinue, now }) => {
                    const domain = resolveEffectiveRetentionDomains(policy).sessionMessages;
                    if (domain.mode === 'keep_forever') return { id: 'sessionMessages', deleted: 0, hasMore: false };
                    const cutoff = new Date(now.getTime() - domain.days * 24 * 60 * 60 * 1000);
                    const result = await runSessionMessageRetentionRule({
                        cutoff,
                        batchSize,
                        dryRun,
                        maxDeletesPerRulePerRun,
                        maxCandidatesPerRulePerRun,
                        shouldContinue,
                        startCursor: cursor,
                    });
                    cursor = result.nextCursor;
                    return { id: 'sessionMessages', ...result };
                },
            };
        },
    },
    sessionSidechainMessages: {
        id: 'sessionSidechainMessages',
        policyConfig: ageConfig('SESSION_SIDECHAIN_MESSAGES'),
        createRule: () => {
            let dryRunCursor: SidechainRetentionCursor | null | undefined;
            return createTieredRule('sessionSidechainMessages', 'subagentRetentionDays', async (params, cutoff, tier) => {
                const result = await runSessionSidechainMessageRetentionRule({
                    ...params,
                    cutoff,
                    tier,
                    ...(params.dryRun ? { startCursor: dryRunCursor ?? null, persistCursor: false } : null),
                });
                if (params.dryRun) dryRunCursor = result.hasMore ? result.nextCursor : null;
                return result;
            });
        },
    },
    accountChanges: {
        id: 'accountChanges',
        policyConfig: ageConfig('ACCOUNT_CHANGES'),
        createRule: () => {
            let dryRunOffset = 0;
            return {
                id: 'accountChanges',
                run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
                    const domain = resolveEffectiveRetentionDomains(policy).accountChanges;
                    if (domain.mode === 'keep_forever') return { id: 'accountChanges', deleted: 0, hasMore: false };
                    const cutoff = new Date(now.getTime() - domain.days * 24 * 60 * 60 * 1000);
                    const result = await runAccountChangeRetentionRule({
                        cutoff,
                        batchSize,
                        dryRun,
                        dryRunOffset: dryRun ? dryRunOffset : undefined,
                        maxDeletesPerRulePerRun,
                    });
                    if (dryRun) dryRunOffset += result.candidatesExamined;
                    return { id: 'accountChanges', ...result };
                },
            };
        },
    },
    voiceSessionLeases: { id: 'voiceSessionLeases', policyConfig: ageConfig('VOICE_SESSION_LEASES'), createRule: createVoiceSessionLeaseRetentionRule },
    userFeedItems: { id: 'userFeedItems', policyConfig: ageConfig('USER_FEED_ITEMS'), createRule: createUserFeedItemRetentionRule },
    sessionShareAccessLogs: { id: 'sessionShareAccessLogs', policyConfig: ageConfig('SESSION_SHARE_ACCESS_LOGS'), createRule: createSessionShareAccessLogRetentionRule },
    publicShareAccessLogs: { id: 'publicShareAccessLogs', policyConfig: ageConfig('PUBLIC_SHARE_ACCESS_LOGS'), createRule: createPublicShareAccessLogRetentionRule },
    terminalAuthRequests: { id: 'terminalAuthRequests', policyConfig: ageConfig('TERMINAL_AUTH_REQUESTS'), createRule: createTerminalAuthRequestRetentionRule },
    accountAuthRequests: { id: 'accountAuthRequests', policyConfig: ageConfig('ACCOUNT_AUTH_REQUESTS'), createRule: createAccountAuthRequestRetentionRule },
    authPairingSessions: { id: 'authPairingSessions', policyConfig: ageConfig('AUTH_PAIRING_SESSIONS'), createRule: createAuthPairingSessionRetentionRule },
    repeatKeys: { id: 'repeatKeys', policyConfig: ageConfig('REPEAT_KEYS'), createRule: createRepeatKeyRetentionRule },
    globalLocks: { id: 'globalLocks', policyConfig: ageConfig('GLOBAL_LOCKS'), createRule: createGlobalLockRetentionRule },
    automationRuns: { id: 'automationRuns', policyConfig: ageConfig('AUTOMATION_RUNS'), createRule: createAutomationRunRetentionRule },
    automationRunEvents: { id: 'automationRunEvents', policyConfig: ageConfig('AUTOMATION_RUN_EVENTS'), createRule: createAutomationRunEventRetentionRule },
} satisfies Record<keyof RetentionDomainPolicies, RetentionDomainDefinition>);

export function readRetentionDomainDefinitions(): readonly RetentionDomainDefinition[] {
    return Object.values(RETENTION_DOMAIN_DEFINITIONS);
}

export function createRetentionRuleRegistry(): readonly RetentionRule[] {
    return Object.freeze(readRetentionDomainDefinitions().map((definition) => definition.createRule()));
}
