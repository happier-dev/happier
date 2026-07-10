import type { SystemToolDiagnosticV1 } from '@happier-dev/plugin-sdk';

export type DeepSecPrerequisiteV1 = 'deepsec' | 'node>=22' | 'claude-or-codex' | 'AI_GATEWAY_API_KEY';

export type DeepSecToolRuntimeV1 =
  | Readonly<{
      kind: 'node';
      version: string;
      majorVersion: number;
      diagnostics: readonly SystemToolDiagnosticV1[];
    }>
  | Readonly<{
      kind: 'unknown';
      diagnostics: readonly SystemToolDiagnosticV1[];
    }>;

export type DeepSecReadinessV1 =
  | Readonly<{
      status: 'ready';
      executablePath: string;
      toolRuntime: DeepSecToolRuntimeV1;
      agentCli?: 'claude' | 'codex' | 'both';
    }>
  | Readonly<{
      status: 'missing' | 'blocked';
      missing: readonly DeepSecPrerequisiteV1[];
      toolRuntime: DeepSecToolRuntimeV1;
      installUrl?: string;
      commandPreview?: readonly string[];
      messageKey: string;
    }>;

export function checkDeepSecReadiness(params: Readonly<{
  executablePath: string | null | undefined;
  toolRuntime?: DeepSecToolRuntimeV1 | null;
  agentCli?: 'claude' | 'codex' | 'both' | null;
  hasGatewayKey: boolean;
}>): DeepSecReadinessV1 {
  const missing: DeepSecPrerequisiteV1[] = [];
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
