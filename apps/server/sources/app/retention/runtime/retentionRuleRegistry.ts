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
    runSessionSidechainMessageRetentionRule,
    type SidechainRetentionCursor,
} from '@/app/retention/rules/sessionSidechainMessageRetentionRule';
import { createSessionShareAccessLogRetentionRule } from '@/app/retention/rules/sessionShareAccessLogRetentionRule';
import { runSessionRetentionRule } from '@/app/retention/rules/sessionRetentionRule';
import { createTerminalAuthRequestRetentionRule } from '@/app/retention/rules/terminalAuthRequestRetentionRule';
import { createAccountAuthRequestRetentionRule } from '@/app/retention/rules/accountAuthRequestRetentionRule';
import { createUsageEventRetentionRule } from '@/app/retention/rules/usageEventRetentionRule';
import { createUserFeedItemRetentionRule } from '@/app/retention/rules/userFeedItemRetentionRule';
import { createVoiceSessionLeaseRetentionRule } from '@/app/retention/rules/voiceSessionLeaseRetentionRule';

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

export type RetentionDomainPolicyConfig = Readonly<
    | { kind: 'inactive'; modeKey: string; durationKey: string }
    | { kind: 'age'; modeKey: string; durationKey: string }
>;

type RetentionDomainDefinition = Readonly<{
    id: keyof RetentionDomainPolicies;
    policyConfig: RetentionDomainPolicyConfig;
    /** Account-owned retention that remains active without an operator age policy. */
    runsWhenGlobalPolicyIsDisabled?: true;
    createRule: () => RetentionRule;
}>;

function ageConfig(envName: string): RetentionDomainPolicyConfig {
    return {
        kind: 'age',
        modeKey: `HAPPIER_SERVER_RETENTION__${envName}__MODE`,
        durationKey: `HAPPIER_SERVER_RETENTION__${envName}__DAYS`,
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
            let afterSessionId: string | undefined;
            return {
                id: 'sessions',
                run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
                    const domain = resolveEffectiveRetentionDomains(policy).sessions;
                    if (domain.mode === 'keep_forever') return { id: 'sessions', deleted: 0, hasMore: false };
                    const cutoff = new Date(now.getTime() - domain.inactivityDays * 24 * 60 * 60 * 1000);
                    const result = await runSessionRetentionRule({ cutoff, batchSize, dryRun, afterSessionId, maxDeletesPerRulePerRun });
                    afterSessionId = result.nextSessionId ?? undefined;
                    return { id: 'sessions', ...result };
                },
            };
        },
    },
    sessionSidechainMessages: {
        id: 'sessionSidechainMessages',
        policyConfig: ageConfig('SESSION_SIDECHAIN_MESSAGES'),
        createRule: () => {
            let dryRunCursor: SidechainRetentionCursor | null | undefined;
            return {
                id: 'sessionSidechainMessages',
                run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, maxCandidatesPerRulePerRun, shouldContinue, now }) => {
                    const domain = resolveEffectiveRetentionDomains(policy).sessionSidechainMessages;
                    if (domain.mode === 'keep_forever') return { id: 'sessionSidechainMessages', deleted: 0, hasMore: false };
                    const cutoff = new Date(now.getTime() - domain.days * 24 * 60 * 60 * 1000);
                    const result = await runSessionSidechainMessageRetentionRule({
                        cutoff,
                        batchSize,
                        dryRun,
                        maxDeletesPerRulePerRun,
                        maxCandidatesPerRulePerRun,
                        shouldContinue,
                        ...(dryRun ? { startCursor: dryRunCursor ?? null, persistCursor: false } : null),
                    });
                    if (dryRun) dryRunCursor = result.nextCursor;
                    return { id: 'sessionSidechainMessages', ...result };
                },
            };
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
    usageEvents: { id: 'usageEvents', policyConfig: ageConfig('USAGE_EVENTS'), createRule: createUsageEventRetentionRule },
    voiceSessionLeases: { id: 'voiceSessionLeases', policyConfig: ageConfig('VOICE_SESSION_LEASES'), createRule: createVoiceSessionLeaseRetentionRule },
    userFeedItems: { id: 'userFeedItems', policyConfig: ageConfig('USER_FEED_ITEMS'), createRule: createUserFeedItemRetentionRule },
    sessionShareAccessLogs: { id: 'sessionShareAccessLogs', policyConfig: ageConfig('SESSION_SHARE_ACCESS_LOGS'), createRule: createSessionShareAccessLogRetentionRule },
    publicShareAccessLogs: { id: 'publicShareAccessLogs', policyConfig: ageConfig('PUBLIC_SHARE_ACCESS_LOGS'), createRule: createPublicShareAccessLogRetentionRule },
    terminalAuthRequests: { id: 'terminalAuthRequests', policyConfig: ageConfig('TERMINAL_AUTH_REQUESTS'), createRule: createTerminalAuthRequestRetentionRule },
    accountAuthRequests: { id: 'accountAuthRequests', policyConfig: ageConfig('ACCOUNT_AUTH_REQUESTS'), createRule: createAccountAuthRequestRetentionRule },
    authPairingSessions: { id: 'authPairingSessions', policyConfig: ageConfig('AUTH_PAIRING_SESSIONS'), createRule: createAuthPairingSessionRetentionRule },
    repeatKeys: {
        id: 'repeatKeys',
        policyConfig: ageConfig('REPEAT_KEYS'),
        runsWhenGlobalPolicyIsDisabled: true,
        createRule: createRepeatKeyRetentionRule,
    },
    globalLocks: { id: 'globalLocks', policyConfig: ageConfig('GLOBAL_LOCKS'), createRule: createGlobalLockRetentionRule },
    automationRuns: {
        id: 'automationRuns',
        policyConfig: ageConfig('AUTOMATION_RUNS'),
        runsWhenGlobalPolicyIsDisabled: true,
        createRule: createAutomationRunRetentionRule,
    },
    automationRunEvents: { id: 'automationRunEvents', policyConfig: ageConfig('AUTOMATION_RUN_EVENTS'), createRule: createAutomationRunEventRetentionRule },
} satisfies Record<keyof RetentionDomainPolicies, RetentionDomainDefinition>);

export function readRetentionDomainDefinitions(): readonly RetentionDomainDefinition[] {
    return Object.values(RETENTION_DOMAIN_DEFINITIONS);
}

/**
 * The registry, rather than a second startup list, owns which domains have an
 * Account-level contract independent of global operator retention settings.
 */
export function hasRetentionRulesThatRunWhenGlobalPolicyIsDisabled(): boolean {
    return readRetentionDomainDefinitions().some(
        (definition) => definition.runsWhenGlobalPolicyIsDisabled === true,
    );
}

export function createRetentionRuleRegistry(): readonly RetentionRule[] {
    return Object.freeze(readRetentionDomainDefinitions().map((definition) => definition.createRule()));
}
