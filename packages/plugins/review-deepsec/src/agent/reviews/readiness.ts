import type { SystemToolDiagnostic as PluginSystemToolDiagnostic } from '@happier-dev/plugin-sdk/exec';

export type DeepSecPrerequisite = 'deepsec' | 'node>=22' | 'claude-or-codex' | 'AI_GATEWAY_API_KEY';

export type DeepSecToolRuntime =
  | Readonly<{
      kind: 'node';
      version: string;
      majorVersion: number;
      diagnostics: readonly PluginSystemToolDiagnostic[];
    }>
  | Readonly<{
      kind: 'unknown';
      diagnostics: readonly PluginSystemToolDiagnostic[];
    }>;

export type DeepSecReadiness =
  | Readonly<{
      status: 'ready';
      executablePath: string;
      toolRuntime: DeepSecToolRuntime;
      agentCli?: 'claude' | 'codex' | 'both';
    }>
  | Readonly<{
      status: 'missing' | 'blocked';
      missing: readonly DeepSecPrerequisite[];
      toolRuntime: DeepSecToolRuntime;
      installUrl?: string;
      commandPreview?: readonly string[];
      messageKey: string;
    }>;

export function checkDeepSecReadiness(params: Readonly<{
  executablePath: string | null | undefined;
  toolRuntime?: DeepSecToolRuntime | null;
  agentCli?: 'claude' | 'codex' | 'both' | null;
  hasGatewayKey: boolean;
}>): DeepSecReadiness {
  const missing: DeepSecPrerequisite[] = [];
  const executablePath = String(params.executablePath ?? '').trim();
  const toolRuntime = params.toolRuntime ?? { kind: 'unknown', diagnostics: [] };
  if (!executablePath) missing.push('deepsec');
  if (toolRuntime.kind === 'node' && toolRuntime.majorVersion < 22) missing.push('node>=22');
  if (!params.agentCli) missing.push('claude-or-codex');
  if (!params.hasGatewayKey) missing.push('AI_GATEWAY_API_KEY');

  if (missing.length > 0) {
    return {
      status: 'missing',
      missing,
      toolRuntime,
      installUrl: 'https://github.com/vercel-labs/deepsec',
      commandPreview: ['deepsec', '--help'],
      messageKey: 'plugins.deepsec.readiness.missing',
    };
  }

  return {
    status: 'ready',
    executablePath,
    toolRuntime,
    ...(params.agentCli ? { agentCli: params.agentCli } : {}),
  };
}
