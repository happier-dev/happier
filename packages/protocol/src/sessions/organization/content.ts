import {
  StoredJsonContentEnvelopeSchema,
  type StoredJsonContentEnvelope,
} from '../../storage/storedJsonContentEnvelope.js';

import { SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES } from './constants.js';

const textEncoder = new TextEncoder();

function measureJsonUtf8Bytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return textEncoder.encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export const SessionOrganizationContentEnvelopeSchema = StoredJsonContentEnvelopeSchema.superRefine((value, ctx) => {
  const byteLength = measureJsonUtf8Bytes(value);
  if (byteLength === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'Session organization display envelope must be JSON serializable.',
    });
    return;
  }

  if (byteLength > SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: 'Session organization display envelope exceeds the maximum serialized size.',
    });
  }
});
export type SessionOrganizationContentEnvelope = StoredJsonContentEnvelope;
