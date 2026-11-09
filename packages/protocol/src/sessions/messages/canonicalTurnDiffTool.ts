import type {
  ChangeConfidence,
  ChangeEvidenceSource,
  FileChangeEvidence,
  RepositoryCheckpointTurnMetadata,
} from '../changes/schemas.js';
import {
  ChangeConfidenceSchema,
  ChangeEvidenceSourceSchema,
  FileChangeEvidenceSchema,
  TurnChangeSetSchema,
} from '../changes/schemas.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { resolveToolEnvelopeMeta } from '../../tools/v2/meta.js';

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as RecordLike
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringField(record: RecordLike | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function firstDefined(record: RecordLike, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

export type TurnChangeToolMetadata = Readonly<{
  turnId: string;
  sessionId: string;
  provider: string;
  source: ChangeEvidenceSource;
  confidence: ChangeConfidence;
  turnStatus: 'completed' | 'aborted' | 'interrupted' | 'unknown';
  seqRange: {
    startSeqInclusive: number;
    endSeqInclusive: number;
  };
  repositoryCheckpoint?: RepositoryCheckpointTurnMetadata;
}>;

export function readTurnChangeToolMetadata(input: unknown): TurnChangeToolMetadata | null {
  const record = asRecord(input);
  if (!record) return null;

  const meta = resolveToolEnvelopeMeta(record);
  if (meta) {
    if (meta.sessionChangeScope !== 'turn') return null;
    const turnId = readNonEmptyString(meta.turnId);
    const sessionId = readNonEmptyString(meta.sessionId);
    const provider = readNonEmptyString(meta.provider);
    if (!turnId || !sessionId || !provider) return null;
    const source = ChangeEvidenceSourceSchema.safeParse(meta.source);
    const confidence = ChangeConfidenceSchema.safeParse(meta.confidence);
    if (!source.success || !confidence.success) return null;
    const parsed = createStoredReadSchema(TurnChangeSetSchema).safeParse({
      sessionId,
      turnId,
      seqRange: meta.seqRange,
      status: meta.turnStatus,
      files: [],
      provider,
      derivedAt: 0,
      ...(meta.repositoryCheckpoint === undefined ? {} : { repositoryCheckpoint: meta.repositoryCheckpoint }),
    });
    if (!parsed.success) return null;
    return {
      turnId,
      sessionId,
      provider,
      source: source.data,
      confidence: confidence.data,
      turnStatus: parsed.data.status,
      seqRange: parsed.data.seqRange,
      ...(parsed.data.repositoryCheckpoint ? { repositoryCheckpoint: parsed.data.repositoryCheckpoint } : {}),
    };
  }

  for (const key of ['output', 'input', 'payload', 'data', 'result', 'value', 'content'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const nested = readTurnChangeToolMetadata(record[key]);
    if (nested) return nested;
  }

  const toolUseResult = record.tool_use_result;
  if (typeof toolUseResult === 'string') {
    const nested = readTurnChangeToolMetadata(toolUseResult);
    if (nested) return nested;
  }

  return null;
}

export function readTurnChangeToolMetadataFromToolCall(tool: Readonly<{
  input?: unknown;
  result?: unknown;
}>): TurnChangeToolMetadata | null {
  return readTurnChangeToolMetadata(tool.input) ?? readTurnChangeToolMetadata(tool.result);
}

export function extractCanonicalDiffFiles(input: unknown, metadata: TurnChangeToolMetadata): FileChangeEvidence[] {
  const record = asRecord(input);
  const rawFiles = Array.isArray(record?.files) ? record.files : [];
  return rawFiles
    .map((file) => asRecord(file))
    .filter((file): file is RecordLike => Boolean(file))
    .flatMap((file) => {
      const filePath = readStringField(file, ['file_path', 'filePath', 'path']) ?? '';
      if (!filePath) return [];
      const correlationAliases = ['provider_turn_id', 'agentTurnId', 'providerTurnId']
        .map((key) => file[key])
        .filter((value) => value !== undefined);
      if (correlationAliases.some((value) => value !== correlationAliases[0])) return [];
      const candidate = {
        filePath,
        changeKind: firstDefined(file, ['change_kind', 'changeKind']) ?? 'modified',
        source: file.source ?? metadata.source,
        confidence: file.confidence ?? metadata.confidence,
        provider: file.provider ?? metadata.provider,
        ...(firstDefined(file, ['previous_file_path', 'previousFilePath']) === undefined ? {} : {
          previousFilePath: firstDefined(file, ['previous_file_path', 'previousFilePath']),
        }),
        ...(firstDefined(file, ['unified_diff', 'unifiedDiff']) === undefined ? {} : {
          unifiedDiff: firstDefined(file, ['unified_diff', 'unifiedDiff']),
        }),
        ...(firstDefined(file, ['oldText', 'old_text']) === undefined ? {} : { oldText: firstDefined(file, ['oldText', 'old_text']) }),
        ...(firstDefined(file, ['newText', 'new_text']) === undefined ? {} : { newText: firstDefined(file, ['newText', 'new_text']) }),
        ...(file.binary === undefined ? {} : { binary: file.binary }),
        ...(correlationAliases.length === 0 ? {} : { agentTurnId: correlationAliases[0] }),
        ...(firstDefined(file, ['provider_message_id', 'providerMessageId']) === undefined ? {} : {
          providerMessageId: firstDefined(file, ['provider_message_id', 'providerMessageId']),
        }),
        ...(file.description === undefined ? {} : { description: file.description }),
        ...(file.truncated === undefined ? {} : { truncated: file.truncated }),
        ...(file.stats === undefined ? {} : { stats: file.stats }),
      };
      const parsed = createStoredReadSchema(FileChangeEvidenceSchema).safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
}

function readCanonicalToolName(value: unknown): string | null {
  const record = asRecord(value);
  const meta = resolveToolEnvelopeMeta(record);
  return readNonEmptyString(meta?.canonicalToolName);
}

function hasCanonicalDiffEvidenceForMetadata(input: unknown, metadata: TurnChangeToolMetadata): boolean {
  const record = asRecord(input);
  const evidenceInput = record ?? input;

  if (extractCanonicalDiffFiles(evidenceInput, metadata).length > 0) return true;

  if (metadata.repositoryCheckpoint) return true;

  if (!record) return false;

  return readStringField(record, ['unified_diff', 'unifiedDiff', 'diff']) !== null;
}

function hasUnmarkedCanonicalDiffEvidence(input: unknown, depth = 0): boolean {
  const record = asRecord(input);
  if (!record) return false;
  if (readStringField(record, ['unified_diff', 'unifiedDiff', 'diff']) !== null) return true;

  const files = Array.isArray(record.files) ? record.files : [];
  if (files.some((file) => {
    const fileRecord = asRecord(file);
    if (!fileRecord) return false;
    return readStringField(fileRecord, ['file_path', 'filePath', 'path']) !== null;
  })) {
    return true;
  }

  if (depth >= 2) return false;
  return ['_raw', '_acp', 'input', 'output', 'result', 'data'].some((key) => (
    record[key] !== undefined && hasUnmarkedCanonicalDiffEvidence(record[key], depth + 1)
  ));
}

export function isCanonicalTurnDiffPayload(input: unknown): boolean {
  return readTurnChangeToolMetadata(input) !== null || readCanonicalToolName(input) === 'Diff';
}

function hasCanonicalDiffEvidence(input: unknown): boolean {
  const metadata = readTurnChangeToolMetadata(input);
  if (!metadata) return hasUnmarkedCanonicalDiffEvidence(input);
  return hasCanonicalDiffEvidenceForMetadata(input, metadata);
}

export function hasCanonicalTurnDiffEvidence(input: unknown): boolean {
  return hasCanonicalDiffEvidence(input);
}

export function shouldSuppressEmptyCanonicalTurnDiffToolCall(params: Readonly<{
  toolName: unknown;
  input: unknown;
}>): boolean {
  if (params.toolName !== 'Diff') return false;
  if (!isCanonicalTurnDiffPayload(params.input)) return false;
  return !hasCanonicalDiffEvidence(params.input);
}

export function readEmptyCanonicalTurnDiffToolCallId(rawInput: unknown): string | null {
  const raw = asRecord(rawInput);
  const content = asRecord(raw?.content);
  if (!content) return null;
  const contentType = content.type;
  if (contentType !== 'codex' && contentType !== 'acp') return null;

  const data = asRecord(content.data);
  if (!data || data.type !== 'tool-call') return null;

  const callId = readStringField(data, ['callId', 'call_id']);
  if (!callId) return null;

  const toolName = readStringField(data, ['name', 'toolName']);
  return shouldSuppressEmptyCanonicalTurnDiffToolCall({
    toolName,
    input: data.input,
  })
    ? callId
    : null;
}
