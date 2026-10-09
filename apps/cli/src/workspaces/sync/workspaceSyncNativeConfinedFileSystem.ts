import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES, WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

type ConflictKind = 'missing' | 'file' | 'directory' | 'symlink';

export type NativeConfinedReadOutcome =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'changed'; actualDigest: string }>
  | Readonly<{ status: 'too_large'; size: number; digest?: string }>
  | Readonly<{ status: 'content'; content: Buffer; digest: string; size: number }>;

/** The exact child-process surface consumed by the confinement corridor. */
export type WorkspaceSyncNativeConfinedChild = Readonly<{
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): WorkspaceSyncNativeConfinedChild;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): WorkspaceSyncNativeConfinedChild;
  kill(signal?: NodeJS.Signals | number): boolean;
}>;

type SpawnChild = (
  executablePath: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & Readonly<{ stdio: ['pipe', 'pipe', 'pipe'] }>,
) => WorkspaceSyncNativeConfinedChild;

export type WorkspaceSyncNativeConfinedDependencies = Readonly<{
  platform?: NodeJS.Platform;
  resolveExecutable?: (platform?: NodeJS.Platform) => string | null;
  spawnChild?: SpawnChild;
}>;

export type WorkspaceSyncNativeConfinedCommonInput = Readonly<{
  rootPath: string;
  relativePath: string;
  assertCurrentAuthority?: () => Promise<void>;
}>;

export type RunNativeConfinedReadInput = WorkspaceSyncNativeConfinedCommonInput & Readonly<{
  expectedDigest?: string;
  maxBytes: number;
}>;

export type RunNativeConfinedDeleteInput = WorkspaceSyncNativeConfinedCommonInput & Readonly<{
  expectedKind: ConflictKind;
  expectedDigest?: string;
}>;

export type NativeConfinedCapturedEntry = Readonly<{
  expectation: WorkspaceSyncEntryExpectationV1;
  materialPath: string | null;
}>;

export type RunNativeConfinedCaptureInput = WorkspaceSyncNativeConfinedCommonInput & Readonly<{
  expected: WorkspaceSyncEntryExpectationV1;
  captureDirectory: string;
  operationId: string;
}>;

export type RunNativeConfinedApplyInput = WorkspaceSyncNativeConfinedCommonInput & Readonly<{
  expectedDestination: WorkspaceSyncEntryExpectationV1;
  selectedExpectation: WorkspaceSyncEntryExpectationV1;
  materialPath: string | null;
  recoveryDirectory: string;
  operationId: string;
}>;

export type NativeConfinedApplyOutcome =
  | Readonly<{ status: 'installed' | 'restored' }>
  | Readonly<{ status: 'recovery_needed'; recoveryPath: string }>;

export type RunNativeConfinedRecoverInput = Readonly<{
  rootPath: string;
  recoveryDirectory: string;
  operationId: string;
  assertCurrentAuthority?: () => Promise<void>;
}>;

export type NativeConfinedRecoverOutcome =
  | Readonly<{ status: 'settled' }>
  | Readonly<{ status: 'recovery_needed'; recoveryPath: string }>;

export type NativeConfinedRecoveryRecord = Readonly<{
  operationId: string;
  rootPath: string;
  recoveryPath: string;
}>;

const STDERR_MAX_BYTES = 64 * 1024;
const STDOUT_MAX_BYTES = Math.ceil(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES * 4 / 3) + 64 * 1024;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;

function unsafe(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: 'workspace_root_unsafe',
  });
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseRecord(line: string): Record<string, unknown> {
  if (!line || /[\r\n]/u.test(line)) throw unsafe('native workspace confinement returned an invalid record');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw unsafe('native workspace confinement returned invalid JSON', error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw unsafe('native workspace confinement returned a non-object record');
  }
  return parsed as Record<string, unknown>;
}

function parsePrepared(line: string): void {
  const record = parseRecord(line);
  if (record.v === 1 && record.t === 'workspace-confined-result' && record.status === 'error') {
    throw nativeDomainError(record);
  }
  if (!exactKeys(record, ['t', 'v']) || record.v !== 1 || record.t !== 'workspace-confined-prepared') {
    throw unsafe('native workspace confinement did not establish the prepared boundary');
  }
}

function isSafeSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA1_PATTERN.test(value);
}

function parseBase64(value: unknown): Buffer {
  if (typeof value !== 'string') throw unsafe('native workspace confinement returned invalid content');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw unsafe('native workspace confinement returned non-canonical content');
  return decoded;
}

function nativeDomainError(record: Record<string, unknown>): Error {
  const allowedCodes = new Set([
    'workspace_root_unsafe',
    'workspace_file_unsupported',
    'conflict_changed',
    'conflict_resolution_unsupported',
  ]);
  const allowedKeys = typeof record.recoveryPath === 'string'
    ? ['code', 'message', 'recoveryPath', 'status', 't', 'v']
    : ['code', 'message', 'status', 't', 'v'];
  if (
    !exactKeys(record, allowedKeys)
    || typeof record.code !== 'string'
    || !allowedCodes.has(record.code)
    || typeof record.message !== 'string'
    || record.message.length === 0
  ) {
    throw unsafe('native workspace confinement returned an invalid error');
  }
  return Object.assign(new Error(record.message), {
    code: record.code,
    ...(typeof record.recoveryPath === 'string' ? { recoveryPath: record.recoveryPath } : {}),
  });
}

function parseReadResult(line: string): NativeConfinedReadOutcome {
  const record = parseRecord(line);
  if (record.v !== 1 || record.t !== 'workspace-confined-result' || typeof record.status !== 'string') {
    throw unsafe('native workspace confinement returned an invalid preview result');
  }
  switch (record.status) {
    case 'missing':
      if (!exactKeys(record, ['status', 't', 'v'])) break;
      return { status: 'missing' };
    case 'changed':
      if (!exactKeys(record, ['actualDigest', 'status', 't', 'v']) || !isDigest(record.actualDigest)) break;
      return { status: 'changed', actualDigest: record.actualDigest };
    case 'too_large': {
      const withDigest = record.digest !== undefined;
      if (
        !exactKeys(record, withDigest ? ['digest', 'size', 'status', 't', 'v'] : ['size', 'status', 't', 'v'])
        || !isSafeSize(record.size)
        || (withDigest && !isDigest(record.digest))
      ) break;
      return {
        status: 'too_large',
        size: record.size,
        ...(withDigest ? { digest: record.digest as string } : {}),
      };
    }
    case 'content': {
      if (
        !exactKeys(record, ['contentBase64', 'digest', 'size', 'status', 't', 'v'])
        || !isSafeSize(record.size)
        || !isDigest(record.digest)
      ) break;
      const content = parseBase64(record.contentBase64);
      if (content.byteLength !== record.size || content.byteLength > WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES) {
        throw unsafe('native workspace confinement returned content outside the preview bound');
      }
      return { status: 'content', content, digest: record.digest, size: record.size };
    }
    case 'error':
      throw nativeDomainError(record);
  }
  throw unsafe('native workspace confinement returned an invalid preview result');
}

function parseDeleteResult(line: string): void {
  const record = parseRecord(line);
  if (
    exactKeys(record, ['status', 't', 'v'])
    && record.v === 1
    && record.t === 'workspace-confined-result'
    && record.status === 'deleted'
  ) return;
  if (record.v === 1 && record.t === 'workspace-confined-result' && record.status === 'error') {
    throw nativeDomainError(record);
  }
  throw unsafe('native workspace confinement returned an invalid deletion result');
}

function parseExpectation(value: unknown): WorkspaceSyncEntryExpectationV1 {
  const parsed = WorkspaceSyncEntryExpectationV1Schema.safeParse(value);
  if (!parsed.success) throw unsafe('native workspace confinement returned an invalid entry expectation');
  return parsed.data;
}

function parseObserveResult(line: string): WorkspaceSyncEntryExpectationV1 {
  const record = parseRecord(line);
  if (record.v === 1 && record.t === 'workspace-confined-result' && record.status === 'error') {
    throw nativeDomainError(record);
  }
  if (
    !exactKeys(record, ['expectation', 'status', 't', 'v'])
    || record.v !== 1
    || record.t !== 'workspace-confined-result'
    || record.status !== 'observed'
  ) throw unsafe('native workspace confinement returned an invalid observation result');
  return parseExpectation(record.expectation);
}

