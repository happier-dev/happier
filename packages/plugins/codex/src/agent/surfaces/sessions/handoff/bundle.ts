import type {
  AgentTerminalSessionStateUpdate,
  HandoffImportResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod';

import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';
import {
  CodexExternalSessionHandoffSourceSchema,
  type CodexExternalSessionHandoffSource,
  type CodexExternalSessionSource,
} from '../external/models.js';

type CodexHandoffRuntimeDescriptor = Extract<
  AgentTerminalSessionStateUpdate,
  { fieldId: 'identity.runtimeDescriptor' }
>['value'];

type CodexHandoffBackendMode = NonNullable<
  ReturnType<typeof buildCodexAgentRuntimeDescriptor>['agent']['backendMode']
>;

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
  backendMode: CodexHandoffBackendMode | null;
  source?: CodexExternalSessionHandoffSource;
  runtimeDescriptor?: CodexHandoffRuntimeDescriptor;
}>;

export const CodexSessionHandoffBundleSchema = z.object({
  agentId: z.literal('codex'),
  remoteSessionId: z.string().min(1),
  affinity: z.object({
    backendMode: z.enum(['acp', 'appServer']).nullable(),
    source: CodexExternalSessionHandoffSourceSchema.optional(),
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
  externalSource: CodexExternalSessionSource;
  runtimeDescriptorV1?: CodexHandoffRuntimeDescriptor;
  resume: HandoffImportResultV1['launch'];
}>;
