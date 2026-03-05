import type { CodexSessionConfig } from '../types';

export function buildCodexMcpStartConfig(opts: Readonly<{
  prompt: string;
  baseInstructions?: string | null;
  sandbox: NonNullable<CodexSessionConfig['sandbox']>;
  approvalPolicy: NonNullable<CodexSessionConfig['approval-policy']>;
  mcpServers: unknown;
  model?: string | null;
}>): CodexSessionConfig {
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  const baseInstructions = typeof opts.baseInstructions === 'string' ? opts.baseInstructions.trim() : '';

  return {
    prompt: opts.prompt,
    sandbox: opts.sandbox,
    'approval-policy': opts.approvalPolicy,
    ...(baseInstructions ? { 'base-instructions': baseInstructions } : {}),
    config: { mcp_servers: opts.mcpServers },
    ...(model ? { model } : {}),
  };
}