function parseMeasureResult(line: string): number {
  const record = parseRecord(line);
  if (record.v === 1 && record.t === 'workspace-confined-result' && record.status === 'error') throw nativeDomainError(record);
  if (!exactKeys(record, ['sizeBytes', 'status', 't', 'v']) || record.v !== 1
    || record.t !== 'workspace-confined-result' || record.status !== 'measured'
    || typeof record.sizeBytes !== 'number' || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) {
    throw unsafe('native workspace confinement returned an invalid size measurement');
  }
  return record.sizeBytes;
}

function parseCaptureResult(line: string): NativeConfinedCapturedEntry {
  const record = parseRecord(line);
  if (record.v === 1 && record.t === 'workspace-confined-result' && record.status === 'error') {
    throw nativeDomainError(record);
  }
  if (
    !exactKeys(record, ['expectation', 'materialPath', 'status', 't', 'v'])
    || record.v !== 1
    || record.t !== 'workspace-confined-result'
    || record.status !== 'captured'
    || (record.materialPath !== null && typeof record.materialPath !== 'string')
  ) throw unsafe('native workspace confinement returned an invalid capture result');
  const expectation = parseExpectation(record.expectation);
  if ((expectation.kind === 'missing') !== (record.materialPath === null)) {
    throw unsafe('native workspace confinement returned inconsistent capture material');
  }
  return { expectation, materialPath: record.materialPath as string | null };
}

function parseDispositionResult(
  line: string,
  settledStatus: 'settled' | 'installed' | 'restored',
): NativeConfinedApplyOutcome | NativeConfinedRecoverOutcome {
  const record = parseRecord(line);
  if (record.v === 1 && record.t === 'workspace-confined-result' && record.status === 'error') {
    throw nativeDomainError(record);
  }
  if (record.v !== 1 || record.t !== 'workspace-confined-result') {
    throw unsafe('native workspace confinement returned an invalid recovery disposition');
  }
  if (record.status === settledStatus && exactKeys(record, ['status', 't', 'v'])) {
    return { status: settledStatus };
  }
  if (
    record.status === 'recovery_needed'
    && exactKeys(record, ['recoveryPath', 'status', 't', 'v'])
    && typeof record.recoveryPath === 'string'
    && record.recoveryPath.length > 0
  ) return { status: 'recovery_needed', recoveryPath: record.recoveryPath };
  throw unsafe('native workspace confinement returned an invalid recovery disposition');
}

function parseInspectResult(line: string): Readonly<{ rootPath: string; operationId: string }> {
  const record = parseRecord(line);
  if (record.v === 1 && record.t === 'workspace-confined-result' && record.status === 'error') {
    throw nativeDomainError(record);
  }
  if (
    !exactKeys(record, ['operationId', 'rootPath', 'status', 't', 'v'])
    || record.v !== 1
    || record.t !== 'workspace-confined-result'
    || record.status !== 'recovery_record'
    || typeof record.rootPath !== 'string'
    || record.rootPath.length === 0
    || typeof record.operationId !== 'string'
    || !/^[A-Za-z0-9_-]+$/u.test(record.operationId)
  ) throw unsafe('native workspace confinement returned an invalid recovery record identity');
  return { rootPath: record.rootPath, operationId: record.operationId };
}

