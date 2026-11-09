import { describe, expect, it } from 'vitest';

import {
  ProviderConnectionIdSchema,
} from '@happier-dev/protocol';

import {
  mintProviderBindingAuthorizationTicket,
  projectProviderBindingAuthorizationTicketReference,
  type ProviderBindingAuthorizationState,
} from './ticket';

const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');

function state(overrides: Partial<ProviderBindingAuthorizationState> = {}): ProviderBindingAuthorizationState {
  return {
    connectionId,
    connectionRevision: 3,
    machineId: 'machine-a',
    connectionSecurityFingerprint: 'connection-security:v1:one',
    bindingSecurityFingerprint: 'binding-security:v1:one',
    grantFingerprint: 'account-grant:v1:one',
    selectedSecretBindingId: 'secret-a',
    selectedSecretRecordFingerprint: 'saved-secret-record:v1:one',
    ...overrides,
  };
}

describe('provider binding authorization tickets', () => {
  it('projects one opaque comparison reference for the complete current authorization ticket', () => {
    const ticket = mintProviderBindingAuthorizationTicket(state());
    const reference = projectProviderBindingAuthorizationTicketReference(ticket);
    expect(reference).not.toContain(ticket.connectionId);
    expect(reference).not.toContain(ticket.selectedSecretBindingId!);
    expect(projectProviderBindingAuthorizationTicketReference({
      selectedSecretRecordFingerprint: ticket.selectedSecretRecordFingerprint,
      selectedSecretBindingId: ticket.selectedSecretBindingId,
      grantFingerprint: ticket.grantFingerprint,
      bindingSecurityFingerprint: ticket.bindingSecurityFingerprint,
      connectionSecurityFingerprint: ticket.connectionSecurityFingerprint,
      machineId: ticket.machineId, connectionRevision: ticket.connectionRevision, connectionId: ticket.connectionId,
    })).toBe(reference);
    const changed: ProviderBindingAuthorizationState[] = [
      state({ connectionId: ProviderConnectionIdSchema.parse('pc_other') }), state({ connectionRevision: 4 }),
      state({ machineId: 'machine-b' }), state({ connectionSecurityFingerprint: 'connection-security:v1:two' }),
      state({ bindingSecurityFingerprint: 'binding-security:v1:two' }), state({ grantFingerprint: 'account-grant:v1:two' }),
      state({ selectedSecretBindingId: 'secret-b' }), state({ selectedSecretRecordFingerprint: 'saved-secret-record:v1:two' }),
      state({ selectedSecretBindingId: null, selectedSecretRecordFingerprint: null }),
    ];
    for (const current of changed) expect(projectProviderBindingAuthorizationTicketReference(current)).not.toBe(reference);
  });



});
