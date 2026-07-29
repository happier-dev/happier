import {
  SessionProviderBindingMetadataV1Schema,
  SessionProviderBindingSecurityChangeConfirmationV1Schema,
  compareSessionProviderBindingV1,
  createProviderErrorV1,
  type ProviderErrorV1,
  type SessionProviderBindingChangeV1,
  type SessionProviderBindingMetadataV1,
  type SessionProviderBindingSecurityChangeConfirmationV1,
} from '@happier-dev/protocol';

export type ProviderSpawnBindingContinuityChange = 'initial' | SessionProviderBindingChangeV1;

export function resolveSpawnBindingContinuity(input: Readonly<{
  previous: SessionProviderBindingMetadataV1 | null;
  next: SessionProviderBindingMetadataV1;
  sessionId: string;
  confirmation: SessionProviderBindingSecurityChangeConfirmationV1 | null;
}>):
  | Readonly<{ ok: true; change: ProviderSpawnBindingContinuityChange }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }> {
  const next = SessionProviderBindingMetadataV1Schema.parse(input.next);
  if (!input.previous) return { ok: true, change: 'initial' };

  const previous = SessionProviderBindingMetadataV1Schema.parse(input.previous);
  const change = compareSessionProviderBindingV1(previous, next);
  const confirmation = input.confirmation
    ? SessionProviderBindingSecurityChangeConfirmationV1Schema.parse(input.confirmation)
    : null;
  const securityChangeConfirmed = confirmation !== null
    && confirmation.sessionId === input.sessionId
    && confirmation.connectionId === previous.connectionId
    && confirmation.connectionId === next.connectionId
    && confirmation.previousBindingSecurityFingerprint === previous.bindingSecurityFingerprint
    && confirmation.nextBindingSecurityFingerprint === next.bindingSecurityFingerprint;
  if (change === 'security_change' && !securityChangeConfirmed) {
    return {
      ok: false,
      error: createProviderErrorV1('provider_binding_changed', {
        connectionId: next.connectionId,
      }),
    };
  }
  return { ok: true, change };
}
