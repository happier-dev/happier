import type { CodexStartSessionConfig } from './startSessionConfig';
import { buildCodexMcpStartConfig } from './buildCodexMcpStartConfig';

export function buildCodexMcpStartConfigForMessage(opts: Readonly<{
  message: string;
  first: boolean;
  // When `sandbox` / `approvalPolicy` are undefined, the fields are OMITTED from the start
  // request so the Codex MCP subprocess honors `~/.codex/config.toml`.
  sandbox?: NonNullable<CodexStartSessionConfig['sandbox']> | null;
  approvalPolicy?: NonNullable<CodexStartSessionConfig['approval-policy']> | null;
  mcpServers: unknown;
  mode: { model?: string | null | undefined };
  systemPromptText?: string | null | undefined;
  cwd?: string | null | undefined;
}>): CodexStartSessionConfig {
  const systemPromptText = typeof opts.systemPromptText === 'string' ? opts.systemPromptText.trim() : '';

  const baseInstructions = opts.first
    ? systemPromptText || null
    : null;

  return buildCodexMcpStartConfig({
    prompt: opts.message,
    baseInstructions,
    sandbox: opts.sandbox,
    approvalPolicy: opts.approvalPolicy,
    mcpServers: opts.mcpServers,
    model: opts.mode.model,
    cwd: opts.cwd ?? null,
  });
}
