import type {
  ExecService,
  PluginProcessResult,
  ResolvedSystemTool as PluginResolvedSystemTool,
  SystemToolDiagnostic as PluginSystemToolDiagnostic,
} from '@happier-dev/plugin-sdk/exec';

import { buildDeepSecCommand, type DeepSecReviewMode, type DeepSecThinkingLevel } from './command.js';
import { buildDeepSecCostWarning, type DeepSecCostWarningInput, type DeepSecCostWarningResult } from './costWarning.js';
import { resolveDeepSecExecutable } from './executable.js';
import { checkDeepSecReadiness, type DeepSecReadiness } from './readiness.js';
import type { DeepSecProviderRoute } from '../providerBinding.js';
import type { ParsedDeepSecCommentOutEntry } from './commentOut.js';
import { parseDeepSecExport } from './exportOutput.js';

export type DeepSecTempFileRequest = Readonly<{
  suffix: string;
  contents: string;
}>;

export type DeepSecScopedPathListDiagnostic = Readonly<{
  code: string;
  severity: 'warning' | 'error';
  messageKey: string;
  path?: string;
}>;

export type DeepSecScopedPathListFileInput = Readonly<{
  suffix: string;
  paths: readonly string[];
}>;

export type DeepSecScopedPathListFileResult =
  | Readonly<{ status: 'created'; path: string; paths: readonly string[] }>
  | Readonly<{ status: 'blocked'; diagnostics: readonly DeepSecScopedPathListDiagnostic[] }>;

export type DeepSecTempFiles = Readonly<{
  createTextFile(request: DeepSecTempFileRequest): Promise<string>;
  createScopedPathListFile?(request: DeepSecScopedPathListFileInput): Promise<DeepSecScopedPathListFileResult>;
  readText(path: string): Promise<string>;
  cleanup(): Promise<void>;
}>;

export type DeepSecReviewRunResult =
  | Readonly<{
      status: 'completed' | 'failed';
      result: PluginProcessResult;
      commentOutMarkdown: string;
      exportedEntries?: readonly ParsedDeepSecCommentOutEntry[];
    }>
  | Readonly<{
      status: 'partial';
      stage: 'process';
      diagnostics: readonly DeepSecRuntimeDiagnostic[];
      result: PluginProcessResult;
      commentOutMarkdown: string;
      exportedEntries?: readonly ParsedDeepSecCommentOutEntry[];
    }>
  | Readonly<{
      status: 'requires_confirmation';
      warning: Extract<DeepSecCostWarningResult, { status: 'requires_confirmation' }>;
    }>
  | Readonly<{
      status: 'readiness_failed';
      readiness: Extract<DeepSecReadiness, { status: 'missing' | 'blocked' }>;
      commentOutMarkdown: '';
    }>
  | Readonly<{
      status: 'selected_scope_failed';
      diagnostics: readonly DeepSecScopedPathListDiagnostic[];
      commentOutMarkdown: '';
    }>;

export type DeepSecRuntimeDiagnostic = Readonly<{
  code: string;
  severity: 'warning' | 'error';
  messageKey: string;
  detail: Readonly<{
      exitCode: number | null;
      signal: string | null;
  }>;
}>;

export type RunDeepSecReviewParams = Readonly<{
  cwd: string;
  mode: DeepSecReviewMode;
  selectedFiles?: readonly string[];
  confirmedCostWarning: boolean;
  cost?: Omit<DeepSecCostWarningInput, 'mode'>;
  preferredExecutablePath?: string | null;
  exec: Pick<ExecService, 'systemTools' | 'run'>;
  tempFiles: DeepSecTempFiles;
  environment?: Readonly<Record<string, string>>;
  provider?: DeepSecProviderRoute;
  claudeSubscription?: boolean;
  gateway?: boolean;
  machineLogin?: boolean;
  model?: string;
  thinkingLevel?: DeepSecThinkingLevel;
  agentCli?: 'claude' | 'codex';
  readiness?: Readonly<{
    toolRuntime?: DeepSecReadiness['toolRuntime'];
    agentCli?: 'claude' | 'codex' | 'both' | null;
  }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}>;

