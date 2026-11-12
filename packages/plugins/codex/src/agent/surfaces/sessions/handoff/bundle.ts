import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import type {
  AgentTerminalSessionStateUpdate,
  HandoffImportResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { open } from 'node:fs/promises';
import { z } from 'zod/mini';

import {
  buildCodexAgentRuntimeDescriptor,
  readExactCodexProviderSessionId,
} from '../../../../protocol/runtimeDescriptorV1.js';
import { isMatchingCodexRolloutIdentity, parseCodexRolloutFilename, parseCodexSessionMetaLine } from '../../../rollout/discovery/indexData.js';
import { readCodexPaginatedHistoryBase } from '../../../rollout/discovery/historyBase.js';
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

export const CodexSessionHandoffBundleSchema = z.strictObject({
  agentId: z.literal('codex'),
  remoteSessionId: z.string().check(z.minLength(1)),
  affinity: z.optional(z.strictObject({
    backendMode: z.nullable(z.enum(['acp', 'appServer'])),
    source: z.optional(CodexExternalSessionHandoffSourceSchema),
    runtimeDescriptor: z.optional(z.record(z.string(), z.unknown())),
  })),
  files: z.array(z.strictObject({
    relativePath: z.string().check(z.minLength(1)),
    contentBase64: z.optional(z.string().check(z.minLength(1))),
    contentFile: z.optional(z.strictObject({
      t: z.literal('happier.handoff.file.v1'),
      filePath: z.string().check(z.minLength(1)),
      offsetBytes: z.number().check(z.int(), z.nonnegative()),
      sizeBytes: z.number().check(z.int(), z.nonnegative()),
    })),
  }).check(z.refine((file) => Boolean(file.contentBase64) !== Boolean(file.contentFile)))).check(z.minLength(1)),
});

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
  /** Only a referenced ancestor may reuse a destination with matching prefix and later records. */
  isHistoryBase?: true;
}> & (
  | Readonly<{ content: Buffer; contentFile?: never }>
  | Readonly<{ contentFile: CodexHandoffBundleFile; content?: never }>
);

function invalidCodexHandoffBundle(message: string): never {
  throw new CodexSessionHandoffBundleValidationError(message);
}

function decodeCanonicalBase64(value: string, relativePath: string): Buffer {
  if (
    value.length === 0
    || readCanonicalPaddedBase64DecodedLength(value) === null
  ) {
    return invalidCodexHandoffBundle(`Codex handoff rollout has invalid base64 content: ${relativePath}`);
  }
  const content = Buffer.from(value, 'base64');
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
  const sessionId = readExactCodexProviderSessionId(metadata?.id);
  const rootSessionId = readExactCodexProviderSessionId(metadata?.session_id);
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
  const entries = await Promise.all(bundle.files.map(async (file) => {
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
    return { validatedFile, firstLine, metadata: firstLine ? parseCodexSessionMetaLine(firstLine) : null };
  }));
  const family = new Set(entries.filter((entry) => {
    const sessionId = readExactCodexProviderSessionId(entry.metadata?.id);
    const rootId = readExactCodexProviderSessionId(entry.metadata?.session_id);
    return (rootId ?? sessionId) === bundle.remoteSessionId;
  }));
  const dependencies = new Set<typeof entries[number]>();
  const visited = new Set<typeof entries[number]>();
  const visiting = new Set<typeof entries[number]>();
  const visit = (entry: typeof entries[number]): void => {
    if (visiting.has(entry)) invalidCodexHandoffBundle('Cyclic Codex history base');
    if (visited.has(entry)) return;
    visiting.add(entry);
    let base: ReturnType<typeof readCodexPaginatedHistoryBase>;
    try {
      base = readCodexPaginatedHistoryBase(entry.metadata);
    } catch (error) {
      invalidCodexHandoffBundle(error instanceof Error ? error.message : 'Invalid Codex history base');
    }
    if (base) {
      const candidates = entries.filter((candidate) => isMatchingCodexRolloutIdentity(
        parseCodexRolloutFilename(candidate.validatedFile.relativePath)?.sessionId, base.rolloutId,
      ));
      if (candidates.length !== 1) invalidCodexHandoffBundle(`Missing or ambiguous Codex history base rollout: ${base.rolloutId}`);
      const ancestor = candidates[0];
      if (!readExactCodexProviderSessionId(ancestor.metadata?.id)) {
        invalidCodexHandoffBundle(`Codex history base has no native session metadata: ${base.rolloutId}`);
      }
      const size = ancestor.validatedFile.content?.length ?? ancestor.validatedFile.contentFile!.sizeBytes;
      if (ancestor.metadata?.history_mode !== 'paginated' || size < base.endByteOffset) {
        invalidCodexHandoffBundle(`Incomplete or non-paginated Codex history base: ${base.rolloutId}`);
      }
      dependencies.add(ancestor);
      visit(ancestor);
    }
    visiting.delete(entry);
    visited.add(entry);
  };
  for (const entry of family) visit(entry);
  const validatedFiles = entries.map((entry): ValidatedCodexSessionHandoffFile => {
    if (!family.has(entry) && dependencies.has(entry)) return { ...entry.validatedFile, isHistoryBase: true };
    if (classifyCodexHandoffRolloutLine({
      remoteSessionId: bundle.remoteSessionId,
      relativePath: entry.validatedFile.relativePath,
      firstLine: entry.firstLine,
    }) === 'root') hasRootRollout = true;
    return entry.validatedFile;
  });
  if (!hasRootRollout) {
    invalidCodexHandoffBundle(
      `Codex handoff bundle has no root rollout for ${bundle.remoteSessionId}`,
    );
  }
  return validatedFiles;
}
