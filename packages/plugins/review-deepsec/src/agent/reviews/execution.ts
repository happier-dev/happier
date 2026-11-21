import {
  createFiniteExecutionRunHostRuntime,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime,
  type AgentExecutionRunRuntimeFactory,
  type AgentRuntimeContext,
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
import { isDeepSecReviewMode, isDeepSecThinkingLevel, type DeepSecReviewMode, type DeepSecThinkingLevel } from './command.js';
import { DEEPSEC_AGENT_CLIS } from './profile.js';
import { resolveDeepSecProfileMode } from './profileMode.js';
import { normalizeDeepSecFindings } from './findings.js';
import {
  runDeepSecReview,
  type DeepSecReviewRunResult,
  type DeepSecScopedPathListDiagnostic,
} from './run.js';
import { createDeepSecTempFiles } from './tempFiles.js';
import { buildDeepSecLaunchEnvironment, readDeepSecProviderLaunch, type DeepSecProviderRoute } from '../providerBinding.js';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { DEEPSEC_CLAUDE_ACCOUNT_PURPOSE, prepareDeepSecClaudeAccount } from '../connectedAccount.js';
import { preflightDeepSecReviewScope } from './scopePreflight.js';

type NormalizedDeepSecStart = Readonly<{
  mode: DeepSecReviewMode;
  scmScope?: ReviewScmScopeV1 | null;
  confirmedCostWarning: boolean;
  preferredExecutablePath?: string | null;
  agentCli?: DeepSecAgentCli | null;
  thinkingLevel?: DeepSecThinkingLevel;
  projectId?: string;
  workspaceId?: string;
}>;

type DeepSecAgentCli = typeof DEEPSEC_AGENT_CLIS[number];

class DeepSecProviderHarnessMismatchError extends Error {}

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

function readAgentCli(value: unknown): DeepSecAgentCli | null {
  return DEEPSEC_AGENT_CLIS.find(agentCli => agentCli === value) ?? null;
}

function readDeepSecEngineConfig(intentRecord: Record<string, unknown>, agentId: string): Record<string, unknown> {
  const engines = readRecord(intentRecord.engines);
  return readRecord(engines?.[agentId]) ?? {};
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
  if (isDeepSecReviewMode(mode)) return mode;
  return resolveDeepSecProfileMode(
    readString(engineConfig.profileId)
    ?? readString(intentRecord.profileId)
    ?? profileId,
  );
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
    reviewers: [{ kind: 'engine', engineId: 'deepsec' }],
    instructions,
  }) as Record<string, unknown>;
}