function normalizeSelectedFiles(selectedFiles: readonly string[] | undefined): readonly string[] {
  if (!selectedFiles || selectedFiles.length === 0) {
    throw new Error('selectedFiles must include at least one file path');
  }

  const normalizedFiles: string[] = [];
  const seen = new Set<string>();
  for (const filePath of selectedFiles) {
    const normalized = filePath.trim();
    if (!normalized || /[\r\n]/.test(normalized)) {
      throw new Error('selectedFiles must be non-empty single-line paths');
    }
    const slashNormalized = normalized.replace(/\\/g, '/');
    if (
      slashNormalized.includes('\0')
      || slashNormalized.startsWith('/')
      || slashNormalized.startsWith('~')
      || /^[A-Za-z]:/.test(slashNormalized)
    ) {
      throw new Error('selectedFiles must be safe workspace-relative paths');
    }
    const segments = slashNormalized.split('/').filter((segment) => segment && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
      throw new Error('selectedFiles must be safe workspace-relative paths');
    }
    const safePath = segments.join('/');
    if (!seen.has(safePath)) {
      seen.add(safePath);
      normalizedFiles.push(safePath);
    }
  }

  return Object.freeze(normalizedFiles);
}

function commandFailed(result: PluginProcessResult, directFindingReport = false): boolean {
  const observed = result.termination.observed;
  return result.termination.requestedBy.kind !== 'none'
    || observed.kind !== 'exit'
    || (observed.exitCode !== 0 && !(observed.exitCode === 1 && directFindingReport));
}

function readTermination(result: PluginProcessResult): Readonly<{ exitCode: number | null; signal: string | null }> {
  const observed = result.termination.observed;
  if (observed.kind === 'exit') return { exitCode: observed.exitCode, signal: null };
  if (observed.kind === 'signal') return { exitCode: null, signal: observed.signal };
  return { exitCode: null, signal: null };
}

function processPartialDiagnostic(result: PluginProcessResult): DeepSecRuntimeDiagnostic {
  return {
    code: 'deepsec_process_failed',
    severity: 'warning',
    messageKey: 'plugins.deepsec.runtime.partial',
    detail: readTermination(result),
  };
}

function resolveReadinessAgentCli(
  readiness: RunDeepSecReviewParams['readiness'],
): 'claude' | 'codex' | 'both' | null {
  return readiness && 'agentCli' in readiness ? readiness.agentCli ?? null : 'both';
}

