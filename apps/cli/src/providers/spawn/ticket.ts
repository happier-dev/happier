import {
  ProviderBindingAuthorizationTicketV1Schema,
  createProviderErrorV1,
  type ProviderBindingAuthorizationTicketV1,
  type ProviderErrorV1,
} from '@happier-dev/protocol';

export type ProviderBindingAuthorizationState = ProviderBindingAuthorizationTicketV1;

export function mintProviderBindingAuthorizationTicket(
  state: ProviderBindingAuthorizationState,
): ProviderBindingAuthorizationTicketV1 {
  return ProviderBindingAuthorizationTicketV1Schema.parse(state);
}

export type ProviderBindingAuthorizationRevalidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export function revalidateProviderBindingAuthorizationTicket(
  ticket: ProviderBindingAuthorizationTicketV1,
  current: ProviderBindingAuthorizationState | ProviderErrorV1,
): ProviderBindingAuthorizationRevalidation {
  const parsedTicket = ProviderBindingAuthorizationTicketV1Schema.parse(ticket);
  if ('code' in current) return { ok: false, error: current };
  const parsedCurrent = ProviderBindingAuthorizationTicketV1Schema.parse(current);
  if (
    parsedTicket.connectionId === parsedCurrent.connectionId
    && parsedTicket.connectionRevision === parsedCurrent.connectionRevision
    && parsedTicket.machineId === parsedCurrent.machineId
    && parsedTicket.connectionSecurityFingerprint === parsedCurrent.connectionSecurityFingerprint
    && parsedTicket.bindingSecurityFingerprint === parsedCurrent.bindingSecurityFingerprint
    && parsedTicket.grantFingerprint === parsedCurrent.grantFingerprint
    && parsedTicket.selectedSecretBindingId === parsedCurrent.selectedSecretBindingId
    && parsedTicket.selectedSecretRecordFingerprint === parsedCurrent.selectedSecretRecordFingerprint
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    error: createProviderErrorV1('provider_authorization_changed', {
      connectionId: parsedTicket.connectionId,
      machineId: parsedTicket.machineId,
    }),
  };
}
