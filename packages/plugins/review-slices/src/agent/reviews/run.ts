import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import { createSecureTempDirectorySync } from '@happier-dev/plugin-sdk/fs';
import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';
import { readSliceFinding, readSliceRun, readSliceSelection, type SliceFindingEvidence } from './state.js';

export type SliceReviewResult = Readonly<{
  status: 'completed' | 'partial' | 'failed';
  nativeRunId: string | null;
  findings: readonly ReviewFinding[];
  findingEvidence: readonly SliceFindingEvidence[];
  errors: readonly Readonly<{ message: string; code: string | null }>[];
}>;

export type RunSliceReviewInput = Readonly<{
  exec: Pick<ExecService, 'run' | 'spawn'>;
  fs: Pick<FileSystemService, 'getPluginDataDirectory'>;
  cwd: string;
  /** Plugin-owned configuration/repository subdirectory beneath the SDK root. */
  stateRelativePath: string;
  featureIds?: readonly string[];
  provider?: string;
  model?: string;
  instructions?: string;
  onProgress?: (progress?: Readonly<{ phase: 'start' | 'done'; featureId: string; index: number; total: number }>) => void;
  environment?: Readonly<Record<string, string>>;
  signal: AbortSignal;
}>;

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Slice review cancelled', 'AbortError');
}

function succeeded(result: PluginProcessResult): boolean {
  return result.termination.requestedBy.kind === 'none'
    && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
}

function decode(result: PluginProcessResult): unknown {
  if (result.stdoutTruncated) throw new Error('Native slice result is incomplete');
  return JSON.parse(Buffer.from(result.stdout).toString('utf8'));
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Native 0.8.4 owns mapping, scheduling and retained state. This adapter only
 * selects explicit slices and joins this invocation's run IDs to native records. */
export async function runSliceReview(input: RunSliceReviewInput): Promise<SliceReviewResult> {
  checkCancellation(input.signal);
  const directory = await input.fs.getPluginDataDirectory({ relativePath: input.stateRelativePath, signal: input.signal });
  const common = ['--no-input', '--root', input.cwd, '--state-dir', directory, '--json'];
  const provider = [...(input.provider ? ['--provider', input.provider] : []), ...(input.model ? ['--model', input.model] : [])];
  const invoke = async (args: readonly string[]) => {
    checkCancellation(input.signal);
    input.onProgress?.();
    const request = { executable: { kind: 'managedDependency', id: 'review-executable' } as const,
      args: [...args, ...common], cwd: input.cwd, env: input.environment };
    const options = { signal: input.signal, outputDelivery: 'invocation' } as const;
    let result: PluginProcessResult;
    if (args[0] === 'review') {
      const child = await input.exec.spawn(request, options);
      const decoder = new TextDecoder();
      let pending = '';
      const consume = (text: string) => {
        pending += text;
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          // Native 0.8.4 progress.ts emits these ordered fields on stderr.
          // Forward reported units only, never infer completion from log volume.
          const match = /^clawpatch review feature-(start|done) index=(\d+) total=(\d+) feature=(\S+)(?:\s|$)/u.exec(line);
          if (match) input.onProgress?.({ phase: match[1] === 'start' ? 'start' : 'done',
            index: Number(match[2]), total: Number(match[3]), featureId: match[4]! });
        }
      };
      const subscription = child.onOutput(chunk => {
        if (chunk.stream === 'stderr') consume(decoder.decode(chunk.data, { stream: true }));
      });
      try {
        result = await child.wait();
        consume(decoder.decode() + '\n');
      } finally {
        subscription.dispose();
        await child.dispose();
      }
    } else result = await input.exec.run(request, options);
    checkCancellation(input.signal);
    if (result.termination.requestedBy.kind === 'abort') throw new DOMException('Slice review cancelled', 'AbortError');
    return result;
  };
  if (!await exists(join(directory, 'project.json'))) {
    if (!succeeded(await invoke(['init']))) throw new Error('Native slice initialization failed');
  }
  if (!succeeded(await invoke(['map', ...provider]))) throw new Error('Native slice mapping failed');
  const names = (await readdir(join(directory, 'features'))).filter(name => name.endsWith('.json')).sort();
  const activeIds = (await Promise.all(names.map(async name => readSliceSelection(JSON.parse(
    await readFile(join(directory, 'features', name), 'utf8')))))).filter(item => item.status !== 'skipped').map(item => item.featureId);
  const featureIds = input.featureIds ?? activeIds;
  if (featureIds.length === 0) return { status: 'completed', nativeRunId: null, findings: [], findingEvidence: [], errors: [] };
  const selection = createSecureTempDirectorySync({ prefix: 'review-slices-selection' });
  let result: PluginProcessResult;
  try {
    const selectionPath = join(selection.path, 'slices.txt');
    await writeFile(selectionPath, featureIds.join('\n') + '\n');
    const promptPath = join(selection.path, 'instructions.txt');
    if (input.instructions) await writeFile(promptPath, input.instructions);
    result = await invoke(['review', '--feature-list', selectionPath,
      ...(input.instructions ? ['--prompt-file', promptPath] : []), ...provider]);
  } finally { selection.cleanup(); }
  // A failed native review still writes its run and full findings. Its start
  // diagnostic identifies that run; never discover it by scanning old history.
  const response = succeeded(result) ? decode(result) : null;
  const runId = response && typeof response === 'object' && 'run' in response && typeof response.run === 'string'
    ? response.run
    : !result.stderrTruncated ? /(?:^|\n)clawpatch review start run=([A-Za-z0-9_-]+)(?:\s|$)/u.exec(Buffer.from(result.stderr).toString('utf8'))?.[1] : undefined;
  if (!runId) throw new Error('Native slice review did not identify its run');
  const run = readSliceRun(JSON.parse(await readFile(join(directory, 'runs', `${safeRecordId(runId)}.json`), 'utf8')), runId);
  const mapped = await Promise.all(run.findingIds.map(async (id, index) => readSliceFinding(JSON.parse(
    await readFile(join(directory, 'findings', `${safeRecordId(id)}.json`), 'utf8')), id, runId, index)));
  return { status: !succeeded(result) || run.status !== 'completed' ? 'failed' : run.errors.length ? 'partial' : 'completed',
    nativeRunId: runId, findings: mapped.map(item => item.finding), findingEvidence: mapped.map(item => item.evidence), errors: run.errors };
}

function safeRecordId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error('Invalid native slice record identity');
  return id;
}
