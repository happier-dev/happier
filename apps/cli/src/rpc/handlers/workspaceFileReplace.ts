import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { createHash } from 'node:crypto';
import { run as runRipgrep } from '@/integrations/ripgrep/index';
import { computeFileReplacement, decodeReplaceFileText } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { applyInverseEdits } from '@happier-dev/protocol/diff/hunks';
import { isFilesystemWriteGuardErrorCode } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { DaemonWorkspaceFileReplacePreviewRequestSchema, DaemonWorkspaceFileReplaceApplyRequestSchema,
  WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES,
  type DaemonWorkspaceFileReplacePreviewResponse, type DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath, authorizeFilesystemPathWithinRoot } from './fileSystem/accessPolicy/filesystemPathAuthorization';
import { isSafeRelativeWorkspacePath, workspaceFileExclusionArguments } from './workspaceFilePaths';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { applyWorkspaceFileTextEdits } from '@/lsp/documentText';

const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const responseBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
type ApplySuccess = Extract<DaemonWorkspaceFileReplaceApplyResponse, { ok: true }>;
type FileResult = ApplySuccess['results'][number];
type PreviewSuccess = Extract<DaemonWorkspaceFileReplacePreviewResponse, { ok: true }>;
type FilesystemEffectContext = Readonly<{
  signal?: AbortSignal;
}>;

/** Destination absence through the admitted source (same outcome code as the guarded writer). */
async function assertWorkspaceFileAbsent(path: string): Promise<void> {
  try { await currentWorkspaceSource().stat(path); }
  catch (error) { if (readErrorCode(error) === 'ENOENT') return; throw error; }
  throw Object.assign(new Error('File already exists but was expected to be new'), { code: 'expected_file_absent' });
}

function readErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function fileResultBytes(result: FileResult): number {
  if (!result.edits) return responseBytes(result);
  let size = responseBytes({ ...result, edits: [] });
  for (let index = 0; index < result.edits.length; index++) {
    const edit = result.edits[index];
    if (edit.insertText.length + edit.originalText.length > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) return WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES + 1;
    size += responseBytes(edit) + (index ? 1 : 0);
    if (size > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) break;
  }
  return size;
}

