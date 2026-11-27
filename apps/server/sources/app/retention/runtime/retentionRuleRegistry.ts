import type { LimitTable } from '@/app/plans/accountLimits';
import { retainByAccountTier } from './retentionTierBatches';
import { isSessionRetentionEnforcing } from '@/app/retention/retentionNotice';
import { readRetentionDomainDefinitions, type RetentionDomainId } from '@/app/retention/config/retentionDomains';
import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';
import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';

import { runAccountChangeRetentionRule } from '@/app/retention/rules/accountChangeRetentionRule';
import { createAutomationRunEventRetentionRule } from '@/app/retention/rules/automationRunEventRetentionRule';
import { createAutomationRunRetentionRule } from '@/app/retention/rules/automationRunRetentionRule';
import { createAuthPairingSessionRetentionRule } from '@/app/retention/rules/authPairingSessionRetentionRule';
import { createGlobalLockRetentionRule } from '@/app/retention/rules/globalLockRetentionRule';
import { createHomeAdministrationEventRetentionRule } from '@/app/retention/rules/homeAdministrationEventRetentionRule';
import { createPublicShareAccessLogRetentionRule } from '@/app/retention/rules/publicShareAccessLogRetentionRule';
import { createRepeatKeyRetentionRule } from '@/app/retention/rules/repeatKeyRetentionRule';
import {
    runSessionSidechainMessageRetentionRule,
    type SidechainRetentionCursor,
} from '@/app/retention/rules/sessionSidechainMessageRetentionRule';
import { createSessionToolOutputRetentionRule } from '@/app/retention/rules/sessionToolOutputRetentionRule';
import { runSessionRetentionRule } from '@/app/retention/rules/sessionRetentionRule';
import { createTerminalAuthRequestRetentionRule } from '@/app/retention/rules/terminalAuthRequestRetentionRule';
import { createAccountAuthRequestRetentionRule } from '@/app/retention/rules/accountAuthRequestRetentionRule';
import { createUsageEventRetentionRule } from '@/app/retention/rules/usageEventRetentionRule';
import { createProviderAccountUsageHistoryRetentionRule } from '@/app/retention/rules/providerAccountUsageHistoryRetentionRule';
import { createUserFeedItemRetentionRule } from '@/app/retention/rules/userFeedItemRetentionRule';
import { createVoiceSessionLeaseRetentionRule } from '@/app/retention/rules/voiceSessionLeaseRetentionRule';
import { createIntrinsicExpiryRetentionRules } from '@/app/retention/rules/intrinsicExpiryRetentionRules';
import { createReviewRetentionRule } from '@/app/retention/rules/reviewRetentionRule';

export type RetentionRuleResult = Readonly<{
    id: string;
    deleted: number;
    candidatesExamined?: number;
    hasMore?: boolean;
}>;

export type RetentionRule = Readonly<{
    id: string;
    run: (params: {
        policy: RetentionPolicy;
        batchSize: number;
        dryRun: boolean;
        maxDeletesPerRulePerRun: number;
        maxCandidatesPerRulePerRun?: number;
        shouldContinue?: () => boolean;
        now: Date;
    }) => Promise<RetentionRuleResult>;
}>;

/**
 * One rule per retention domain (the domains themselves — ids, keys, always-run — are declared in
 * `config/retentionDomains.ts`). The `satisfies` below makes a new domain without a rule a type error.
 */
const RETENTION_RULE_FACTORIES = Object.freeze({
    sessions: (table?: LimitTable): RetentionRule => retainByAccountTier('sessions', 'sessionRetentionDays', table, policy => {
        const domain = resolveEffectiveRetentionDomains(policy).sessions;
        return domain.mode === 'delete_inactive' ? domain.inactivityDays : null;
    }, ({ days, sessionWhere }) => {
        let afterSessionId: string | undefined;
        return async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
            const cutoff = new Date(now.getTime() - days * 86_400_000);
            const result = await runSessionRetentionRule({
                cutoff, batchSize, dryRun: dryRun || (table !== undefined && !isSessionRetentionEnforcing(policy, now)),
                afterSessionId, maxDeletesPerRulePerRun, sessionWhere, now,
            });
            afterSessionId = result.nextSessionId ?? undefined;
            return { id: 'sessions', ...result };
        };
    }),
    sessionSidechainMessages: (table?: LimitTable): RetentionRule => retainByAccountTier('sessionSidechainMessages', 'subagentRetentionDays', table, policy => {
        const domain = resolveEffectiveRetentionDomains(policy).sessionSidechainMessages;
        return domain.mode === 'delete_older_than' ? domain.days : null;
    }, ({ days, key, sessionWhere }) => {
        let dryRunCursor: SidechainRetentionCursor | null | undefined;
        return async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, maxCandidatesPerRulePerRun, shouldContinue, now }) => {
            const preview = dryRun || (table !== undefined && !isSessionRetentionEnforcing(policy, now));
            const cutoff = new Date(now.getTime() - days * 86_400_000);
            const result = await runSessionSidechainMessageRetentionRule({
                cutoff,
                batchSize,
                dryRun: preview,
                maxDeletesPerRulePerRun,
                maxCandidatesPerRulePerRun,
                shouldContinue,
                sessionWhere,
                ...(key === 'legacy' ? {} : { tierKey: key }),
                ...(preview ? { startCursor: dryRunCursor ?? null, persistCursor: false } : null),
            });
            if (preview) dryRunCursor = result.nextCursor;
            return { id: 'sessionSidechainMessages', ...result };
        };
    }),
    toolOutputs: createSessionToolOutputRetentionRule,
    accountChanges: (): RetentionRule => {
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
    usageEvents: createUsageEventRetentionRule,
    providerAccountUsageHistory: createProviderAccountUsageHistoryRetentionRule,
    voiceSessionLeases: createVoiceSessionLeaseRetentionRule,
    userFeedItems: createUserFeedItemRetentionRule,
    publicShareAccessLogs: createPublicShareAccessLogRetentionRule,
    terminalAuthRequests: createTerminalAuthRequestRetentionRule,
    accountAuthRequests: createAccountAuthRequestRetentionRule,
    authPairingSessions: createAuthPairingSessionRetentionRule,
    repeatKeys: createRepeatKeyRetentionRule,
    globalLocks: createGlobalLockRetentionRule,
    automationRuns: createAutomationRunRetentionRule,
    automationRunEvents: createAutomationRunEventRetentionRule,
    homeAdministrationEvents: createHomeAdministrationEventRetentionRule,
    reviews: createReviewRetentionRule,
} satisfies Record<RetentionDomainId, () => RetentionRule>);

/**
 * The hourly sweep's rules: one per operator retention domain, then the intrinsic
 * expiry passes records carry themselves (webhook leases/credentials/deliveries,
 * Account encryption transitions), which no operator policy switches off.
 */
export function createRetentionRuleRegistry(table?: LimitTable): readonly RetentionRule[] {
    return Object.freeze([
        ...readRetentionDomainDefinitions().map((definition) => RETENTION_RULE_FACTORIES[definition.id](table)),
        ...createIntrinsicExpiryRetentionRules(),
    ]);
}
