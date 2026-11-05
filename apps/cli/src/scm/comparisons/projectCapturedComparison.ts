import type { ScmComparisonCaptureInput, ScmComparisonCaptureOutput, ScmDiffSummaryGenerateOutput } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmComparisonFile } from '@happier-dev/protocol/scm/comparison';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { resolve } from 'node:path';
import type { CapturedScmComparison } from './captureScmComparison';

export function findCapturedComparisonFile(captured: Pick<CapturedScmComparison, 'comparison'>, path: string): ScmComparisonFile | undefined {
  const root = captured.comparison.repository.rootPath;
  const requested = resolve(root, path);
  return captured.comparison.inventory.files.find(file => resolve(root, file.path) === requested);
}

export function projectCapturedComparisonFileIndex(file: ScmComparisonFile): ScmComparisonFile {
  if (file.evidence.state === 'deferred') return file;
  let linesAdded = 0;
  let linesRemoved = 0;
  if (file.evidence.unifiedDiff !== undefined) {
    for (const hunk of parseUnifiedDiffHunks(file.evidence.unifiedDiff)) for (const line of hunk.lines) {
      if (line.kind === 'add') linesAdded++;
      if (line.kind === 'remove') linesRemoved++;
    }
  }
  return { ...file, linesAdded, linesRemoved,
    evidence: file.evidence.state === 'unavailable' && typeof file.evidence.unifiedDiff !== 'string'
      ? { state: 'unavailable', reason: file.evidence.reason }
      : { state: 'deferred', reason: file.evidence.state === 'unavailable'
        ? file.evidence.reason : 'Captured file evidence is fetched when opened.' } };
}

const unavailable = (error: string): ScmComparisonCaptureOutput => ({ success: false, errorCode: 'DIFF_UNAVAILABLE', error });

/** Saved output references need every occurrence; patch bodies use the same pinned file reader as live captures. */
export function projectCapturedScmOutput(output: ScmDiffSummaryGenerateOutput): ScmDiffSummaryGenerateOutput {
  if (!output.comparison) return output;
  const comparison = output.comparison;
  return { ...output, comparison: { ...comparison, inventory: { ...comparison.inventory,
    files: comparison.inventory.files.map(projectCapturedComparisonFileIndex) } } };
}

/** Transport projection of retained evidence; storage remains owned by captureScmComparison. */
export function projectCapturedComparison(captured: Pick<CapturedScmComparison, 'comparison' | 'metadata'>,
  projection?: ScmComparisonCaptureInput['projection']): ScmComparisonCaptureOutput {
  if (!projection) {
    const response = { success: true as const, comparison: captured.comparison, metadata: captured.metadata };
    let bytes = Buffer.byteLength(JSON.stringify({ ...response, comparison: { ...response.comparison,
      inventory: { ...response.comparison.inventory, files: [] } } }), 'utf8');
    for (const [position, file] of captured.comparison.inventory.files.entries()) {
      bytes += Buffer.byteLength(JSON.stringify(file), 'utf8') + (position ? 1 : 0);
      if (bytes > WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES) {
        return unavailable('Captured evidence exceeds the socket response limit. Update the client to request a paged file index.');
      }
    }
    return bytes <= WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES ? response : unavailable('Captured metadata exceeds the socket response limit.');
  }
  const sourceFiles = projection.path ? (() => {
    const file = findCapturedComparisonFile(captured, projection.path);
    return file ? [file] : [];
  })() : captured.comparison.inventory.files;
  const totalFiles = sourceFiles.length;
  const cursor = projection.cursor ?? 0;
  if (cursor > totalFiles) return unavailable('The file index cursor is outside this captured comparison.');
  const page = createIndexPage(captured, totalFiles);
  if (!page.response.success) return page.response;
  for (let position = cursor; position < totalFiles; position++) {
    if (!page.append(sourceFiles[position]!, position)) break;
  }
  return page.response;
}

function createIndexPage(captured: Pick<CapturedScmComparison, 'comparison' | 'metadata'>, totalFiles: number) {
  const files: ScmComparisonFile[] = [];
  const response = { success: true as const, comparison: { ...captured.comparison,
    inventory: { ...captured.comparison.inventory, files } }, metadata: captured.metadata,
    page: { totalFiles, nextCursor: null as number | null } };
  // Reserve the longest possible cursor representation once; each entry is serialized once.
  let bytes = Buffer.byteLength(JSON.stringify(response), 'utf8') + Math.max(0, String(totalFiles).length - 4);
  if (bytes > WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES) return { response: unavailable('Captured metadata exceeds the socket response limit.'), append: () => false };
  const append = (input: ScmComparisonFile, position: number): boolean => {
    const file = projectCapturedComparisonFileIndex(input);
    const entryBytes = Buffer.byteLength(JSON.stringify(file), 'utf8') + (files.length ? 1 : 0);
    if (bytes + entryBytes > WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES) {
      if (!files.length) page.response = unavailable('A captured file metadata entry exceeds the socket response limit.');
      else response.page.nextCursor = position;
      return false;
    }
    bytes += entryBytes;
    files.push(file);
    return true;
  };
  const page = { response: response as ScmComparisonCaptureOutput, append };
  return page;
}

/** The same transport decision consumes either an in-memory inventory or seekable retained records. */
export async function projectCapturedComparisonIndex(captured: Pick<CapturedScmComparison, 'comparison' | 'metadata'>,
  input: Readonly<{ totalFiles: number; cursor?: number; readFile: (position: number) => Promise<ScmComparisonFile> }>): Promise<ScmComparisonCaptureOutput> {
  const cursor = input.cursor ?? 0;
  if (cursor > input.totalFiles) return unavailable('The file index cursor is outside this captured comparison.');
  const page = createIndexPage(captured, input.totalFiles);
  if (!page.response.success) return page.response;
  for (let position = cursor; position < input.totalFiles; position++) {
    if (!page.append(await input.readFile(position), position)) break;
  }
  return page.response;
}
