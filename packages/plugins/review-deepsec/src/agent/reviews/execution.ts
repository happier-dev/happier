import { randomUUID } from 'node:crypto';

import type {
  AgentCliReadinessResultV1,
  CreateExecutionRunBackendParamsV1,
  ExecutionRunHostBackendV1,
  ExecutionRunHostMessageV1,
  PluginContextV1,
  PluginReviewCommentsServiceV1,
} from '@happier-dev/plugin-sdk';
import {
  createSingleShotExecutionRunHostBackend,
  REVIEW_SCM_SCOPE_INPUT_KEY,
  ReviewScmScopeV1Schema,
  type ReviewScmScopeV1,
} from '@happier-dev/plugin-sdk';
import {
  ReviewStartInputSchema,
  type ReviewFindingsV2,
} from '@happier-dev/protocol';

import {
  mapDeepSecReviewComments,
} from './comments.js';
import { parseDeepSecCommentOutMarkdown } from './commentOut.js';
import type { DeepSecReviewMode } from './command.js';
import type { DeepSecCostWarningInput } from './costWarning.js';
import { normalizeDeepSecFindings } from './findings.js';
import { runDeepSecReview, type DeepSecReviewRunResult } from './run.js';
import { createDeepSecTempFiles } from './tempFiles.js';

type DeepSecStartContext = Readonly<{
  intentInput?: unknown;
}>;

type NormalizedDeepSecStart = Readonly<{
  mode: DeepSecReviewMode;
  selectedFiles?: readonly string[];
  scmScope?: ReviewScmScopeV1 | null;
  confirmedCostWarning: boolean;
  preferredExecutablePath?: string | null;
  agentCli?: 'claude' | 'codex' | 'both' | null;
  cost?: Omit<DeepSecCostWarningInput, 'mode'>;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
}>;

type DeepSecAgentCli = 'claude' | 'codex' | 'both';

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

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

function readAgentCli(value: unknown): 'claude' | 'codex' | 'both' | null {
  return value === 'claude' || value === 'codex' || value === 'both' ? value : null;
}

function readCwd(params: CreateExecutionRunBackendParamsV1): string {
  return readString(params.cwd) ?? readString(params.directory) ?? '.';
}

function readRunId(params: CreateExecutionRunBackendParamsV1): string {
  return readString(params.runId) ?? `deepsec_${randomUUID()}`;
}

function readStartContext(params: CreateExecutionRunBackendParamsV1): DeepSecStartContext | null {
  const start = readRecord((params as unknown as { start?: unknown }).start);
  if (!start) return null;
  return { intentInput: start.intentInput };
}

function readDeepSecEngineConfig(intentRecord: Record<string, unknown>): Record<string, unknown> {
  const engines = readRecord(intentRecord.engines);
  return readRecord(engines?.deepsec) ?? {};
}

function readScmReviewScope(intentRecord: Record<string, unknown>): ReviewScmScopeV1 | null {
  const parsed = ReviewScmScopeV1Schema.safeParse(intentRecord[REVIEW_SCM_SCOPE_INPUT_KEY]);
  return parsed.success ? parsed.data : null;
}

function readScmReviewScopeSelectedFiles(scope: ReviewScmScopeV1 | null): readonly string[] | undefined {
  if (!scope || scope.status !== 'supported') return undefined;
  return scope.selectedPaths.length > 0 ? scope.selectedPaths : undefined;
}

function readMode(engineConfig: Record<string, unknown>, intentRecord: Record<string, unknown>): DeepSecReviewMode {
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

  const profileId = readString(engineConfig.profileId) ?? readString(intentRecord.profileId);
  return profileId === 'deepsec.securityReview' ? 'repository_security_audit' : 'current_diff';
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
}>): NormalizedDeepSecStart {
  const reviewInput = normalizeReviewStartInput(params);
  const scmScope = readScmReviewScope(reviewInput);
  const engineConfig = readDeepSecEngineConfig(reviewInput);
  const selectedFiles =
    readStringArray(engineConfig.selectedFiles)
    ?? readStringArray(reviewInput.selectedFiles)
    ?? readScmReviewScopeSelectedFiles(scmScope);
  const cost = readCost(engineConfig, reviewInput);
  const confirmedCostWarning =
    readBoolean(engineConfig.confirmedCostWarning)
    ?? readBoolean(reviewInput.confirmedCostWarning)
    ?? false;

  return {
    mode: readMode(engineConfig, reviewInput),
    ...(selectedFiles ? { selectedFiles } : {}),
    ...(scmScope ? { scmScope } : {}),
    confirmedCostWarning,
    preferredExecutablePath:
      readString(engineConfig.preferredExecutablePath)
      ?? readString(engineConfig.executablePath)
      ?? null,
    agentCli: readAgentCli(engineConfig.agentCli) ?? readAgentCli(reviewInput.agentCli) ?? null,
    ...(cost ? { cost } : {}),
    ...(readString(reviewInput.projectId) ? { projectId: readString(reviewInput.projectId) } : {}),
    ...(readString(reviewInput.workspaceId) ? { workspaceId: readString(reviewInput.workspaceId) } : {}),
    ...(readString(reviewInput.sessionId) ? { sessionId: readString(reviewInput.sessionId) } : {}),
  };
}

function assertSupportedScmReviewScope(start: NormalizedDeepSecStart): void {
  if (start.mode === 'repository_security_audit') return;
  const scope = start.scmScope ?? null;
  if (!scope) {
    throw new Error('DeepSec review requires host-resolved SCM scope facts.');
  }
  if (scope.status !== 'supported') {
    throw new Error(scope.diagnostics[0]?.message || 'DeepSec review requires a source-control repository in the current session scope.');
  }
  if (scope.scmMode !== '.git') {
    throw new Error('DeepSec review requires a git worktree in the current session scope.');
  }
}

