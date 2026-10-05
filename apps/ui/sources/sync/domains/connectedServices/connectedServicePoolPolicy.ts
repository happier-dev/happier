import type { ConnectedServiceAuthGroupPolicyV1 } from '@happier-dev/protocol';
import { t } from '@/text';

/** Shared copy for pool details and collection summaries; selection remains daemon-owned. */
export function getPoolStrategyPresentation(strategy: ConnectedServiceAuthGroupPolicyV1['strategy']) {
    switch (strategy) {
        case 'expiry_first': return {
            label: t('connectedServicesPool.strategyExpiryFirst'),
            description: t('connectedServicesPool.strategyExpiryFirstDescription'),
            lead: t('connectedServicesPool.leadExpiryFirst'),
            summary: t('connectedServicesPool.strategyExpiryFirst'),
        };
        case 'least_limited': return {
            label: t('connectedServicesPool.strategyLeastLimited'),
            description: t('connectedServicesPool.strategyLeastLimitedDescription'),
            lead: t('connectedServicesPool.leadLeastLimited'),
            summary: t('connectedServicesSettings.poolRuleMostLeft'),
        };
        case 'priority': return {
            label: t('connectedServicesPool.strategyInOrder'),
            description: t('connectedServicesPool.strategyInOrderDescription'),
            lead: t('connectedServicesPool.leadInOrder'),
            summary: t('connectedServicesSettings.poolRuleInOrder'),
        };
        case 'manual': return {
            label: t('connectedServicesPool.strategyManual'),
            description: t('connectedServicesPool.strategyManualDescription'),
            lead: null,
            summary: t('connectedServicesSettings.poolRuleManual'),
        };
    }
}

/** Whether a pool's policy permits automatic movement when an account runs out. */
export function isPoolUsageLimitSwitchEnabled(policy: ConnectedServiceAuthGroupPolicyV1): boolean {
    return policy.strategy !== 'manual' && policy.autoSwitch && policy.switchOn.usageLimit;
}
