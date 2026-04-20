import type { CodexSessionConfig } from '../mcp/types';

export function buildCodexMcpStartConfig(opts: Readonly<{
  prompt: string;
  baseInstructions?: string | null;
  // When `sandbox` / `approvalPolicy` are undefined, we intentionally OMIT the fields from the
  // start-session request so the spawned Codex MCP server falls back to `~/.codex/config.toml`
  // (top-level approval_policy/sandbox_mode, or a `profile = "..."` selection).
  sandbox?: NonNullable<CodexSessionConfig['sandbox']> | null;
  approvalPolicy?: NonNullable<CodexSessionConfig['approval-policy']> | null;
  mcpServers: unknown;
  model?: string | null;
  cwd?: string | null;
}>): CodexSessionConfig {
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  const baseInstructions = typeof opts.baseInstructions === 'string' ? opts.baseInstructions.trim() : '';
  const cwd = typeof opts.cwd === 'string' ? opts.cwd.trim() : '';

  return {
    prompt: opts.prompt,
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.approvalPolicy ? { 'approval-policy': opts.approvalPolicy } : {}),
    ...(baseInstructions ? { 'base-instructions': baseInstructions } : {}),
    config: { mcp_servers: opts.mcpServers },
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
  };
}
