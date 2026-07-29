import type {
  ExternalSessionsSource,
  RuntimeDescriptorV1,
  SessionHandoffResumePlan,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { ExternalSessionsSourceSchema } from '@happier-dev/plugin-sdk/experimental/sessions';
import { z } from 'zod';

import type { CodexBackendMode } from '../../../../protocol/runtimeDescriptorV1.js';

export function normalizeCodexHandoffBundleRelativePath(relativePath: string): string {
  const portable = relativePath.replaceAll('\\', '/');
  if (
    portable.startsWith('/')
    || /^[A-Za-z]:/u.test(portable)
  ) {
    throw new Error(`Codex bundle path must be relative: ${relativePath}`);
  }

  const segments = portable.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error(`Codex bundle path escapes CODEX_HOME: ${relativePath}`);
  }
  return segments.join('/');
}

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
