import { TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1, type TeamCredentialHomeActionIdV1 } from '../../teams/credentials/actionsV1.js';
import type { TeamCredentialResourceAudienceInputV1 } from '../../teams/credentials/resourceV1.js';

function hasNativeAudience(input: Partial<TeamCredentialResourceAudienceInputV1>): boolean {
  return input.allMembersAllowedRoutes?.includes('vendor-native') === true
    || input.groupGrants?.some(grant => grant.allowedRoutes.includes('vendor-native')) === true
    || input.memberGrants?.some(grant => grant.allowedRoutes.includes('vendor-native')) === true;
}

/** Native export consent reaches the same Action admission on every surface.
 * Reversible metadata and existing broker/direct editor review keep their policy. */
function readTeamCredentialMutationDisclosure(actionId: TeamCredentialHomeActionIdV1, input: unknown): 'native' | 'none' | 'invalid' {
  switch (actionId) {
    case 'teams.credentials.create': {
      const parsed = TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return 'invalid';
      return parsed.data.deliveryPolicy.preferredAllowedModes.includes('vendor-native')
        || hasNativeAudience(parsed.data) ? 'native' : 'none';
    }
    case 'teams.credentials.update': {
      const parsed = TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return 'invalid';
      return parsed.data.deliveryPolicy?.preferredAllowedModes.includes('vendor-native') === true
        || parsed.data.replacement?.custodian?.deliveryPolicy.preferredAllowedModes.includes('vendor-native') === true
        || (parsed.data.replacement !== undefined && hasNativeAudience(parsed.data.replacement)) ? 'native' : 'none';
    }
    case 'teams.credentials.audience.set': {
      const parsed = TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return 'invalid';
      return hasNativeAudience(parsed.data) ? 'native' : 'none';
    }
    default: return 'invalid';
  }
}

export function teamCredentialMutationRequiresUiConfirmation(actionId: TeamCredentialHomeActionIdV1, input: unknown): boolean {
  return readTeamCredentialMutationDisclosure(actionId, input) !== 'none';
}

export function teamCredentialNativeDisclosureApprovalSummary(actionId: TeamCredentialHomeActionIdV1, input: unknown): string | null {
  if (readTeamCredentialMutationDisclosure(actionId, input) !== 'native') return null;
  return 'The selected credential key may be disclosed to Vercel’s control plane, separate from the provisioning token. Vercel keeps the key outside the guest, but the source custodian and Vercel remain trusted. Installed requests bypass Happier’s per-request authorization, body/model policy and request, token or cost limits. Vendor matchers narrow key substitution; they do not inspect model JSON or deny unmatched requests. Configure budgets and key restrictions at the Gateway/vendor; coverage is not verified here. Installed rules may continue while the controller is offline, when changes and removal cannot be guaranteed. Upstream key rotation or revocation is the independent hard stop; previously disclosed bytes cannot be recalled. Attribution is observational, not authenticated member identity or chargeback. Members sharing an OS user can read and reuse each other’s placeholders; these are not private between members.';
}
