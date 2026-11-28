import { SessionModelSelectionV1Schema, SessionModelSelectionV2Schema, type SessionModelRef, type SessionModelSelection, type SessionModelSelectionV1, type SessionModelSelectionV2 } from './schemas.js';

/** Account Provider binding is a distinct source from native and Team-resource binding. */
export function readSessionModelSelectionProviderConnectionId(selection: SessionModelSelection): SessionModelSelectionV1['ref']['providerConnectionId'] {
  return readSessionModelRefProviderConnectionId(selection.ref);
}

export function readSessionModelRefProviderConnectionId(ref: SessionModelRef): SessionModelSelectionV1['ref']['providerConnectionId'] {
  return 'providerConnectionId' in ref ? ref.providerConnectionId : null;
}

/** Older readers may consume only the two sources they can represent. */
export function projectSessionModelSelectionV2ToV1(
  value: SessionModelSelectionV2,
): SessionModelSelectionV1 | null {
  const selection = SessionModelSelectionV2Schema.parse(value);
  if (selection.ref.source === 'team_resource' || selection.ref.source === 'connected_account') return null;
  return SessionModelSelectionV1Schema.parse({
    v: 1,
    ref: {
      agentTargetKey: selection.ref.agentTargetKey,
      providerConnectionId: selection.ref.source === 'native'
        ? null
        : selection.ref.providerConnectionId,
      modelId: selection.ref.modelId,
    },
    updatedAt: selection.updatedAt,
  });
}
