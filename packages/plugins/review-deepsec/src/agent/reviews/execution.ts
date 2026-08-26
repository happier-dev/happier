import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeFactory,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  REVIEW_SCM_SCOPE_INPUT_KEY,
  ReviewScmScopeV1Schema,
  type ReviewScmScopeV1,
  ReviewStartInputSchema,
  type ReviewFindingsV2,
} from '@happier-dev/plugin-sdk/reviews';

import { parseDeepSecCommentOutMarkdown } from './commentOut.js';
import type { DeepSecReviewMode } from './command.js';
import { resolveDeepSecProfileMode } from './profileMode.js';
import type { DeepSecCostWarningInput } from './costWarning.js';
import { normalizeDeepSecFindings } from './findings.js';
import {
  runDeepSecReview,
  type DeepSecReviewRunResult,
  type DeepSecScopedPathListDiagnostic,
} from './run.js';
import { createDeepSecTempFiles } from './tempFiles.js';

type NormalizedDeepSecStart = Readonly<{
  mode: DeepSecReviewMode;
  scmScope?: ReviewScmScopeV1 | null;
  confirmedCostWarning: boolean;
  preferredExecutablePath?: string | null;
  agentCli?: DeepSecAgentCli | null;
  cost?: Omit<DeepSecCostWarningInput, 'mode'>;
  projectId?: string;
  workspaceId?: string;
}>;

type DeepSecAgentCli = 'claude' | 'codex' | 'both';

type EventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readAgentCli(value: unknown): DeepSecAgentCli | null {
  return value === 'claude' || value === 'codex' || value === 'both' ? value : null;
}

function readDeepSecEngineConfig(intentRecord: Record<string, unknown>): Record<string, unknown> {
  const engines = readRecord(intentRecord.engines);
  return readRecord(engines?.deepsec) ?? {};
}

function readScmReviewScope(intentRecord: Record<string, unknown>): ReviewScmScopeV1 | null {
  const parsed = ReviewScmScopeV1Schema.safeParse(intentRecord[REVIEW_SCM_SCOPE_INPUT_KEY]);
  return parsed.success ? parsed.data : null;
}

function readMode(
  engineConfig: Record<string, unknown>,
  intentRecord: Record<string, unknown>,
  profileId: string,
): DeepSecReviewMode {
  const mode = readString(engineConfig.mode) ?? readString(intentRecord.mode);
  if (
    mode === 'repository_security_audit'
    || mode === 'current_diff'
    || mode === 'staged'
    || mode === 'working_tree'
    || mode === 'selected_files'
  ) {
    return mode;
  }
  return resolveDeepSecProfileMode(
    readString(engineConfig.profileId)
    ?? readString(intentRecord.profileId)
    ?? profileId,
  );
}

function readCost(
  engineConfig: Record<string, unknown>,
  intentRecord: Record<string, unknown>,
): Omit<DeepSecCostWarningInput, 'mode'> | undefined {
  const costRecord = readRecord(engineConfig.cost) ?? readRecord(intentRecord.cost);
  if (!costRecord) return undefined;
  return {
    changedFileCount: readNumber(costRecord.changedFileCount),
    diffBytes: readNumber(costRecord.diffBytes),
    selectedFileCount: readNumber(costRecord.selectedFileCount),
    selectedBytes: readNumber(costRecord.selectedBytes),
    largestSelectedFileBytes: readNumber(costRecord.largestSelectedFileBytes),
  };
}

function normalizeReviewStartInput(params: Readonly<{
  intentInput: unknown;
  fallbackInstructions: string;
}>): Record<string, unknown> {
  const parsed = ReviewStartInputSchema.safeParse(params.intentInput ?? {});
  if (parsed.success) return parsed.data as Record<string, unknown>;

  const rawIntent = readRecord(params.intentInput) ?? {};
  const instructions = (readString(rawIntent.instructions) ?? params.fallbackInstructions.trim()) || 'Run DeepSec review.';
  return ReviewStartInputSchema.parse({
    ...rawIntent,
    engineIds: ['deepsec'],
    instructions,
  }) as Record<string, unknown>;
}