async function runExchange<T>(input: Readonly<{
  command:
    | 'workspace-confined-read'
    | 'workspace-confined-delete'
    | 'workspace-confined-observe'
    | 'workspace-confined-capture'
    | 'workspace-confined-apply'
    | 'workspace-confined-inspect'
    | 'workspace-confined-recover';
  request: Readonly<Record<string, unknown>>;
  assertCurrentAuthority?: () => Promise<void>;
  parseResult(line: string): T;
  dependencies: WorkspaceSyncNativeConfinedDependencies;
}>): Promise<T> {
  const platform = input.dependencies.platform ?? process.platform;
  const linuxPromotionCommand = input.command === 'workspace-confined-apply' || input.command === 'workspace-confined-inspect' || input.command === 'workspace-confined-recover';
  if (platform !== 'win32' && platform !== 'darwin' && !(platform === 'linux' && linuxPromotionCommand)) {
    throw unsafe(`native workspace filesystem confinement is unavailable on ${platform}`);
  }
  const resolveExecutable = input.dependencies.resolveExecutable ?? resolveProcessCustodySupportExecutable;
  const executablePath = resolveExecutable(platform);
  if (!executablePath) throw unsafe('native workspace filesystem confinement is unavailable');
  const spawnChild: SpawnChild = input.dependencies.spawnChild
    ?? ((path, args, options) => nodeSpawn(path, args, options));
  let child: WorkspaceSyncNativeConfinedChild;
  try {
    child = spawnChild(executablePath, [input.command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    throw unsafe('native workspace filesystem confinement could not start', error);
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let phase: 'preparing' | 'authority' | 'result' | 'closing' = 'preparing';
    let stdoutBuffer = '';
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    let stderr = '';
    let stderrBytes = 0;
    const stderrDecoder = new StringDecoder('utf8');
    let result: Readonly<{ value: T }> | undefined;
    let processing = Promise.resolve();

    const finishReject = (error: unknown, kill = true) => {
      if (settled) return;
      settled = true;
      if (kill) child.kill();
      reject(error);
    };

    const handleLine = async (line: string) => {
      if (phase === 'preparing') {
        parsePrepared(line);
        phase = 'authority';
        try {
          await input.assertCurrentAuthority?.();
        } catch (error) {
          child.stdin.end(`${JSON.stringify({ v: 1, decision: 'abort' })}\n`);
          finishReject(error);
          return;
        }
        phase = 'result';
        child.stdin.end(`${JSON.stringify({ v: 1, decision: 'commit' })}\n`);
        return;
      }
      if (phase !== 'result') throw unsafe('native workspace confinement returned an unexpected extra record');
      result = { value: input.parseResult(line) };
      phase = 'closing';
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > STDOUT_MAX_BYTES) {
        finishReject(unsafe('native workspace confinement exceeded its output bound'));
        return;
      }
      stdoutBuffer += stdoutDecoder.write(bytes);
      while (stdoutBuffer.includes('\n')) {
        const newline = stdoutBuffer.indexOf('\n');
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        processing = processing.then(async () => await handleLine(line));
        processing.catch((error: unknown) => finishReject(error));
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > STDERR_MAX_BYTES) {
        finishReject(unsafe('native workspace confinement exceeded its diagnostic bound'));
        return;
      }
      stderr += stderrDecoder.write(bytes);
    });
    child.stdin.on('error', (error: Error) => finishReject(unsafe('native workspace confinement input failed', error)));
    child.on('error', (error: Error) => finishReject(unsafe('native workspace confinement process failed', error), false));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      stdoutBuffer += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      void processing.then(() => {
        if (settled) return;
        if (code !== 0 || signal !== null || phase !== 'closing' || stdoutBuffer.trim() !== '' || result === undefined) {
          const diagnostic = stderr.trim();
          finishReject(unsafe(diagnostic
            ? `native workspace confinement failed: ${diagnostic}`
            : 'native workspace confinement ended without a valid result'), false);
          return;
        }
        settled = true;
        resolve(result.value);
      }, (error: unknown) => finishReject(error, false));
    });

    child.stdin.write(`${JSON.stringify(input.request)}\n`, (error?: Error | null) => {
      if (error) finishReject(unsafe('native workspace confinement request failed', error));
    });
  });
}

