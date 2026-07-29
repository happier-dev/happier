import type {
  PluginExecService,
  PluginProcessResult,
  PluginResolvedSystemTool,
  PluginSystemToolDiagnostic,
} from '@happier-dev/plugin-sdk/runtime';

import { buildDeepSecCommand, type DeepSecReviewMode } from './command.js';
import { buildDeepSecCostWarning, type DeepSecCostWarningInput, type DeepSecCostWarningResult } from './costWarning.js';
import { resolveDeepSecExecutable } from './executable.js';
import { checkDeepSecReadiness, type DeepSecReadiness } from './readiness.js';

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
    }>
  | Readonly<{
      status: 'partial';
      stage: 'process';
      diagnostics: readonly DeepSecRuntimeDiagnostic[];
      result: PluginProcessResult;
      commentOutMarkdown: string;
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
  exec: Pick<PluginExecService, 'systemTools' | 'run'>;
  tempFiles: DeepSecTempFiles;
  environment?: Readonly<Record<string, string>>;
  readiness?: Readonly<{
    toolRuntime?: DeepSecReadiness['toolRuntime'];
    agentCli?: 'claude' | 'codex' | 'both' | null;
    hasGatewayKey?: boolean | null;
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

function commandFailed(result: PluginProcessResult): boolean {
  const observed = result.termination.observed;
  return observed.kind !== 'exit' || observed.exitCode !== 0;
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

function resolveReadinessGatewayKey(readiness: RunDeepSecReviewParams['readiness']): boolean {
  return readiness && 'hasGatewayKey' in readiness ? readiness.hasGatewayKey === true : true;
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
    const selectedFiles = params.mode === 'selected_files'
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
      hasGatewayKey: resolveReadinessGatewayKey(params.readiness),
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
    if (params.mode === 'selected_files') {
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
    });
    const run = (args: readonly string[]) => params.exec.run({
      executable: grant.executable,
      args,
      cwd: { root: 'workspace', relativePath: '' },
      ...(params.environment ? { env: params.environment } : {}),
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      ...(params.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: params.maxStdoutBytes }),
      ...(params.maxStderrBytes === undefined ? {} : { maxStderrBytes: params.maxStderrBytes }),
    }, { signal: params.signal });
    const result = await run(commandArgs);
    if (params.mode === 'repository_security_audit' && !commandFailed(result)) {
      const processResult = await run(buildDeepSecCommand({
        mode: 'repository_security_audit_process',
        commentOutPath,
      }));
      const commentOutMarkdown = await params.tempFiles.readText(commentOutPath);
      if (commandFailed(processResult)) {
        return {
          status: 'partial',
          stage: 'process',
          diagnostics: [processPartialDiagnostic(processResult)],
          result: processResult,
          commentOutMarkdown,
        };
      }
      return {
        status: 'completed',
        result: processResult,
        commentOutMarkdown,
      };
    }
    const commentOutMarkdown = commentOutPath ? await params.tempFiles.readText(commentOutPath) : '';
    return {
      status: commandFailed(result) ? 'failed' : 'completed',
      result,
      commentOutMarkdown,
    };
  } finally {
    await params.tempFiles.cleanup();
  }
}
