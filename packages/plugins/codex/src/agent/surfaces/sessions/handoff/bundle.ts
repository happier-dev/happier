import type {
  AgentTerminalSessionStateUpdate,
  HandoffImportResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { open } from 'node:fs/promises';
import { z } from 'zod';

import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';
import { parseCodexSessionMetaLine } from '../../../rollout/discovery/indexData.js';
import {
  CodexExternalSessionHandoffSourceSchema,
  type CodexExternalSessionHandoffSource,
  type CodexExternalSessionSource,
} from '../external/models.js';

const CODEX_HANDOFF_SESSION_META_PROBE_BYTES = 64 * 1024;
const CODEX_HANDOFF_ROLLOUT_ROOTS = new Set(['sessions', 'archived_sessions']);

export type CodexHandoffBundleFile = Readonly<{
  t: 'happier.handoff.file.v1';
  filePath: string;
  offsetBytes: number;
  sizeBytes: number;
}>;

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
    contentBase64: z.string().min(1).optional(),
    contentFile: z.object({
      t: z.literal('happier.handoff.file.v1'),
      filePath: z.string().min(1),
      offsetBytes: z.number().int().nonnegative(),
      sizeBytes: z.number().int().nonnegative(),
    }).strict().optional(),
  }).strict().refine((file) => Boolean(file.contentBase64) !== Boolean(file.contentFile))).min(1),
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

export class CodexSessionHandoffBundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSessionHandoffBundleValidationError';
  }
}

export type ValidatedCodexSessionHandoffFile = Readonly<{
  relativePath: string;
}> & (
  | Readonly<{ content: Buffer; contentFile?: never }>
  | Readonly<{ contentFile: CodexHandoffBundleFile; content?: never }>
);

function invalidCodexHandoffBundle(message: string): never {
  throw new CodexSessionHandoffBundleValidationError(message);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function decodeCanonicalBase64(value: string, relativePath: string): Buffer {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return invalidCodexHandoffBundle(`Codex handoff rollout has invalid base64 content: ${relativePath}`);
  }
  const content = Buffer.from(value, 'base64');
  if (content.byteLength === 0 || content.toString('base64') !== value) {
    return invalidCodexHandoffBundle(`Codex handoff rollout has invalid base64 content: ${relativePath}`);
  }
  return content;
}

function readCodexHandoffSessionMetaLine(content: Buffer, totalSize = content.byteLength): string | null {
  const probe = content.subarray(0, Math.min(content.byteLength, CODEX_HANDOFF_SESSION_META_PROBE_BYTES));
  const newlineOffset = probe.indexOf(0x0a);
  if (newlineOffset === -1 && totalSize > probe.byteLength) return null;
  const lineBytes = probe.subarray(0, newlineOffset === -1 ? probe.byteLength : newlineOffset);
  try {
    const line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes).trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

async function readCodexHandoffSessionMetaLineFromFile(file: CodexHandoffBundleFile): Promise<string | null> {
  const source = await open(file.filePath, 'r');
  try {
    const probe = Buffer.alloc(Math.min(file.sizeBytes, CODEX_HANDOFF_SESSION_META_PROBE_BYTES));
    const { bytesRead } = await source.read(probe, 0, probe.length, file.offsetBytes);
    if (bytesRead !== probe.length) return null;
    return readCodexHandoffSessionMetaLine(probe, file.sizeBytes);
  } finally {
    await source.close();
  }
}

function assertCanonicalCodexHandoffRolloutPath(relativePath: string): void {
  const segments = relativePath.split('/');
  const root = segments[0];
  const fileName = segments.at(-1);
  if (
    !root
    || !CODEX_HANDOFF_ROLLOUT_ROOTS.has(root)
    || segments.length < 2
    || !fileName?.startsWith('rollout-')
    || !fileName.endsWith('.jsonl')
  ) {
    invalidCodexHandoffBundle(`Codex handoff file is not a canonical rollout: ${relativePath}`);
  }
}

function classifyCodexHandoffRolloutLine(params: Readonly<{
  remoteSessionId: string;
  relativePath: string;
  firstLine: string | null;
}>): 'root' | 'sidechain' {
  const metadata = params.firstLine ? parseCodexSessionMetaLine(params.firstLine) : null;
  const sessionId = readNonEmptyString(metadata?.id);
  const rootSessionId = readNonEmptyString(metadata?.session_id);
  if (!sessionId) {
    return invalidCodexHandoffBundle(
      `Codex handoff rollout has no native session metadata: ${params.relativePath}`,
    );
  }
  if (rootSessionId !== null) {
    if (rootSessionId !== params.remoteSessionId) {
      return invalidCodexHandoffBundle(
        `Codex handoff rollout belongs to a different root session: ${params.relativePath}`,
      );
    }
    return sessionId === params.remoteSessionId ? 'root' : 'sidechain';
  }
  if (sessionId !== params.remoteSessionId) {
    return invalidCodexHandoffBundle(
      `Codex handoff rollout belongs to a different session: ${params.relativePath}`,
    );
  }
  return 'root';
}

/**
 * Validate the native Codex handoff grammar before the importer creates its
 * CODEX_HOME or takes its per-session lock. The native metadata parser remains
 * the rollout owner's parser; this only adapts bounded transferred bytes to it.
 */
export async function validateCodexSessionHandoffFiles(
  bundle: Pick<CodexSessionHandoffBundle, 'remoteSessionId' | 'files'>,
): Promise<readonly ValidatedCodexSessionHandoffFile[]> {
  let hasRootRollout = false;
  const validatedFiles = await Promise.all(bundle.files.map(async (file) => {
    const relativePath = normalizeCodexHandoffBundleRelativePath(file.relativePath);
    assertCanonicalCodexHandoffRolloutPath(relativePath);
    const content = file.contentBase64
      ? decodeCanonicalBase64(file.contentBase64, relativePath)
      : undefined;
    let firstLine: string | null;
    let validatedFile: ValidatedCodexSessionHandoffFile;
    if (content) {
      firstLine = readCodexHandoffSessionMetaLine(content);
      validatedFile = { relativePath, content };
    } else {
      if (!file.contentFile) {
        invalidCodexHandoffBundle(`Codex handoff rollout has no content: ${relativePath}`);
      }
      const contentFile: CodexHandoffBundleFile = file.contentFile;
      firstLine = await readCodexHandoffSessionMetaLineFromFile(contentFile);
      validatedFile = { relativePath, contentFile };
    }
    if (classifyCodexHandoffRolloutLine({
      remoteSessionId: bundle.remoteSessionId,
      relativePath,
      firstLine,
    }) === 'root') {
      hasRootRollout = true;
    }
    return validatedFile;
  }));
  if (!hasRootRollout) {
    invalidCodexHandoffBundle(
      `Codex handoff bundle has no root rollout for ${bundle.remoteSessionId}`,
    );
  }
  return validatedFiles;
}
