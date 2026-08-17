import { z } from 'zod';

const textEncoder = new TextEncoder();

export const MAX_COMPOSER_REFERENCE_CANDIDATE_ID_UTF8_BYTES_V1 = 256;

/** Browser-safe canonical identity boundary for public composer providers. */
export const ComposerReferenceCandidateIdV1Schema = z.string().min(1).superRefine((value, context) => {
  if (textEncoder.encode(value).byteLength > MAX_COMPOSER_REFERENCE_CANDIDATE_ID_UTF8_BYTES_V1) {
    context.addIssue({
      code: 'custom',
      message: `Composer reference candidate ids must be at most ${MAX_COMPOSER_REFERENCE_CANDIDATE_ID_UTF8_BYTES_V1} UTF-8 bytes.`,
    });
  }
});

export type ComposerReferenceCandidateIdV1 = z.infer<typeof ComposerReferenceCandidateIdV1Schema>;
