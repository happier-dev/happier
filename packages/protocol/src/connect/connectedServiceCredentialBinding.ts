import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from './connectedServiceSchemas.js';

export class ConnectedServiceCredentialBindingMismatchError extends Error {
  readonly name = 'ConnectedServiceCredentialBindingMismatchError';
  readonly code = 'connected_service_credential_binding_mismatch' as const;
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) {
    super('Connected service credential does not match the requested binding');
    this.serviceId = binding.serviceId;
    this.profileId = binding.profileId;
  }
}

export function assertConnectedServiceCredentialRecordBinding(params: Readonly<{
  binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
  record: ConnectedServiceCredentialRecordV1;
}>): ConnectedServiceCredentialRecordV1 {
  if (
    params.record.serviceId !== params.binding.serviceId
    || params.record.profileId !== params.binding.profileId
  ) {
    throw new ConnectedServiceCredentialBindingMismatchError(params.binding);
  }
  return params.record;
}
