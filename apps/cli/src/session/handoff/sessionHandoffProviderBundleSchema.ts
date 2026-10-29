import { z } from 'zod';

import { SessionHandoffCodexAffinitySchema } from '@happier-dev/protocol';
import { lazySchema } from '@happier-dev/protocol';

const SessionHandoffFileSliceSchema = lazySchema(() => z.object({
  t: z.literal('happier.handoff.file.v1').optional(),
  filePath: z.string().min(1),
  offsetBytes: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
}).strict().transform((value) => ({ ...value, t: 'happier.handoff.file.v1' as const })));

const ClaudeSessionHandoffProviderBundleSchema = lazySchema(() => z.union([
  z.object({
    providerId: z.literal('claude'),
    remoteSessionId: z.string().min(1),
    transcriptBase64: z.string().min(1),
    transcriptFile: z.undefined().optional(),
  }).strict(),
  z.object({
    providerId: z.literal('claude'),
    remoteSessionId: z.string().min(1),
    transcriptBase64: z.undefined().optional(),
    transcriptFile: SessionHandoffFileSliceSchema,
  }).strict(),
]));

const CodexSessionHandoffFileSchema = lazySchema(() => z.union([
  z.object({
    relativePath: z.string().min(1),
    contentBase64: z.string().min(1),
    contentFile: z.undefined().optional(),
  }).strict(),
  z.object({
    relativePath: z.string().min(1),
    contentBase64: z.undefined().optional(),
    contentFile: SessionHandoffFileSliceSchema,
  }).strict(),
]));

const OpenCodeAffinitySchema = lazySchema(() => z.object({
  backendMode: z.enum(['server', 'acp']).nullable(),
  serverBaseUrl: z.string().nullable(),
  serverBaseUrlExplicit: z.boolean(),
}).strict());

// Internal (CLI-only) contract for the provider bundle file transferred during session handoff.
// This is intentionally not part of the shared protocol surface.
export const SessionHandoffProviderBundleSchema = lazySchema(() => z.union([
  ClaudeSessionHandoffProviderBundleSchema,
  z.object({
    providerId: z.literal('codex'),
    remoteSessionId: z.string().min(1),
    affinity: SessionHandoffCodexAffinitySchema.optional(),
    files: z.array(CodexSessionHandoffFileSchema),
  }).strict(),
  z.object({
    providerId: z.literal('opencode'),
    remoteSessionId: z.string().min(1),
    affinity: OpenCodeAffinitySchema,
    exportJsonBase64: z.string().min(1),
    exportJsonFile: z.undefined().optional(),
  }).strict(),
  z.object({
    providerId: z.literal('opencode'),
    remoteSessionId: z.string().min(1),
    affinity: OpenCodeAffinitySchema,
    exportJsonBase64: z.undefined().optional(),
    exportJsonFile: SessionHandoffFileSliceSchema,
  }).strict(),
]));
