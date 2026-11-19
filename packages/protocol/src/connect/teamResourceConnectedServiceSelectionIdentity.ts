import { buildQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import type { TeamResourceConnectedServiceSelectionV2 } from './connectedServiceBindings.js';

/** The exact Session/recipient selection identity, independent of absent optional wire fields. */
export function teamResourceConnectedServiceSelectionKey(binding: TeamResourceConnectedServiceSelectionV2): string {
    return JSON.stringify([
        binding.resourceId,
        binding.deliveryMode,
        binding.deliveryMode === 'direct' ? buildQualifiedPluginContributionKey(binding.disclosedMember.service) : null,
        binding.deliveryMode === 'direct' ? binding.disclosedMember.accountId : null,
    ]);
}

export function areTeamResourceConnectedServiceSelectionsEqual(
    left: TeamResourceConnectedServiceSelectionV2,
    right: TeamResourceConnectedServiceSelectionV2,
): boolean {
    return teamResourceConnectedServiceSelectionKey(left) === teamResourceConnectedServiceSelectionKey(right);
}