function normalizeDeepSecStart(params: Readonly<{
  intentInput: unknown;
  fallbackInstructions: string;
  profileId: string;
}>): NormalizedDeepSecStart {
  const reviewInput = normalizeReviewStartInput(params);
  const scmScope = readScmReviewScope(reviewInput);
  const engineConfig = readDeepSecEngineConfig(reviewInput);
  const mode = readMode(engineConfig, reviewInput, params.profileId);
  const cost = readCost(engineConfig, reviewInput);

  return {
    mode,
    ...(scmScope ? { scmScope } : {}),
    confirmedCostWarning:
      readBoolean(engineConfig.confirmedCostWarning)
      ?? readBoolean(reviewInput.confirmedCostWarning)
      ?? false,
    preferredExecutablePath:
      readString(engineConfig.preferredExecutablePath)
      ?? readString(engineConfig.executablePath)
      ?? null,
    agentCli: readAgentCli(engineConfig.agentCli) ?? readAgentCli(reviewInput.agentCli) ?? null,
    ...(cost ? { cost } : {}),
    ...(readString(reviewInput.projectId) ? { projectId: readString(reviewInput.projectId) } : {}),
    ...(readString(reviewInput.workspaceId) ? { workspaceId: readString(reviewInput.workspaceId) } : {}),
  };
}

type SelectedScopeResolution =
  | Readonly<{ status: 'ready'; paths: readonly string[] }>
  | Readonly<{ status: 'failed'; diagnostics: readonly DeepSecScopedPathListDiagnostic[] }>;

function selectedScopeUnavailable(path?: string): SelectedScopeResolution {
  return {
    status: 'failed',
    diagnostics: [{
      code: path ? 'scope_path_unavailable' : 'scope_unavailable',
      severity: 'error',
      messageKey: 'plugins.fs.scopedPathList.scopeUnavailable',
      ...(path ? { path } : {}),
    }],
  };
}

function selectedScopePathEscape(path: string): SelectedScopeResolution {
  return {
    status: 'failed',
    diagnostics: [{
      code: 'path_escape',
      severity: 'error',
      messageKey: 'plugins.fs.scopedPathList.pathEscape',
      path,
    }],
  };
}

function isSafeScopeRelativePath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized || isAbsolute(path) || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return !normalized.split('/').some((segment) => segment === '..');
}

function isOutsideWorkspaceRelativePath(path: string): boolean {
  return !path
    || isAbsolute(path)
    || path === '..'
    || path.startsWith(`..${sep}`);
}

/**
 * SCM owns selected paths relative to its worktree; the plugin runtime owns
 * the admitted execution cwd. Bridge those two coordinate systems once, then
 * ask the host filesystem boundary to prove each resolved path remains inside
 * that cwd (including after symlink resolution).
 */
async function resolveSelectedScopePaths(params: Readonly<{
  context: AgentRuntimeContext;
  cwd: string;
  scope: ReviewScmScopeV1 | null | undefined;
  signal: AbortSignal;
}>): Promise<SelectedScopeResolution> {
  const scope = params.scope ?? null;
  const worktreeRoot = typeof scope?.worktreeRoot === 'string' ? scope.worktreeRoot.trim() : '';
  const cwd = params.cwd.trim();
  if (!scope || !worktreeRoot || !cwd || !isAbsolute(worktreeRoot) || !isAbsolute(cwd)) {
    return selectedScopeUnavailable();
  }
  if (params.context.services.availability('fs').status !== 'available') {
    return selectedScopeUnavailable();
  }
  if (scope.selectedPaths.length === 0) return selectedScopeUnavailable();

  const paths: string[] = [];
  for (const selectedPath of scope.selectedPaths) {
    if (params.signal.aborted) throw params.signal.reason;
    if (!isSafeScopeRelativePath(selectedPath)) return selectedScopePathEscape(selectedPath);

    const absolutePath = resolve(worktreeRoot, selectedPath);
    const workspaceRelativePath = relative(cwd, absolutePath);
    if (isOutsideWorkspaceRelativePath(workspaceRelativePath)) {
      return selectedScopePathEscape(selectedPath);
    }
    const normalizedPath = workspaceRelativePath.replace(/\\/g, '/');
    try {
      const stat = await params.context.services.fs.stat({
        root: 'workspace',
        relativePath: normalizedPath,
      }, { signal: params.signal });
      if (params.signal.aborted) throw params.signal.reason;
      if (stat.kind !== 'file') return selectedScopeUnavailable(selectedPath);
    } catch {
      if (params.signal.aborted) throw params.signal.reason;
      // The host's scoped filesystem service resolves real paths before its
      // containment check, so this also refuses symlink escapes without a
      // plugin-owned filesystem policy.
      return selectedScopeUnavailable(selectedPath);
    }
    paths.push(normalizedPath);
  }

  return { status: 'ready', paths: Object.freeze(paths) };
}

