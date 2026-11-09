import { ProviderBindingAuthorizationTicketV1Schema } from '@happier-dev/protocol/providers/grants/v1';
export { projectProviderBindingAuthorizationTicketReferenceV1 as projectProviderBindingAuthorizationTicketReference } from '@happier-dev/protocol/providers/grants/v1';
import type { ProviderBindingAuthorizationTicketV1 } from '@happier-dev/protocol';

export type ProviderBindingAuthorizationState = ProviderBindingAuthorizationTicketV1;

export function mintProviderBindingAuthorizationTicket(
  state: ProviderBindingAuthorizationState,
): ProviderBindingAuthorizationTicketV1 {
  return ProviderBindingAuthorizationTicketV1Schema.parse(state);
}