/** Native read reached after canonical Action admission. */
export async function previewWorkspaceFileReplace(
  raw: unknown,
  workingDirectory: string,
  accessPolicy: FilesystemAccessPolicy,
  context?: FilesystemEffectContext,
): Promise<DaemonWorkspaceFileReplacePreviewResponse> {
    const parsed = DaemonWorkspaceFileReplacePreviewRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'invalid_pattern' };
    const request = parsed.data;
    const root = authorizeFilesystemPath({ targetPath: request.rootPath, defaultDirectory: workingDirectory, accessPolicy });
    if (!root.valid) return { ok: false, code: 'root_not_allowed' };
    const matcher = { query: request.query, replacement: request.replacement, matchCase: request.matchCase ?? false, regex: request.regex ?? false };
    const files: PreviewSuccess['files'] = [];
    const skipped = { notText: 0 };
    let coverage: PreviewSuccess['coverage'] = 'complete';
    let lastPath = request.cursor?.path;
    try {
      // Validate even an empty corpus through the one JavaScript matcher.
      computeFileReplacement(new Uint8Array(), matcher);
      context?.signal?.throwIfAborted();
      // Rust and JavaScript regexes can disagree even when both compile (for
      // example Unicode word boundaries), and rg omits empty files from queried
      // results. Inventory regex candidates so the JS owner alone decides hits.
      const discovery = await runRipgrep(['--no-config', '--null',
        ...(request.includeHidden ? ['--hidden'] : []), ...workspaceFileExclusionArguments(),
        ...(matcher.regex ? ['--files', '--', '.'] : ['--files-with-matches', '--binary', '--fixed-strings',
          ...(!matcher.matchCase ? ['--ignore-case'] : []), '--', request.query, '.'])], {
        cwd: root.resolvedPath, signal: context?.signal, maxStderrBytes: WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES,
      });
      context?.signal?.throwIfAborted();
      if (discovery.exitCode === 127) return { ok: false, code: 'ripgrep_unavailable' };
      if (discovery.exitCode !== 0 && discovery.exitCode !== 1) {
        if (discovery.exitCode !== 2 || !discovery.stdout) return { ok: false, code: 'ripgrep_failed' };
        coverage = 'partial';
      }
      const paths = [...new Set(discovery.stdout.split('\0').filter(Boolean).map(path => path.replace(/\\/g, '/').replace(/^\.\//u, '')))].sort();
      const longestCursor = paths.reduce((longest, path) => responseBytes(path) > responseBytes(longest) ? path : longest, '');
      // Reserve the largest envelope produced by this scan. Measure each
      // bounded match once, never stringify an oversized repeated-line page.
      const envelopeBytes = responseBytes({ ok: true, files: [], skipped: { notText: paths.length }, hasMore: false, coverage: 'complete', cursor: { path: longestCursor } });
      let filesBytes = 0;
      for (const path of paths) {
        context?.signal?.throwIfAborted();
        if (request.cursor && path <= request.cursor.path) continue;
        const authorization = isSafeRelativeWorkspacePath(path)
          ? authorizeFilesystemPathWithinRoot({ targetPath: path, rootPath: root.resolvedPath, defaultDirectory: workingDirectory, accessPolicy })
          : { valid: false as const };
        if (!authorization.valid) { coverage = 'partial'; lastPath = path; continue; }
        let bytes: Buffer;
        context?.signal?.throwIfAborted();
        try { bytes = await currentWorkspaceSource().readFile(authorization.resolvedPath); } catch { coverage = 'partial'; lastPath = path; continue; }
        context?.signal?.throwIfAborted();
        const replacement = computeFileReplacement(bytes, matcher);
        if (replacement.kind === 'skip') { skipped.notText++; coverage = 'partial'; lastPath = path; continue; }
        if (!replacement.matches.length) { lastPath = path; continue; }
        const count = request.contextLines ?? 2;
        const file: PreviewSuccess['files'][number] = { path, hash: hashBytes(bytes), matchCount: replacement.matches.length, matches: [] };
        let fileBytes = responseBytes(file);
        for (const match of replacement.matches) {
          const projected = { ...match, before: count ? match.before.slice(-count) : [], after: match.after.slice(0, count) };
          // Every UTF-16 unit needs at least one UTF-8/JSON byte. This cheap
          // lower bound avoids constructing enormous single-match JSON too.
          if ([projected.text, projected.replacedText, ...projected.before, ...projected.after].reduce((sum, text) => sum + text.length, 0) > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
            fileBytes = WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES + 1; break;
          }
          fileBytes += responseBytes(projected) + (file.matches.length ? 1 : 0);
          if (envelopeBytes + fileBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) break;
          file.matches.push(projected);
        }
        if (envelopeBytes + fileBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
          // An indivisible file cannot travel in this RPC's response; preserve
          // explicit incomplete coverage rather than select unloaded matches.
          coverage = 'partial'; lastPath = path; continue;
        }
        const additionBytes = fileBytes + (files.length ? 1 : 0);
        if (envelopeBytes + filesBytes + additionBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
          context?.signal?.throwIfAborted();
          return { ok: true, files, skipped, hasMore: true, coverage: 'partial', cursor: { path: lastPath! } };
        }
        files.push(file); filesBytes += additionBytes; lastPath = path;
      }
      context?.signal?.throwIfAborted();
      return { ok: true, files, skipped, hasMore: false, coverage };
    } catch (error) {
      if (context?.signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error;
      if (readErrorCode(error) === 'WORKSPACE_ROOT_NOT_FOUND') return { ok: false, code: 'root_not_found' };
      return { ok: false, code: error instanceof SyntaxError ? 'invalid_pattern' : 'ripgrep_failed' };
    }
}

export function registerWorkspaceFileReplaceHandlers(
  registrar: RpcHandlerRegistrar,
  _workingDirectory: string,
  opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy; machineId?: string;
    resolveActionExecutor?: () => RpcActionExecutor | null; actionExecutor?: RpcActionExecutor }>,
): void {
  registerActionSpecRpcHandlers({
    rpcHandlerManager: registrar,
    actionIds: ['workspace.files.replace.preview', 'workspace.files.replace'],
    ...(opts?.machineId ? { targetMachineId: opts.machineId, defaultMachineTarget: true } : {}),
    resolveActionExecutor: () => opts?.resolveActionExecutor?.() ?? opts?.actionExecutor ?? {
      execute: async () => ({ ok: false, errorCode: 'workspace_file_replace_action_owner_unavailable', error: 'Workspace replacement Action admission is unavailable' }),
    },
    mapRequestForMethod: ({ input }) => {
      if (!opts?.machineId || !input || typeof input !== 'object' || Array.isArray(input)) return { accepted: true, input };
      return { accepted: true, input: { machineId: opts.machineId, ...input } };
    },
  });
}

/** Native effect reached after canonical Action admission; also owns inverse restore. */
export async function applyWorkspaceFileReplace(
  raw: unknown,
  workingDirectory: string,
  accessPolicy: FilesystemAccessPolicy,
  context?: FilesystemEffectContext,
): Promise<DaemonWorkspaceFileReplaceApplyResponse> {
    const parsed = DaemonWorkspaceFileReplaceApplyRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { rootPath, operation } = parsed.data;
    const root = authorizeFilesystemPath({ targetPath: rootPath, defaultDirectory: workingDirectory, accessPolicy });
    if (!root.valid) return { ok: false, code: 'root_not_allowed' };
    // If even the paths' refusal receipts cannot travel, publish no writes.
    // The caller retains the requested paths and can show the omitted refusals
    // from this explicit truncation fact without losing any applied inverse.
    const refusals: FileResult[] = [];
    let refusalBytes = responseBytes({ ok: true, results: [], truncated: true });
    for (const file of operation.files) {
      const refusal: FileResult = { path: file.path, status: 'failed', reason: 'transport_ceiling' };
      const nextBytes = responseBytes(refusal) + (refusals.length ? 1 : 0);
      if (refusalBytes + nextBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
        return { ok: true, results: refusals, truncated: true };
      }
      refusals.push(refusal);
      refusalBytes += nextBytes;
    }
    if (context?.signal?.aborted) return { ok: true, results: [], cancelled: operation.files.map(file => file.path) };
    if (operation.kind === 'replace') {
      try { computeFileReplacement(new Uint8Array(), { ...operation.matcher, matchCase: operation.matcher.matchCase ?? false, regex: operation.matcher.regex ?? false }); }
      catch (error) { if (error instanceof SyntaxError) return { ok: false, code: 'invalid_pattern' }; throw error; }
    }
    const results: FileResult[] = [];
    const dependentEditSet = operation.kind === 'editSet'
      || operation.kind === 'restore' && operation.files.some(file => file.renameTo !== undefined);
    // Undo receipts run in reverse time order. Refuse a known inverse-move
    // destination conflict before restoring importers; the actual move still
    // repeats the same canonical absence guard immediately before publication.
    if (operation.kind === 'restore') {
      for (let index = 0; index < operation.files.length; index++) {
        const file = operation.files[index];
        if (!file.renameTo || file.renameTo === file.path) continue;
        if (context?.signal?.aborted) return { ok: true, results: [], cancelled: operation.files.map(file => file.path) };
        const destination = isSafeRelativeWorkspacePath(file.renameTo)
          ? authorizeFilesystemPathWithinRoot({ targetPath: file.renameTo, rootPath: root.resolvedPath, defaultDirectory: workingDirectory, accessPolicy })
          : { valid: false as const };
        let refusal: FileResult | undefined;
        if (!destination.valid) refusal = { path: file.path, status: 'failed', reason: 'path_not_allowed' };
        else {
          try { await assertWorkspaceFileAbsent(destination.resolvedPath); }
          catch (error) {
            const code = readErrorCode(error);
            refusal = { path: file.path, status: isFilesystemWriteGuardErrorCode(code) ? 'changed' : 'failed', reason: code ?? 'read_failed' };
          }
        }
        if (refusal) {
          const failed = refusal;
          return { ok: true, results: operation.files.map((file, fileIndex): FileResult => fileIndex === index
            ? failed : { path: file.path, status: 'skipped', reason: 'edit_set_aborted' }) };
        }
      }
    }
    type PreparedFile = Readonly<{ sourcePath: string; destinationPath: string; expectedHash: string; newBytes: Uint8Array; result: FileResult }>;
    const failedFile = (path: string, error: unknown): FileResult => ({ path,
      status: ['ENOENT', 'ENOTDIR'].includes(readErrorCode(error) ?? '') || isFilesystemWriteGuardErrorCode(readErrorCode(error)) ? 'changed' : 'failed',
      reason: error instanceof SyntaxError ? 'invalid_pattern' : readErrorCode(error) ?? 'read_failed' });
    const prepareFile = async (index: number, prior: readonly FileResult[]): Promise<PreparedFile | FileResult> => {
      const file = operation.files[index];
      const authorization = authorizeFilesystemPathWithinRoot({ targetPath: file.path, rootPath: root.resolvedPath, defaultDirectory: workingDirectory, accessPolicy });
      if (!authorization.valid) return { path: file.path, status: 'failed', reason: 'path_not_allowed' };
      try {
        context?.signal?.throwIfAborted();
        const bytes = await currentWorkspaceSource().readFile(authorization.resolvedPath);
        context?.signal?.throwIfAborted();
        if (hashBytes(bytes) !== file.expectedHash) return { path: file.path, status: 'changed' };
        let newBytes: Uint8Array;
        let result: FileResult;
        if (operation.kind === 'replace') {
          const selected = operation.files[index];
          const replacement = computeFileReplacement(bytes, { ...operation.matcher, matchCase: operation.matcher.matchCase ?? false, regex: operation.matcher.regex ?? false }, selected.excludedMatches);
          if (replacement.kind === 'skip') return { path: file.path, status: 'skipped', reason: replacement.reason };
          if (!replacement.matches.length) return { path: file.path, status: 'changed' };
          newBytes = replacement.newBytes;
          result = { path: file.path, status: 'replaced', hash: hashBytes(newBytes), matchCount: replacement.matches.length, edits: [...replacement.edits] };
        } else if (operation.kind === 'restore') {
          const decoded = decodeReplaceFileText(bytes);
          if (decoded.kind === 'skip') return { path: file.path, status: 'skipped', reason: decoded.reason };
          const restored = applyInverseEdits(decoded.text, operation.files[index].edits);
          if (!restored.ok) return { path: file.path, status: 'changed', reason: restored.reason };
          newBytes = new TextEncoder().encode(restored.text);
          result = { path: file.path, status: 'restored', hash: hashBytes(newBytes) };
        } else {
          const decoded = decodeReplaceFileText(bytes);
          if (decoded.kind === 'skip') return { path: file.path, status: 'skipped', reason: decoded.reason };
          const edited = applyWorkspaceFileTextEdits(decoded.text, operation.files[index].edits);
          newBytes = new TextEncoder().encode(edited.text);
          result = { path: file.path, status: 'replaced', hash: hashBytes(newBytes), edits: edited.edits };
        }
        const renameTo = operation.kind !== 'replace' ? operation.files[index].renameTo : undefined;
        if (renameTo && renameTo !== file.path) result = { ...result, renameTo };
        const remaining = operation.files.slice(index + 1).map(next => ({ path: next.path, status: 'failed', reason: 'transport_ceiling' }));
        const otherResultsBytes = responseBytes({ ok: true, results: [...prior, ...remaining] });
        if (otherResultsBytes + fileResultBytes(result) + (prior.length + remaining.length ? 1 : 0) > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES)
          return { path: file.path, status: 'failed', reason: 'transport_ceiling' };
        let destinationPath = authorization.resolvedPath;
        if (renameTo && renameTo !== file.path) {
          const destination = isSafeRelativeWorkspacePath(renameTo)
            ? authorizeFilesystemPathWithinRoot({ targetPath: renameTo, rootPath: root.resolvedPath, defaultDirectory: workingDirectory, accessPolicy })
            : { valid: false as const };
          if (!destination.valid) return { path: file.path, status: 'failed', reason: 'path_not_allowed' };
          await assertWorkspaceFileAbsent(destination.resolvedPath);
          destinationPath = destination.resolvedPath;
        }
        return { sourcePath: authorization.resolvedPath, destinationPath, expectedHash: file.expectedHash, newBytes, result };
      } catch (error) { return failedFile(file.path, error); }
    };
    const publishFile = async (file: PreparedFile): Promise<FileResult> => {
      const { result, sourcePath, destinationPath, expectedHash, newBytes } = file;
      try {
        context?.signal?.throwIfAborted();
        if (result.renameTo) {
          const moved = await currentWorkspaceSource().replaceFile({ destPath: destinationPath, expectation: null,
            source: { kind: 'move', path: sourcePath, expectedHash } });
          if (!moved.success) return { path: result.path, status: isFilesystemWriteGuardErrorCode(moved.errorCode) ? 'changed' : 'failed', reason: moved.errorCode };
        }
        const write = await currentWorkspaceSource().replaceFile({ destPath: destinationPath, expectation: expectedHash,
          source: { kind: 'bytes', bytes: newBytes } });
        if (write.success) return { ...result, hash: write.hash };
        // A rename is already observable even if its subsequent text write
        // fails. Preserve its real hash and inverse move instead of losing Undo.
        if (result.renameTo) return { path: result.path, status: result.status, renameTo: result.renameTo,
          hash: expectedHash, edits: [], reason: write.errorCode };
        return { path: result.path, status: isFilesystemWriteGuardErrorCode(write.errorCode) ? 'changed' : 'failed', reason: write.errorCode ?? 'write_failed' };
      } catch (error) { return failedFile(result.path, error); }
    };
    if (operation.kind === 'editSet') {
      // Semantic edits form one dependent set. Prepare every target before
      // publishing any file or move, retaining only bounded reply receipts,
      // not all file bodies. Ordinary Replace and restore report per file.
      // Publication re-reads a target and the writer checks it again.
      const admitted: FileResult[] = [];
      let refused = false;
      for (let index = 0; index < operation.files.length; index++) {
        if (context?.signal?.aborted) return { ok: true, results: [], cancelled: operation.files.map(file => file.path) };
        const file = await prepareFile(index, admitted);
        if (context?.signal?.aborted) return { ok: true, results: [], cancelled: operation.files.map(file => file.path) };
        if (!('newBytes' in file)) refused = true;
        admitted.push('newBytes' in file ? file.result : file);
      }
      if (refused) return { ok: true, results: admitted.map((file): FileResult =>
        file.status === 'replaced' ? { path: file.path, status: 'skipped', reason: 'edit_set_aborted' } : file) };
    }
    for (let index = 0; index < operation.files.length; index++) {
      if (context?.signal?.aborted) return { ok: true, results, cancelled: operation.files.slice(index).map(file => file.path) };
      const previous = results.at(-1);
      if (dependentEditSet && previous && (!['replaced', 'restored'].includes(previous.status) || previous.reason !== undefined)) {
        return { ok: true, results: [...results, ...operation.files.slice(index).map(file => ({
          path: file.path, status: 'skipped' as const, reason: 'edit_set_aborted',
        }))] };
      }
      // Inverse receipts may visit a path repeatedly in reverse time order;
      // each restore must read the bytes produced by its preceding receipt.
      const file = await prepareFile(index, results);
      if (context?.signal?.aborted) return { ok: true, results, cancelled: operation.files.slice(index).map(file => file.path) };
      results.push('newBytes' in file ? await publishFile(file) : file);
    }
    return { ok: true, results };
}