function normalizeDeepSecStart(params: Readonly<{
  intentInput: unknown;
  fallbackInstructions: string;
  profileId: string;
  agentId: string;
}>): NormalizedDeepSecStart {
  const reviewInput = normalizeReviewStartInput(params);
  const scmScope = readScmReviewScope(reviewInput);
  const engineConfig = readDeepSecEngineConfig(reviewInput, params.agentId);
  const mode = readMode(engineConfig, reviewInput, params.profileId);
  const thinkingLevel = engineConfig.thinkingLevel;
  if (thinkingLevel !== undefined && !isDeepSecThinkingLevel(thinkingLevel)) {
    throw new Error('The selected DeepSec thinking level is unsupported.');
  }

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
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
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

/**
 * SCM owns selected paths relative to its worktree; the plugin runtime owns
 * the admitted execution cwd. Bridge those two coordinate systems once, then
 * let the host filesystem boundary, the one containment decider, prove each
 * resolved path stays inside that cwd (traversal, absolute and symlink escapes).
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
    const relativePath = relative(cwd, resolve(worktreeRoot, selectedPath));
    // DeepSec treats every backslash as a separator. On POSIX it can instead
    // belong to the filename, so refuse that identity before portable fs access.
    if (sep !== '\\' && relativePath.includes('\\')) return selectedScopeUnavailable(selectedPath);
    const normalizedPath = relativePath.split(sep).join('/');
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
  const partialDiagnostics = params.runResult.status === 'partial'
    ? params.runResult.diagnostics
    : undefined;
  const failureDiagnostics = params.runResult.status === 'failed'
    ? [{
        code: 'deepsec_process_failed',
        severity: 'error' as const,
        messageKey: 'plugins.deepsec.runtime.failed',
        detail: (() => {
          const observed = params.runResult.result.termination.observed;
          if (observed.kind === 'exit') return { exitCode: observed.exitCode, signal: null };
          if (observed.kind === 'signal') return { exitCode: null, signal: observed.signal };
          return { exitCode: null, signal: null };
        })(),
      }]
    : undefined;
  const output: ReviewFindingsV2 = {
    runRef: {
      runId: params.runId,
      callId: `deepsec:${params.runId}`,
      backendId: 'deepsec',
    },
    reviewOutcome: params.runResult.status === 'completed' ? 'complete'
      : params.runResult.status === 'partial' ? 'partial' : 'failed',
    summary: readiness
      ? 'DeepSec review readiness failed.'
      : selectedScopeDiagnostics
        ? 'DeepSec selected-file scope validation failed.'
        : partialDiagnostics
          ? `DeepSec review partially completed with ${count} finding(s).`
          : `DeepSec review: ${count} finding(s).`,
    overviewMarkdown: readiness
      ? `DeepSec cannot start until these prerequisites are available: ${readiness.missing.join(', ')}.`
      : selectedScopeDiagnostics
        ? 'DeepSec could not validate the selected file scope, so no scan was launched.'
        : partialDiagnostics
          ? `DeepSec reported ${count} security finding(s) before processing stopped early.`
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
    ...(readiness
      ? { status: 'failed', error: { code: 'deepsec_readiness_failed' } }
      : selectedScopeDiagnostics
        ? { status: 'failed', error: { code: 'deepsec_scope_failed' } }
        : failureDiagnostics
          ? { status: 'failed', error: { code: 'deepsec_process_failed' } }
          : {}),
    ...(readiness ? { readiness } : {}),
    ...(selectedScopeDiagnostics
      ? { diagnostics: selectedScopeDiagnostics }
      : partialDiagnostics
        ? { diagnostics: partialDiagnostics }
        : failureDiagnostics
          ? { diagnostics: failureDiagnostics }
          : {}),
    ...(params.runResult.status === 'partial'
      ? { limits: { findingsTruncated: true, patchesTruncated: false } }
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

function readGatewayKey(request: AgentExecutionRunOpenRequest): string | null {
  const launchEnvironment = request.launchEnvironment;
  if (!launchEnvironment) return null;
  const unset = new Set(launchEnvironment.unset.map((key) => key.toUpperCase()));
  if (unset.has('AI_GATEWAY_API_KEY')) return null;
  const gatewayEntry = Object.entries(launchEnvironment.values)
    .find(([key]) => key.toUpperCase() === 'AI_GATEWAY_API_KEY');
  const value = gatewayEntry?.[1]?.trim();
  return value ? gatewayEntry?.[1] ?? value : null;
}

type DeepSecModelAccess = Readonly<{
  environment: Readonly<Record<string, string>>;
  agentCli: DeepSecAgentCli | null;
  provider?: DeepSecProviderRoute;
  claudeSubscription: boolean;
  gateway?: true;
  machineLogin?: true;
}>;

async function prepareDeepSecModelAccess(
  request: AgentExecutionRunOpenRequest,
  context: AgentRuntimeContext,
  agentCli: DeepSecAgentCli | null | undefined,
): Promise<DeepSecModelAccess> {
  if (request.providerBinding) {
    const provider = readDeepSecProviderLaunch(request.providerBinding, request.launchEnvironment);
    if (agentCli && agentCli !== provider.route.agent) {
      throw new DeepSecProviderHarnessMismatchError('The selected DeepSec Provider requires the Codex harness.');
    }
    return { environment: provider.environment, agentCli: provider.route.agent,
      provider: provider.route, claudeSubscription: false };
  }
  const accounts = context.services.connectedAccounts;
  const selection = await accounts.resolveSelection?.(DEEPSEC_CLAUDE_ACCOUNT_PURPOSE, { signal: context.signal });
  const binding = selection?.credentialSource === 'connectedAccount' ? selection.binding : null;
  if (binding) return { environment: await prepareDeepSecClaudeAccount(context, agentCli, binding),
    agentCli: 'claude', claudeSubscription: true };
  const gatewayKey = readGatewayKey(request);
  if (gatewayKey) return { environment: buildDeepSecLaunchEnvironment({ AI_GATEWAY_API_KEY: gatewayKey }),
    agentCli: agentCli ?? null, claudeSubscription: false, gateway: true };
  if (selection?.credentialSource === 'machineLogin') return {
    environment: buildDeepSecLaunchEnvironment(), agentCli: agentCli ?? null,
    claudeSubscription: false, machineLogin: true,
  };
  throw new PluginError({ code: 'deepsec_model_access_unavailable',
    message: 'Select a Provider or Connected Account for DeepSec model access.' });
}

function createRuntime(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
  context: AgentRuntimeContext,
): AgentExecutionRunRuntime {
  return createFiniteExecutionRunHostRuntime({
    request,
    signal: context.signal,
    unsupportedSendDiagnostic: {
      code: 'deepsec_follow_up_unsupported',
      severity: 'error',
      message: 'DeepSec execution runs are single-shot',
    },
    mapFailure(error) {
      return {
        code: isPluginError(error) ? error.code : error instanceof DeepSecProviderHarnessMismatchError
          ? 'deepsec_provider_harness_mismatch' : 'deepsec_execution_failed',
        severity: 'error',
        message: error instanceof Error ? error.message : 'DeepSec execution failed',
      };
    },
    async execute({ signal, emit }) {
      if (context.services.availability('exec').status !== 'available') {
        throw new Error('DeepSec execution requires the host process service');
      }
      const startInput = normalizeDeepSecStart({
        intentInput: request.input.structuredInput ?? {},
        fallbackInstructions: request.input.text,
        profileId: `${request.profile.pluginId}/${request.profile.localId}`,
        agentId: context.agent.id,
      });
      const mode = await preflightDeepSecReviewScope({ cwd: request.cwd, mode: startInput.mode,
        scope: startInput.scmScope, actions: context.services.actions, signal });
      const selectedScope = mode === 'selected_files' || mode === 'current_diff'
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
        return { status: 'failed', diagnostic: { code: 'deepsec_scope_failed', severity: 'error' } };
      }
      const modelAccess = await prepareDeepSecModelAccess(request, context, startInput.agentCli);
      const agentCli = await resolveAgentCliReadiness({
        context,
        configuredAgentCli: modelAccess.agentCli,
        cwd: request.cwd,
        projectId: startInput.projectId,
        workspaceId: startInput.workspaceId,
        signal,
      });
      const runResult = await runDeepSecReview({
        cwd: request.cwd,
        mode,
        selectedFiles: selectedScope?.paths,
        confirmedCostWarning: startInput.confirmedCostWarning,
        preferredExecutablePath: startInput.preferredExecutablePath,
        thinkingLevel: startInput.thinkingLevel,
        agentCli: agentCli === 'both' ? 'codex' : agentCli ?? undefined,
        exec: context.services.exec,
        tempFiles: await createDeepSecTempFiles(),
        environment: modelAccess.environment,
        provider: modelAccess.provider,
        claudeSubscription: modelAccess.claudeSubscription,
        gateway: modelAccess.gateway,
        machineLogin: modelAccess.machineLogin,
        model: request.modelSelection?.modelId,
        readiness: {
          agentCli,
        },
        signal,
      });
      if (signal.aborted) {
        return { status: 'cancelled' };
      }
      if (runResult.status === 'requires_confirmation') {
        emit({
          kind: 'output-delta',
          channel: 'assistant',
          text: JSON.stringify({
            runRef: { runId: request.runId, callId: `deepsec:${request.runId}`, backendId: 'deepsec' },
            status: 'failed',
            error: { code: 'deepsec_confirmation_required' },
            summary: 'DeepSec review requires confirmation.',
            overviewMarkdown: 'DeepSec review requires confirmation before launch.',
            findings: [],
            questions: [],
            assumptions: [],
            generatedAtMs: Date.now(),
            warning: runResult.warning,
          }),
        });
        return { status: 'failed', diagnostic: { code: 'deepsec_confirmation_required', severity: 'error' } };
      }

      const findings = normalizeDeepSecFindings('exportedEntries' in runResult && runResult.exportedEntries
        ? runResult.exportedEntries : parseDeepSecCommentOutMarkdown(runResult.commentOutMarkdown));
      emit({ kind: 'output-delta', channel: 'assistant', text: createOutput({ runId: request.runId, findings, runResult }) });
      return runResult.status === 'completed' || runResult.status === 'partial'
        ? { status: 'complete' }
        : { status: 'failed', diagnostic: {
          code: runResult.status === 'readiness_failed' ? 'deepsec_readiness_failed' : 'deepsec_process_failed',
          severity: 'error',
        } };
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
