import {
  HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY,
  readSessionConnectedServiceBrokerSelectionIdentity,
} from '@/agent/runtime/sessionConnectedServiceBrokerSelectionIdentityEnv';
import type { TrackedSession } from '@/daemon/types';
import { OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV } from '@/backends/opencode/brokerPlugin';
import { PI_BROKER_SELECTION_IDENTITY_ENV } from '@/backends/pi/brokerExtension';

const LEGACY_PROVIDER_BROKER_SELECTION_IDENTITY_ENV_KEYS = [
  OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
] as const;

export function readTrackedSessionBrokerSelectionIdentity(tracked: Pick<
  TrackedSession,
  'happySessionMetadataFromLocalWebhook' | 'spawnOptions'
>): string | null {
  const currentIdentity = readSessionConnectedServiceBrokerSelectionIdentity(
    tracked.happySessionMetadataFromLocalWebhook?.connectedServiceBrokerSelectionIdentityV1,
  ) ?? readSessionConnectedServiceBrokerSelectionIdentity(
    tracked.spawnOptions?.environmentVariables?.[
      HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY
    ],
  );
  if (currentIdentity) return currentIdentity;

  // Released/current predecessor runners persist provider-owned env names in daemon markers.
  // Keep this tolerant reader at the one metadata boundary; all current writers publish the
  // generic identity above and no authorization decision is duplicated here.
  for (const envKey of LEGACY_PROVIDER_BROKER_SELECTION_IDENTITY_ENV_KEYS) {
    const legacyIdentity = readSessionConnectedServiceBrokerSelectionIdentity(
      tracked.spawnOptions?.environmentVariables?.[envKey],
    );
    if (legacyIdentity) return legacyIdentity;
  }
  return null;
}
