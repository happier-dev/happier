import { z } from 'zod';

import { SessionHandoffCodexAffinitySchema } from '@happier-dev/protocol';

// Internal (CLI-only) contract for the provider bundle file transferred during session handoff.
// This is intentionally not part of the shared protocol surface.
export const SessionHandoffProviderBundleSchema = z.discriminatedUnion('providerId', [
  z
    .object({
      providerId: z.literal('claude'),
      remoteSessionId: z.string().min(1),
      transcriptBase64: z.string().min(1),
    })
    .strict(),
  z
    .object({
      providerId: z.literal('codex'),
      remoteSessionId: z.string().min(1),
      affinity: SessionHandoffCodexAffinitySchema.optional(),
      files: z.array(
        z
          .object({
            relativePath: z.string().min(1),
            contentBase64: z.string().min(1),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      providerId: z.literal('opencode'),
      remoteSessionId: z.string().min(1),
      exportJsonBase64: z.string().min(1),
      affinity: z
        .object({
          backendMode: z.enum(['server', 'acp']).nullable(),
          serverBaseUrl: z.string().nullable(),
          serverBaseUrlExplicit: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);
