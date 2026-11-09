import type { QualifiedConnectedAccountGroupV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';

/** Resolve Home policy once per publication, shared by list, replies and profile pushes. */
export function projectGroupPolicyForFeature(
    homeEnv: NodeJS.ProcessEnv,
): (group: QualifiedConnectedAccountGroupV4) => QualifiedConnectedAccountGroupV4 {
    const autoQuotaResetEnabled = isServerFeatureEnabledForRequest('connectedServices.autoQuotaReset', homeEnv);
    const autoDisablePlanInvalidEnabled = isServerFeatureEnabledForRequest('connectedServices.autoDisablePlanInvalid', homeEnv);
    const poolQuotaLimitSelectionEnabled = isServerFeatureEnabledForRequest('connectedServices.poolQuotaLimitSelection', homeEnv);
    return group => {
        let policy = group.policy;
        if (!autoQuotaResetEnabled) {
            const { autoUseQuotaResetsWhenExhausted: _quotaReset, ...projected } = policy;
            policy = projected;
        }
        if (!autoDisablePlanInvalidEnabled) {
            const { autoDisablePlanInvalidAccounts: _autoDisable, ...projected } = policy;
            policy = projected;
        }
        if (!poolQuotaLimitSelectionEnabled) {
            const { quotaLimitSelection: _quotaLimitSelection, ...projected } = policy;
            policy = projected;
        }
        return policy === group.policy ? group : { ...group, policy };
    };
}
