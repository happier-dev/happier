import type {
  ExternalSessionsSource,
  RuntimeDescriptorV1,
  SessionHandoffResumePlan,
} from '@happier-dev/plugin-sdk/sessions';
import { ExternalSessionsSourceSchema } from '@happier-dev/plugin-sdk/sessions';
import { z } from 'zod';

import type { CodexBackendMode } from '../../../../protocol/runtimeDescriptorV1.js';

type CodexSessionHandoffAffinity = Readonly<{
  backendMode: CodexBackendMode | null;
  source?: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1;
}>;

export const CodexSessionHandoffBundleSchema = z.object({
  agentId: z.literal('codex'),
  remoteSessionId: z.string().min(1),
  affinity: z.object({
    backendMode: z.enum(['acp', 'appServer']).nullable(),
    source: ExternalSessionsSourceSchema.optional(),
    runtimeDescriptor: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
  files: z.array(z.object({
    relativePath: z.string().min(1),
    contentBase64: z.string(),
  }).strict()),
}).strict();

export type CodexSessionHandoffBundle = Readonly<
  z.infer<typeof CodexSessionHandoffBundleSchema>
> & Readonly<{
  affinity?: CodexSessionHandoffAffinity;
}>;

export type ImportedCodexSessionHandoffBundle = Readonly<{
  remoteSessionId: string;
  externalSource: ExternalSessionsSource;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  resume: SessionHandoffResumePlan;
}>;
