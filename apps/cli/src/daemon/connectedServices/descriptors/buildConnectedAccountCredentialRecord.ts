import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { requireConnectedAccountDescriptor } from './connectedAccountDescriptors';

export function buildConnectedAccountOauthCredentialRecord(input: Readonly<{
  now: number;
  serviceId: ConnectedServiceId;
  profileId: string;
  payload: unknown;
}>): ConnectedServiceCredentialRecordV1 {
  const descriptor = requireConnectedAccountDescriptor(input.serviceId);
  if (!descriptor.oauth) {
    throw new Error(`Connected account does not support OAuth credentials: ${input.serviceId}`);
  }
  const mapped = descriptor.oauth.mapCredentialPayload({
    now: input.now,
    payload: input.payload,
  });
  return buildConnectedServiceCredentialRecord({
    now: input.now,
    serviceId: input.serviceId,
    profileId: input.profileId,
    kind: 'oauth',
    expiresAt: mapped.expiresAt,
    oauth: {
      accessToken: mapped.accessToken,
      refreshToken: mapped.refreshToken,
      idToken: mapped.idToken,
      scope: mapped.scope,
      tokenType: mapped.tokenType,
      providerAccountId: mapped.providerAccountId,
      providerEmail: mapped.providerEmail,
    },
  });
}
