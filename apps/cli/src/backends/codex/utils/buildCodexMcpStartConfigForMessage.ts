import type { CodexSessionConfig } from '../types';
import { buildCodexMcpStartConfig } from './buildCodexMcpStartConfig';

export function buildCodexMcpStartConfigForMessage(opts: Readonly<{
  message: string;
  first: boolean;
  sandbox: NonNullable<CodexSessionConfig['sandbox']>;
  approvalPolicy: NonNullable<CodexSessionConfig['approval-policy']>;
  mcpServers: unknown;
  mode: { model?: string | null | undefined };
  systemPromptText?: string | null | undefined;
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
  });
}