function assertSupportedScmReviewScope(start: NormalizedDeepSecStart): void {
  if (start.mode === 'repository_security_audit') return;
  const scope = start.scmScope ?? null;
  if (!scope) throw new Error('DeepSec review requires host-resolved SCM scope facts.');
  if (scope.status !== 'supported') {
    throw new Error(scope.diagnostics[0]?.message || 'DeepSec review requires a source-control repository in the current session scope.');
  }
  if (scope.scmMode !== '.git') {
    throw new Error('DeepSec review requires a git worktree in the current session scope.');
  }
}

function createOutput(params: Readonly<{
  runId: string;
  findings: ReturnType<typeof normalizeDeepSecFindings>;
  runResult: DeepSecReviewRunResult;
}>): string {
  const count = params.findings.length;
  const readiness = params.runResult.status === 'readiness_failed'
    ? params.runResult.readiness
    : undefined;
  const selectedScopeDiagnostics = params.runResult.status === 'selected_scope_failed'
    ? params.runResult.diagnostics
    : undefined;
  const output: ReviewFindingsV2 = {
    runRef: {
      runId: params.runId,
      callId: `deepsec:${params.runId}`,
      backendId: 'deepsec',
    },
    summary: readiness
      ? 'DeepSec review readiness failed.'
      : selectedScopeDiagnostics
        ? 'DeepSec selected-file scope validation failed.'
        : `DeepSec review: ${count} finding(s).`,
    overviewMarkdown: readiness
      ? `DeepSec cannot start until these prerequisites are available: ${readiness.missing.join(', ')}.`
      : selectedScopeDiagnostics
        ? 'DeepSec could not validate the selected file scope, so no scan was launched.'
        : count > 0
          ? `DeepSec reported ${count} security finding(s).`
          : 'DeepSec review: no findings.',
    findings: [...params.findings],
    questions: [],
    assumptions: [],
    proposedComments: params.findings.flatMap((finding) => {
      const filePath = finding.filePath?.trim();
      const body = finding.summary.trim();
      if (!filePath || !body) return [];
      const anchor = typeof finding.startLine === 'number'
        ? typeof finding.endLine === 'number' && finding.endLine > finding.startLine
          ? { kind: 'range' as const, filePath, startLine: finding.startLine, endLine: finding.endLine }
          : { kind: 'line' as const, filePath, line: finding.startLine }
        : { kind: 'file' as const, filePath };
      const severity = finding.severity === 'blocker'
        ? 'critical' as const
        : finding.severity === 'high'
          ? 'error' as const
          : finding.severity === 'medium'
            ? 'warning' as const
            : 'info' as const;
      return [{
        findingId: finding.id,
        body,
        anchor,
        severity,
        taxonomyIds: [`deepsec.${finding.category}`],
        tags: ['deepsec'],
      }];
    }),
    generatedAtMs: Date.now(),
    ...(readiness ? { readiness } : {}),
    ...(selectedScopeDiagnostics ? { diagnostics: selectedScopeDiagnostics } : {}),
    ...(params.runResult.status === 'partial'
      ? { limits: { findingsTruncated: false, patchesTruncated: false } }
      : {}),
  };
  return JSON.stringify(output);
}