function createModelOutputMessage(fullText: string): ExecutionRunHostMessageV1 {
  return { type: 'model-output', fullText } as unknown as ExecutionRunHostMessageV1;
}

function readReviewComments(ctx: PluginContextV1): Pick<PluginReviewCommentsServiceV1, 'create' | 'resolveSnapshot'> | null {
  const comments = (ctx as Partial<Pick<PluginContextV1, 'reviews'>>).reviews?.comments;
  return typeof comments?.create === 'function' && typeof comments.resolveSnapshot === 'function'
    ? comments
    : null;
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
    generatedAtMs: Date.now(),
    ...(readiness ? { readiness } : {}),
    ...(selectedScopeDiagnostics ? { diagnostics: selectedScopeDiagnostics } : {}),
    ...(params.runResult.status === 'partial'
      ? { limits: { findingsTruncated: false, patchesTruncated: false } }
      : {}),
  };
  return JSON.stringify(output);
}

function readGatewayKeyAvailability(ctx: PluginContextV1): boolean {
  const env = (ctx as Partial<Pick<PluginContextV1, 'env'>>).env;
  if (!env) return true;
  return Boolean(env.get('AI_GATEWAY_API_KEY')?.trim());
}

function resolveAgentCliCandidates(agentCli: DeepSecAgentCli | null): readonly string[] {
  if (agentCli === 'claude') return Object.freeze(['claude']);
  if (agentCli === 'codex') return Object.freeze(['codex']);
  return Object.freeze(['claude', 'codex']);
}

function readReadyAgentCli(readiness: AgentCliReadinessResultV1): DeepSecAgentCli | null {
  const readyAgentIds = new Set(readiness.launchable.map((entry) => entry.agentId));
  const hasClaude = readyAgentIds.has('claude');
  const hasCodex = readyAgentIds.has('codex');
  if (hasClaude && hasCodex) return 'both';
  if (hasClaude) return 'claude';
  if (hasCodex) return 'codex';
  return null;
}

async function resolveAgentCliReadiness(params: Readonly<{
  ctx: PluginContextV1;
  configuredAgentCli: DeepSecAgentCli | null;
  cwd: string;
  projectId?: string;
  workspaceId?: string;
}>): Promise<DeepSecAgentCli | null> {
  const readiness = await params.ctx.agents.cli.checkReadiness({
    candidates: resolveAgentCliCandidates(params.configuredAgentCli),
    requirement: 'any',
    cwd: params.cwd,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
  });
  return readReadyAgentCli(readiness);
}

export function createDeepSecExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
  const cwd = readCwd(params.executionRunParams);
  const runId = readRunId(params.executionRunParams);
  const start = readStartContext(params.executionRunParams);

  return createSingleShotExecutionRunHostBackend({
    backendId: 'deepsec',
    sessionIdPrefix: 'deepsec',
    signal: params.executionRunParams.signal,
    busyMessage: 'DeepSec backend is busy',
    resumeUnsupportedMessage: 'DeepSec execution runs do not support session resume',
    replayUnsupportedMessage: 'DeepSec execution runs do not support replay capture',
    run: async ({ prompt, emit, signal }) => {
      const startInput = normalizeDeepSecStart({
        intentInput: start?.intentInput ?? {},
        fallbackInstructions: prompt,
      });
      assertSupportedScmReviewScope(startInput);
      const agentCli = await resolveAgentCliReadiness({
        ctx: params.ctx,
        configuredAgentCli: startInput.agentCli ?? null,
        cwd,
        projectId: startInput.projectId,
        workspaceId: startInput.workspaceId,
      });
      const runResult = await runDeepSecReview({
        cwd,
        mode: startInput.mode,
        selectedFiles: startInput.selectedFiles,
        confirmedCostWarning: startInput.confirmedCostWarning,
        cost: startInput.cost,
        preferredExecutablePath: startInput.preferredExecutablePath,
        exec: params.ctx.exec,
        tempFiles: await createDeepSecTempFiles(params.ctx.fs),
        readiness: {
          agentCli,
          hasGatewayKey: readGatewayKeyAvailability(params.ctx),
        },
        signal,
      });
      if (runResult.status === 'requires_confirmation') {
        emit(createModelOutputMessage(JSON.stringify({
          runRef: {
            runId,
            callId: `deepsec:${runId}`,
            backendId: 'deepsec',
          },
          summary: 'DeepSec review requires confirmation.',
          overviewMarkdown: 'DeepSec review requires confirmation before launch.',
          findings: [],
          questions: [],
          assumptions: [],
          generatedAtMs: Date.now(),
          warning: runResult.warning,
        })));
        return { messages: [] };
      }

      const entries = parseDeepSecCommentOutMarkdown(runResult.commentOutMarkdown);
      const findings = normalizeDeepSecFindings(entries);
      const comments = readReviewComments(params.ctx);
      if (comments && startInput.projectId) {
        await mapDeepSecReviewComments({
          projectId: startInput.projectId,
          workspaceId: startInput.workspaceId,
          sessionId: startInput.sessionId,
          runId,
          entries,
          comments,
        });
      }
      if (runResult.status === 'failed') {
        emit(createModelOutputMessage(createOutput({ runId, findings, runResult })));
        throw new Error(`DeepSec exited with code ${runResult.result.exitCode ?? 'null'}`);
      }
      return {
        messages: [createModelOutputMessage(createOutput({ runId, findings, runResult }))],
      };
    },
  });
}
