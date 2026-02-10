import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { EXEC_SEQUENCING_INSTRUCTION } from '@/agent/runtime/execSequencingInstruction';

import type { CodexSessionConfig } from '../types';
import { buildCodexMcpStartConfig } from './buildCodexMcpStartConfig';

export function buildCodexMcpStartConfigForMessage(opts: Readonly<{
  message: string;
  first: boolean;
  sandbox: NonNullable<CodexSessionConfig['sandbox']>;
  approvalPolicy: NonNullable<CodexSessionConfig['approval-policy']>;
  mcpServers: unknown;
  mode: { model?: string | null | undefined };
}>): CodexSessionConfig {
  const prompt = opts.first
    ? `${opts.message}\n\n${CHANGE_TITLE_INSTRUCTION}\n\n${EXEC_SEQUENCING_INSTRUCTION}`
    : opts.message;

  return buildCodexMcpStartConfig({
    prompt,
    sandbox: opts.sandbox,
    approvalPolicy: opts.approvalPolicy,
    mcpServers: opts.mcpServers,
    model: opts.mode.model,
  });
}