function readDiagnosticString(
  diagnostic: PluginSystemToolDiagnostic,
  key: string,
): string | null {
  const value = diagnostic.detail?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readDiagnosticNumber(
  diagnostic: PluginSystemToolDiagnostic,
  key: string,
): number | null {
  const value = diagnostic.detail?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveToolRuntimeFromGrant(grant: PluginResolvedSystemTool): DeepSecReadiness['toolRuntime'] {
  const runtimeDiagnostics = (grant.diagnostics ?? []).filter((diagnostic) => (
    diagnostic.code === 'system_tool_runtime_unknown'
    || diagnostic.code === 'system_tool_runtime_node'
  ));
  const nodeDiagnostic = runtimeDiagnostics.find((diagnostic) => diagnostic.code === 'system_tool_runtime_node');
  if (nodeDiagnostic) {
    const version = readDiagnosticString(nodeDiagnostic, 'version');
    const majorVersion = readDiagnosticNumber(nodeDiagnostic, 'majorVersion');
    if (version && majorVersion !== null) {
      return {
        kind: 'node',
        version,
        majorVersion,
        diagnostics: Object.freeze(runtimeDiagnostics),
      };
    }
  }
  return {
    kind: 'unknown',
    diagnostics: Object.freeze(runtimeDiagnostics),
  };
}

function missingScopedPathListDiagnostic(): DeepSecScopedPathListDiagnostic {
  return {
    code: 'scope_unavailable',
    severity: 'error',
    messageKey: 'plugins.fs.scopedPathList.scopeUnavailable',
  };
}

export async function runDeepSecReview(params: RunDeepSecReviewParams): Promise<DeepSecReviewRunResult> {
  try {
    const selectedFiles = params.mode === 'selected_files' || params.mode === 'current_diff'
      ? normalizeSelectedFiles(params.selectedFiles)
      : undefined;
    const warning = buildDeepSecCostWarning({ mode: params.mode, ...(params.cost ?? {}) });
    if (warning.status === 'requires_confirmation' && !params.confirmedCostWarning) {
      return { status: 'requires_confirmation', warning };
    }

    const grant = await resolveDeepSecExecutable({
      systemTools: params.exec.systemTools,
      cwd: params.cwd,
      preferredExecutablePath: params.preferredExecutablePath,
      signal: params.signal,
    });
    const readiness = checkDeepSecReadiness({
      executablePath: grant.executablePath,
      toolRuntime: params.readiness?.toolRuntime ?? resolveToolRuntimeFromGrant(grant),
      agentCli: resolveReadinessAgentCli(params.readiness),
    });
    if (readiness.status !== 'ready') {
      return {
        status: 'readiness_failed',
        readiness,
        commentOutMarkdown: '',
      };
    }

    let commentOutPath: string | undefined;
    let filesFromPath: string | undefined;
    if (selectedFiles) {
      const selectedFileList = await params.tempFiles.createScopedPathListFile?.({
        suffix: '.files.txt',
        paths: selectedFiles ?? [],
      }) ?? { status: 'blocked' as const, diagnostics: [missingScopedPathListDiagnostic()] };
      if (selectedFileList.status === 'blocked') {
        return {
          status: 'selected_scope_failed',
          diagnostics: selectedFileList.diagnostics,
          commentOutMarkdown: '',
        };
      }
      filesFromPath = selectedFileList.path;
    }
    commentOutPath = await params.tempFiles.createTextFile({
      suffix: '.comments.md',
      contents: '',
    });
    const commandArgs = buildDeepSecCommand({
      mode: params.mode,
      commentOutPath,
      filesFromPath,
      provider: params.provider,
      claudeSubscription: params.claudeSubscription,
      gateway: params.gateway,
      machineLogin: params.machineLogin,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      agentCli: params.agentCli,
      rootPath: params.cwd,
    });
    // Export defaults to every project in the native data root. Reuse this
    // Run's existing temporary workspace so it cannot read stale/other projects.
    const environment = params.mode === 'repository_security_audit'
      ? { ...params.environment, DEEPSEC_DATA_ROOT: `${commentOutPath}.data` }
      : params.environment;
    const run = (args: readonly string[]) => params.exec.run({
      executable: grant.executable,
      args,
      cwd: { root: 'workspace', relativePath: '' },
      ...(environment ? { env: environment } : {}),
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      ...(params.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: params.maxStdoutBytes }),
      ...(params.maxStderrBytes === undefined ? {} : { maxStderrBytes: params.maxStderrBytes }),
    }, { signal: params.signal });
    const result = await run(commandArgs);
    if (params.mode === 'repository_security_audit' && !commandFailed(result)) {
      const processResult = await run(buildDeepSecCommand({
        mode: 'repository_security_audit_process',
        commentOutPath,
        provider: params.provider,
        claudeSubscription: params.claudeSubscription,
        gateway: params.gateway,
        machineLogin: params.machineLogin,
        model: params.model,
        thinkingLevel: params.thinkingLevel,
        agentCli: params.agentCli,
        rootPath: params.cwd,
      }));
      // Successful batches are persisted even when another batch fails. The
      // existing export reads those records independently of the process exit.
      const exportPath = `${commentOutPath}.json`;
      const exportResult = await run(buildDeepSecCommand({ mode: 'repository_security_audit_export', exportPath }));
      if (commandFailed(exportResult)) return { status: 'failed', result: exportResult, commentOutMarkdown: '' };
      const exportedEntries = parseDeepSecExport(await params.tempFiles.readText(exportPath));
      if (commandFailed(processResult)) {
        return {
          status: 'partial',
          stage: 'process',
          diagnostics: [processPartialDiagnostic(processResult)],
          result: processResult,
          commentOutMarkdown: '',
          exportedEntries,
        };
      }
      return { status: 'completed', result: exportResult, commentOutMarkdown: '', exportedEntries };
    }
    const commentOutMarkdown = commentOutPath ? await params.tempFiles.readText(commentOutPath) : '';
    return {
      // DeepSec direct mode writes this newly-created report only after agent
      // error/quota checks. Exit 1 alone also represents those failures.
      status: commandFailed(result, params.mode !== 'repository_security_audit' && Boolean(commentOutMarkdown.trim())) ? 'failed' : 'completed',
      result,
      commentOutMarkdown,
    };
  } finally {
    await params.tempFiles.cleanup();
  }
}
