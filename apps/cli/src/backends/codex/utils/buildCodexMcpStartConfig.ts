import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';
import type { CodexSessionConfig } from '../types';

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
  // Reasoning effort for the run's model (Codex `model_reasoning_effort`). Written into the start
  // config so an execution run applies effort exactly like a spawned session's config option.
  modelReasoningEffort?: string | null;
  reasoningSummary?: 'auto' | 'none';
  cwd?: string | null;
}>): CodexSessionConfig {
  const model = readNonBlankSessionControlIdentifier(opts.model);
  const modelReasoningEffort = readNonBlankSessionControlIdentifier(opts.modelReasoningEffort);
  const baseInstructions = typeof opts.baseInstructions === 'string' ? opts.baseInstructions.trim() : '';
  const cwd = typeof opts.cwd === 'string' ? opts.cwd.trim() : '';

  return {
    prompt: opts.prompt,
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.approvalPolicy ? { 'approval-policy': opts.approvalPolicy } : {}),
    ...(baseInstructions ? { 'base-instructions': baseInstructions } : {}),
    config: {
      mcp_servers: opts.mcpServers,
      ...(modelReasoningEffort !== null ? { model_reasoning_effort: modelReasoningEffort } : {}),
      ...(opts.reasoningSummary !== undefined ? { model_reasoning_summary: opts.reasoningSummary } : {}),
    },
    ...(model !== null ? { model } : {}),
    ...(cwd ? { cwd } : {}),
  };
}
