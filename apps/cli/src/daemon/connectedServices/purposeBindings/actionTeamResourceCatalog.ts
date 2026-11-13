import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { readSessionTeamCredentialResourceCatalog } from '@/session/services/sessionTeamCredentialCatalog';

/** Session-free Action forms use the same entitled, paginated Team catalog as launch. */
export function createConnectedAccountActionTeamResourceCatalogReader(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
}>) {
  return async (signal: AbortSignal) => {
    // A Home without this optional family has no Team choices. Keep every
    // authorization, transport, and malformed-response failure visible.
    let catalogAbsent = false;
    try {
      return await readSessionTeamCredentialResourceCatalog({ applications: [], signal,
        homeDomainAction: async request => {
          const result = await input.homeDomainAction(request);
          catalogAbsent = result !== null && typeof result === 'object' && 'errorCode' in result
            && (result.errorCode === 'teams_unavailable' || result.errorCode === 'feature_disabled'
              || result.errorCode === 'unsupported_action');
          return result;
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      if (catalogAbsent) return [];
      throw error;
    }
  };
}
