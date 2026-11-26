import type { ConnectedAccountServiceKey, ConnectedServiceId } from '@happier-dev/protocol';


export type ConnectedServiceCredentialBinding = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

export class ConnectedServiceCredentialResolutionError extends Error {
  readonly name = 'ConnectedServiceCredentialResolutionError';
  readonly serviceId: ConnectedAccountServiceKey;
  readonly profileId: string;

  constructor(
    binding: Readonly<{ serviceId: ConnectedAccountServiceKey; profileId: string }>,
    readonly kind: 'confirmed_missing' | 'present_but_unusable' | 'unknown',
  ) {
    super(`Connected Account credential resolution ${kind} (${binding.serviceId}/${binding.profileId})`);
    this.serviceId = binding.serviceId;
    this.profileId = binding.profileId;
  }
}
