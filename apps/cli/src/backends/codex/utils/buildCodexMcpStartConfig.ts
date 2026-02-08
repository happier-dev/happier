import type { CodexSessionConfig } from '../types';

export function buildCodexMcpStartConfig(opts: Readonly<{
  prompt: string;
  sandbox: NonNullable<CodexSessionConfig['sandbox']>;
  approvalPolicy: NonNullable<CodexSessionConfig['approval-policy']>;
  mcpServers: unknown;
  model?: string | null;
}>): CodexSessionConfig {
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';

  return {
    prompt: opts.prompt,
    sandbox: opts.sandbox,
    'approval-policy': opts.approvalPolicy,
    config: { mcp_servers: opts.mcpServers },
    ...(model ? { model } : {}),
  };
}