export async function runNativeConfinedWorkspaceSyncRead(
  input: RunNativeConfinedReadInput,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<NativeConfinedReadOutcome> {
  return await runExchange({
    command: 'workspace-confined-read',
    request: {
      v: 1,
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      maxBytes: input.maxBytes,
      ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
    },
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    parseResult: parseReadResult,
    dependencies,
  });
}

export async function runNativeConfinedWorkspaceSyncDelete(
  input: RunNativeConfinedDeleteInput,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<void> {
  return await runExchange({
    command: 'workspace-confined-delete',
    request: {
      v: 1,
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      expectedKind: input.expectedKind,
      ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
    },
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    parseResult: parseDeleteResult,
    dependencies,
  });
}


export async function runNativeConfinedWorkspaceSyncObserve(
  input: WorkspaceSyncNativeConfinedCommonInput,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<WorkspaceSyncEntryExpectationV1> {
  return await runExchange({
    command: 'workspace-confined-observe',
    request: { v: 1, rootPath: input.rootPath, relativePath: input.relativePath },
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    parseResult: parseObserveResult,
    dependencies,
  });
}

export async function runNativeConfinedWorkspaceSyncMeasure(
  input: WorkspaceSyncNativeConfinedCommonInput,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<number> {
  return await runExchange({
    command: 'workspace-confined-observe',
    request: { v: 1, rootPath: input.rootPath, relativePath: input.relativePath, measureSize: true },
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    parseResult: parseMeasureResult,
    dependencies,
  });
}

export async function runNativeConfinedWorkspaceSyncCapture(
  input: RunNativeConfinedCaptureInput,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<NativeConfinedCapturedEntry> {
  return await runExchange({
    command: 'workspace-confined-capture',
    request: {
      v: 1,
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      expected: input.expected,
      captureDirectory: input.captureDirectory,
      operationId: input.operationId,
    },
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    parseResult: parseCaptureResult,
    dependencies,
  });
}

export async function runNativeConfinedWorkspaceSyncApply(
  input: RunNativeConfinedApplyInput,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<NativeConfinedApplyOutcome> {
  if ((input.selectedExpectation.kind === 'missing') !== (input.materialPath === null)) {
    throw unsafe('native workspace confinement apply material does not match the selected entry');
  }
  return await runExchange({
    command: 'workspace-confined-apply',
    request: {
      v: 1,
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      expectedDestination: input.expectedDestination,
      selectedExpectation: input.selectedExpectation,
      materialPath: input.materialPath,
      recoveryDirectory: input.recoveryDirectory,
      operationId: input.operationId,
    },
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    parseResult: (line) => {
      const parsed = parseRecord(line);
      if (parsed.status === 'installed') return parseDispositionResult(line, 'installed') as NativeConfinedApplyOutcome;
      if (parsed.status === 'restored') return parseDispositionResult(line, 'restored') as NativeConfinedApplyOutcome;
      return parseDispositionResult(line, 'installed') as NativeConfinedApplyOutcome;
    },
    dependencies,
  });
}

export async function runNativeConfinedWorkspaceSyncRecover(
  input: RunNativeConfinedRecoverInput,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<NativeConfinedRecoverOutcome> {
  return await runExchange({
    command: 'workspace-confined-recover',
    request: {
      v: 1,
      rootPath: input.rootPath,
      recoveryDirectory: input.recoveryDirectory,
      operationId: input.operationId,
    },
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    parseResult: (line) => parseDispositionResult(line, 'settled') as NativeConfinedRecoverOutcome,
    dependencies,
  });
}

/** Discover retained native recovery records; the helper alone parses their payloads. */
export async function discoverNativeConfinedWorkspaceSyncRecovery(
  input: Readonly<{ recoveryDirectory: string }>,
  dependencies: WorkspaceSyncNativeConfinedDependencies = {},
): Promise<readonly NativeConfinedRecoveryRecord[]> {
  const names = await readdir(input.recoveryDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const records: NativeConfinedRecoveryRecord[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith('workspace-recovery-')) continue;
    const match = /^workspace-recovery-([A-Za-z0-9_-]+)\.json$/u.exec(name);
    if (!match || !match[1]) throw unsafe('workspace recovery directory contains an invalid native record name');
    const operationId = match[1];
    const inspected = await runExchange({
      command: 'workspace-confined-inspect',
      request: { v: 1, recoveryDirectory: input.recoveryDirectory, operationId },
      parseResult: parseInspectResult,
      dependencies,
    });
    if (inspected.operationId !== operationId) {
      throw unsafe('native workspace recovery record identity changed during inspection');
    }
    records.push({ operationId, rootPath: inspected.rootPath, recoveryPath: join(input.recoveryDirectory, name) });
  }
  return records;
}