function resolveAgentCliCandidates(agentCli: DeepSecAgentCli | null): readonly string[] {
  if (agentCli === 'claude') return Object.freeze(['claude']);
  if (agentCli === 'codex') return Object.freeze(['codex']);
  return Object.freeze(['claude', 'codex']);
}

function readReadyAgentCli(readiness: Readonly<{ launchable: readonly Readonly<{ agentId: string }>[] }>): DeepSecAgentCli | null {
  const readyAgentIds = new Set(readiness.launchable.map((entry) => entry.agentId));
  const hasClaude = readyAgentIds.has('claude');
  const hasCodex = readyAgentIds.has('codex');
  if (hasClaude && hasCodex) return 'both';
  if (hasClaude) return 'claude';
  if (hasCodex) return 'codex';
  return null;
}

async function resolveAgentCliReadiness(params: Readonly<{
  context: AgentRuntimeContext;
  configuredAgentCli: DeepSecAgentCli | null;
  cwd: string;
  projectId?: string;
  workspaceId?: string;
  signal: AbortSignal;
}>): Promise<DeepSecAgentCli | null> {
  const readiness = await params.context.services.exec.agentCli.checkReadiness({
    candidates: resolveAgentCliCandidates(params.configuredAgentCli),
    requirement: 'any',
    cwd: params.cwd,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    signal: params.signal,
  });
  return readReadyAgentCli(readiness);
}

function readGatewayEnvironment(request: AgentExecutionRunOpenRequest): Readonly<{
  environment: Readonly<Record<string, string>> | undefined;
  hasGatewayKey: boolean;
}> {
  const launchEnvironment = request.launchEnvironment;
  if (!launchEnvironment) return { environment: undefined, hasGatewayKey: false };
  const unset = new Set(launchEnvironment.unset.map((key) => key.toUpperCase()));
  if (unset.has('AI_GATEWAY_API_KEY')) return { environment: undefined, hasGatewayKey: false };
  const gatewayEntry = Object.entries(launchEnvironment.values)
    .find(([key]) => key.toUpperCase() === 'AI_GATEWAY_API_KEY');
  const value = gatewayEntry?.[1]?.trim();
  return value
    ? { environment: Object.freeze({ AI_GATEWAY_API_KEY: gatewayEntry?.[1] ?? value }), hasGatewayKey: true }
    : { environment: undefined, hasGatewayKey: false };
}

function readFailureCode(result: Extract<DeepSecReviewRunResult, { result: unknown }>['result']): string {
  const observed = result.termination.observed;
  return observed.kind === 'exit' ? String(observed.exitCode) : observed.kind === 'signal' ? observed.signal : 'unknown';
}

