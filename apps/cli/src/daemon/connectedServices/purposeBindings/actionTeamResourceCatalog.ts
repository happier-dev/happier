import type { ConnectedAccountPurposeTeamResource } from '@happier-dev/cli-common/connectedAccounts';
import { teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { readSessionTeamCredentialResourceCatalog } from '@/session/services/sessionTeamCredentialCatalog';

/** Session-free Action forms use the same entitled, paginated Team catalog as launch. */
export function createConnectedAccountActionTeamResourceCatalogReader(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  privateLabelOpen: NonNullable<ActionExecutorDeps['privateLabelOpen']>;
}>) {
  return async (signal: AbortSignal): Promise<readonly ConnectedAccountPurposeTeamResource[]> => {
    // A Home without this optional family has no Team choices. Keep every
    // authorization, transport, and malformed-response failure visible.
    let catalogAbsent = false;
    try {
      const resources = await readSessionTeamCredentialResourceCatalog({ applications: [], signal,
        homeDomainAction: async request => {
          const result = await input.homeDomainAction(request);
          catalogAbsent = result !== null && typeof result === 'object' && 'errorCode' in result
            && (result.errorCode === 'teams_unavailable' || result.errorCode === 'feature_disabled'
              || result.errorCode === 'unsupported_action');
          return result;
        },
      });
      return await Promise.all(resources.map(async resource => ({ ...resource,
        displayName: await input.privateLabelOpen({ binding: teamCredentialDisplayNamePrivateLabelBindingV1(resource.id),
          label: resource.displayName, readPolicy: { kind: 'team-resource' }, signal }, { surface: 'cli', signal }),
      })));
    } catch (error) {
      signal.throwIfAborted();
      if (catalogAbsent) return [];
      throw error;
    }
  };
}
