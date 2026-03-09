import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';
import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';

import { runAccountChangeRetentionRule } from '@/app/retention/rules/accountChangeRetentionRule';
import { createAutomationRunEventRetentionRule } from '@/app/retention/rules/automationRunEventRetentionRule';
import { createAutomationRunRetentionRule } from '@/app/retention/rules/automationRunRetentionRule';
import { createAuthPairingSessionRetentionRule } from '@/app/retention/rules/authPairingSessionRetentionRule';
import { createGlobalLockRetentionRule } from '@/app/retention/rules/globalLockRetentionRule';
import { createPublicShareAccessLogRetentionRule } from '@/app/retention/rules/publicShareAccessLogRetentionRule';
import { createRepeatKeyRetentionRule } from '@/app/retention/rules/repeatKeyRetentionRule';
import { createSessionShareAccessLogRetentionRule } from '@/app/retention/rules/sessionShareAccessLogRetentionRule';
import { runSessionRetentionRule } from '@/app/retention/rules/sessionRetentionRule';
import { createTerminalAuthRequestRetentionRule } from '@/app/retention/rules/terminalAuthRequestRetentionRule';
import { createAccountAuthRequestRetentionRule } from '@/app/retention/rules/accountAuthRequestRetentionRule';
import { createUserFeedItemRetentionRule } from '@/app/retention/rules/userFeedItemRetentionRule';
import { createVoiceSessionLeaseRetentionRule } from '@/app/retention/rules/voiceSessionLeaseRetentionRule';

export type RetentionRuleResult = Readonly<{
    id: string;
    deleted: number;
}>;

export type RetentionRule = Readonly<{
    id: string;
    run: (params: { policy: RetentionPolicy; batchSize: number; dryRun: boolean; maxDeletesPerRulePerRun: number; now: Date }) => Promise<RetentionRuleResult>;
}>;

export function createRetentionRuleRegistry(): readonly RetentionRule[] {
    return Object.freeze([
        {
            id: 'sessions',
            run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
                const domains = resolveEffectiveRetentionDomains(policy);
                if (domains.sessions.mode === 'keep_forever') {
                    return { id: 'sessions', deleted: 0 };
                }
                const cutoff = new Date(now.getTime() - domains.sessions.inactivityDays * 24 * 60 * 60 * 1000);
                return {
                    id: 'sessions',
                    ...(await runSessionRetentionRule({ cutoff, batchSize, dryRun, maxDeletesPerRulePerRun })),
                };
            },
        },
        {
            id: 'accountChanges',
            run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
                const domains = resolveEffectiveRetentionDomains(policy);
                if (domains.accountChanges.mode === 'keep_forever') {
                    return { id: 'accountChanges', deleted: 0 };
                }
                const cutoff = new Date(now.getTime() - domains.accountChanges.days * 24 * 60 * 60 * 1000);
                return {
                    id: 'accountChanges',
                    ...(await runAccountChangeRetentionRule({ cutoff, batchSize, dryRun, maxDeletesPerRulePerRun })),
                };
            },
        },
        createVoiceSessionLeaseRetentionRule(),
        createUserFeedItemRetentionRule(),
        createSessionShareAccessLogRetentionRule(),
        createPublicShareAccessLogRetentionRule(),
        createTerminalAuthRequestRetentionRule(),
        createAccountAuthRequestRetentionRule(),
        createAuthPairingSessionRetentionRule(),
        createRepeatKeyRetentionRule(),
        createGlobalLockRetentionRule(),
        createAutomationRunRetentionRule(),
        createAutomationRunEventRetentionRule(),
    ]);
}
