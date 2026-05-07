import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { Credentials } from '@/persistence';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';
import { logger } from '@/ui/logger';

function selectUnambiguousConnectedProfileId(params: Readonly<{
  serviceId: ConnectedServiceId;
  profiles: Awaited<ReturnType<ApiClient['listConnectedServiceProfiles']>>['profiles'];
}>): string | null {
  const connectedProfiles = params.profiles.filter((entry) => entry.status === 'connected');
  const selectedProfileId = connectedProfiles[0]?.profileId ?? null;
  if (connectedProfiles.length > 1 && selectedProfileId) {
    logger.debug(
      `[API] [SCM] Multiple connected profiles are available for ${params.serviceId}; selecting ${selectedProfileId} from server-ordered results.`,
    );
  }

  return selectedProfileId;
}

export function createScmConnectedAccountCredentialResolver(params: Readonly<{
  credentials: Credentials;
  api: ApiClient;
}>): ScmConnectedAccountCredentialResolver {
  return {
    resolveCredential: async (serviceId) => {
      try {
        const profiles = await params.api.listConnectedServiceProfiles({ serviceId });
        const profileId = selectUnambiguousConnectedProfileId({
          serviceId,
          profiles: profiles.profiles,
        });
        if (!profileId) return null;
        const records = await resolveConnectedServiceCredentials({
          credentials: params.credentials,
          api: params.api,
          bindings: [{ serviceId, profileId }],
        });
        return records.get(serviceId) ?? null;
      } catch (error) {
        logger.debug(`[API] [SCM] Failed to resolve connected account credential:`, error);
        return null;
      }
    },
  };
}
