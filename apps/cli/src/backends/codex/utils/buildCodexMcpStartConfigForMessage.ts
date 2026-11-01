import type { CodexSessionConfig } from '../types';
import { buildCodexMcpStartConfig } from './buildCodexMcpStartConfig';

export function buildCodexMcpStartConfigForMessage(opts: Readonly<{
  message: string;
  first: boolean;
  // When `sandbox` / `approvalPolicy` are undefined, the fields are OMITTED from the start
  // request so the Codex MCP subprocess honors `~/.codex/config.toml`.
  sandbox?: NonNullable<CodexSessionConfig['sandbox']> | null;
  approvalPolicy?: NonNullable<CodexSessionConfig['approval-policy']> | null;
  mcpServers: unknown;
  mode: { model?: string | null | undefined };
  reasoningSummary?: 'auto' | 'none';
  systemPromptText?: string | null | undefined;
  cwd?: string | null | undefined;
}>): CodexSessionConfig {
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
    reasoningSummary: opts.reasoningSummary,
    cwd: opts.cwd ?? null,
  });
}
