import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import { createSecureTempDirectorySync } from '@happier-dev/plugin-sdk/fs';
import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';
import { readSliceFinding, readSliceRun, readSliceSelection, type SliceFindingEvidence } from './state.js';

export type ClawpatchReviewResult = Readonly<{
  status: 'completed' | 'partial' | 'failed';
  nativeRunId: string | null;
  findings: readonly ReviewFinding[];
  findingEvidence: readonly SliceFindingEvidence[];
  errors: readonly Readonly<{ message: string; code: string | null }>[];
}>;

export type RunClawpatchReviewInput = Readonly<{
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
  /** Secret-free scalar projection of the native Codex owner's admitted config. */
  codexConfig?: Readonly<Record<string, string | number | boolean | null>>;
  signal: AbortSignal;
  /** Report cleanup separately so it cannot replace the review result. */
  onCleanupFailure?: () => void;
}>;

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('clawpatch cancelled', 'AbortError');
}

function succeeded(result: PluginProcessResult): boolean {
  return result.termination.requestedBy.kind === 'none'
    && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
}

function decode(result: PluginProcessResult): unknown {
  if (result.stdoutTruncated) throw new Error('Native clawpatch result is incomplete');
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
export async function runClawpatchReview(input: RunClawpatchReviewInput): Promise<ClawpatchReviewResult> {
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
        try { await child.dispose(); }
        catch { input.onCleanupFailure?.(); }
      }
    } else result = await input.exec.run(request, options);
    checkCancellation(input.signal);
    if (result.termination.requestedBy.kind === 'abort') throw new DOMException('clawpatch cancelled', 'AbortError');
    return result;
  };
  if (!await exists(join(directory, 'project.json'))) {
    if (!succeeded(await invoke(['init']))) throw new Error('Native slice initialization failed');
  }
  const selection = createSecureTempDirectorySync({ prefix: 'review-clawpatch-selection' });
  try {
    if (input.codexConfig) {
      // Init owns native defaults. Preserve those settings and override only the
      // admitted route in a trusted explicit file; never persist credentials.
      const config: Record<string, unknown> & { provider: Readonly<Record<string, unknown>> } = JSON.parse(
        await readFile(join(directory, 'config.json'), 'utf8'));
      const configPath = join(selection.path, 'config.json');
      await writeFile(configPath, JSON.stringify({ ...config, provider: { ...config.provider, codexConfig: input.codexConfig } }));
      common.unshift('--config', configPath);
    }
    if (!succeeded(await invoke(['map', ...provider]))) throw new Error('Native slice mapping failed');
    const names = (await readdir(join(directory, 'features'))).filter(name => name.endsWith('.json')).sort();
    const activeIds = (await Promise.all(names.map(async name => readSliceSelection(JSON.parse(
      await readFile(join(directory, 'features', name), 'utf8')))))).filter(item => item.status !== 'skipped').map(item => item.featureId);
    const featureIds = input.featureIds ?? activeIds;
    if (featureIds.length === 0) return { status: 'completed', nativeRunId: null, findings: [], findingEvidence: [], errors: [] };
    const selectionPath = join(selection.path, 'slices.txt');
    await writeFile(selectionPath, featureIds.join('\n') + '\n');
    const promptPath = join(selection.path, 'instructions.txt');
    if (input.instructions) await writeFile(promptPath, input.instructions);
    const result = await invoke(['review', '--feature-list', selectionPath,
      ...(input.instructions ? ['--prompt-file', promptPath] : []), ...provider]);
    // A failed native review still writes its run and full findings. Its start
    // diagnostic identifies that run; never discover it by scanning old history.
    const response = succeeded(result) ? decode(result) : null;
    const runId = response && typeof response === 'object' && 'run' in response && typeof response.run === 'string'
      ? response.run
      : !result.stderrTruncated ? /(?:^|\n)clawpatch review start run=([A-Za-z0-9_-]+)(?:\s|$)/u.exec(Buffer.from(result.stderr).toString('utf8'))?.[1] : undefined;
    if (!runId) throw new Error('Native clawpatch review did not identify its run');
    const run = readSliceRun(JSON.parse(await readFile(join(directory, 'runs', `${safeRecordId(runId)}.json`), 'utf8')), runId);
    const mapped = await Promise.all(run.findingIds.map(async (id, index) => readSliceFinding(JSON.parse(
      await readFile(join(directory, 'findings', `${safeRecordId(id)}.json`), 'utf8')), id, runId, index)));
    return { status: !succeeded(result) || run.status !== 'completed' ? 'failed' : run.errors.length ? 'partial' : 'completed',
      nativeRunId: runId, findings: mapped.map(item => item.finding), findingEvidence: mapped.map(item => item.evidence), errors: run.errors };
  } finally {
    try { selection.cleanup(); }
    catch { input.onCleanupFailure?.(); }
  }
}

function safeRecordId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error('Invalid native slice record identity');
  return id;
}