function createRuntime(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
  context: AgentRuntimeContext,
): AgentExecutionRunRuntime {
  const abortController = new AbortController();
  const signal = AbortSignal.any([context.signal, abortController.signal]);
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let terminal = false;
  let disposed = false;

  function emit(event: EventInput): void {
    if (terminal) return;
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      runId: request.runId,
      emittedAtMs: Date.now(),
    }) as AgentExecutionRunEvent;
    history.push(published);
    for (const listener of listeners) listener(published);
    terminal = event.kind === 'run-complete' || event.kind === 'run-failed' || event.kind === 'run-cancelled';
  }

  async function execute(): Promise<void> {
    emit({ kind: 'run-start' });
    try {
      if (context.services.availability('exec').status !== 'available') {
        throw new Error('DeepSec execution requires the host process service');
      }
      const startInput = normalizeDeepSecStart({
        intentInput: request.input.structuredInput ?? {},
        fallbackInstructions: request.input.text,
        profileId: `${request.profile.pluginId}/${request.profile.localId}`,
      });
      assertSupportedScmReviewScope(startInput);
      const selectedScope = startInput.mode === 'selected_files'
        ? await resolveSelectedScopePaths({
          context,
          cwd: request.cwd,
          scope: startInput.scmScope,
          signal,
        })
        : null;
      if (selectedScope?.status === 'failed') {
        const runResult: DeepSecReviewRunResult = {
          status: 'selected_scope_failed',
          diagnostics: selectedScope.diagnostics,
          commentOutMarkdown: '',
        };
        emit({
          kind: 'output-delta',
          channel: 'assistant',
          text: createOutput({ runId: request.runId, findings: normalizeDeepSecFindings([]), runResult }),
        });
        emit({ kind: 'run-complete' });
        return;
      }
      const agentCli = await resolveAgentCliReadiness({
        context,
        configuredAgentCli: startInput.agentCli ?? null,
        cwd: request.cwd,
        projectId: startInput.projectId,
        workspaceId: startInput.workspaceId,
        signal,
      });
      const gateway = readGatewayEnvironment(request);
      const runResult = await runDeepSecReview({
        cwd: request.cwd,
        mode: startInput.mode,
        selectedFiles: selectedScope?.paths,
        confirmedCostWarning: startInput.confirmedCostWarning,
        cost: startInput.cost,
        preferredExecutablePath: startInput.preferredExecutablePath,
        exec: context.services.exec,
        tempFiles: await createDeepSecTempFiles(),
        environment: gateway.environment,
        readiness: {
          agentCli,
          hasGatewayKey: gateway.hasGatewayKey,
        },
        signal,
      });
      if (signal.aborted) {
        emit({ kind: 'run-cancelled' });
        return;
      }
      if (runResult.status === 'requires_confirmation') {
        emit({
          kind: 'output-delta',
          channel: 'assistant',
          text: JSON.stringify({
            runRef: { runId: request.runId, callId: `deepsec:${request.runId}` },
            summary: 'DeepSec review requires confirmation.',
            overviewMarkdown: 'DeepSec review requires confirmation before launch.',
            findings: [],
            questions: [],
            assumptions: [],
            generatedAtMs: Date.now(),
            warning: runResult.warning,
          }),
        });
        emit({ kind: 'run-complete' });
        return;
      }

      const findings = normalizeDeepSecFindings(parseDeepSecCommentOutMarkdown(runResult.commentOutMarkdown));
      emit({ kind: 'output-delta', channel: 'assistant', text: createOutput({ runId: request.runId, findings, runResult }) });
      if (runResult.status === 'failed') {
        throw new Error(`DeepSec exited with code ${readFailureCode(runResult.result)}`);
      }
      emit({ kind: 'run-complete' });
    } catch (error) {
      if (signal.aborted) {
        emit({ kind: 'run-cancelled' });
        return;
      }
      emit({
        kind: 'run-failed',
        diagnostic: {
          code: 'deepsec_execution_failed',
          severity: 'error',
          message: error instanceof Error ? error.message : 'DeepSec execution failed',
        },
      });
    }
  }

  const execution = execute();
  void execution.catch(() => undefined);
  return Object.freeze({
    async send() {
      return {
        status: 'unsupported' as const,
        diagnostic: {
          code: 'deepsec_follow_up_unsupported',
          severity: 'error' as const,
          message: 'DeepSec execution runs are single-shot',
        },
      };
    },
    async stop() {
      if (terminal) return { status: 'notRunning' as const };
      abortController.abort(new Error('DeepSec execution run stopped'));
      return { status: 'requested' as const };
    },
    watch(listener: (event: AgentExecutionRunEvent) => void) {
      for (const event of history) listener(event);
      if (!terminal) listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      abortController.abort(new Error('DeepSec execution run disposed'));
      listeners.clear();
      await execution;
    },
  });
}

export function createDeepSecExecutionRunFactory(): AgentExecutionRunRuntimeFactory {
  return Object.freeze({
    open(request: AgentExecutionRunOpenRequest, context: AgentRuntimeContext) {
      if (request.kind !== 'create') throw new Error('DeepSec execution runs support create only');
      return createRuntime(request, context);
    },
  });
}
