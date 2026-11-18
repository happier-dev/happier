import type { DeepSecProviderRoute } from '../providerBinding.js';

export const DEEPSEC_REVIEW_MODES = ['repository_security_audit', 'current_diff', 'staged', 'working_tree', 'selected_files'] as const;
export type DeepSecReviewMode = typeof DEEPSEC_REVIEW_MODES[number];

export function isDeepSecReviewMode(value: unknown): value is DeepSecReviewMode {
  return DEEPSEC_REVIEW_MODES.some(mode => mode === value);
}

export type DeepSecCommandMode = DeepSecReviewMode | 'repository_security_audit_process' | 'repository_security_audit_export';

export const DEEPSEC_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type DeepSecThinkingLevel = typeof DEEPSEC_THINKING_LEVELS[number];

export function isDeepSecThinkingLevel(value: unknown): value is DeepSecThinkingLevel {
  return DEEPSEC_THINKING_LEVELS.some(level => level === value);
}

export type DeepSecCommandInput = Readonly<{
  mode: DeepSecCommandMode;
  commentOutPath?: string;
  filesFromPath?: string;
  provider?: DeepSecProviderRoute;
  claudeSubscription?: boolean;
  gateway?: boolean;
  thinkingLevel?: DeepSecThinkingLevel;
  agentCli?: 'claude' | 'codex';
  rootPath?: string;
  exportPath?: string;
}>;

function requirePath(value: string | undefined, label: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function buildDeepSecCommand(input: DeepSecCommandInput): readonly string[] {
  if (input.mode === 'repository_security_audit_export') return ['export', '--format', 'json', '--out', requirePath(input.exportPath, 'exportPath')];
  if (input.mode === 'repository_security_audit') return ['scan', ...(input.rootPath ? ['--root', input.rootPath] : [])];
  const args = [...buildProcessCommand(input), ...(input.thinkingLevel ? ['--thinking-level', input.thinkingLevel] : [])];
  if (input.claudeSubscription) {
    // An explicit endpoint prevents a persisted DeepSec model route replacing
    // the access-only native Claude environment selected for this finite Run.
    return [...args, '--agent', 'claude', '--ai-provider', 'anthropic', '--ai-base-url', 'https://api.anthropic.com'];
  }
  if (input.gateway) {
    const agent = input.agentCli ?? 'codex';
    return [...args, '--agent', agent, '--ai-provider', agent === 'claude' ? 'anthropic' : 'openai',
      '--ai-base-url', agent === 'claude' ? 'https://ai-gateway.vercel.sh' : 'https://ai-gateway.vercel.sh/v1'];
  }
  if (!input.provider) return input.agentCli ? [...args, '--agent', input.agentCli] : args;
  // The explicit base flag also prevents DeepSec from reapplying a persisted
  // model route. The Codex harness consumes the matching child environment.
  return [...args, '--agent', input.provider.agent, '--model', input.provider.model,
    '--ai-provider', input.provider.provider, '--ai-base-url', input.provider.baseUrl];
}

function buildProcessCommand(input: DeepSecCommandInput): readonly string[] {
  if (input.mode === 'repository_security_audit_process') return ['process', ...(input.rootPath ? ['--root', input.rootPath] : [])];
  const commentOutPath = requirePath(input.commentOutPath, 'commentOutPath');
  if (input.mode === 'staged') return ['process', '--diff-staged', '--comment-out', commentOutPath];
  if (input.mode === 'working_tree') return ['process', '--diff-working', '--comment-out', commentOutPath];
  // Happier owns these paths, including untracked and normally ignored files.
  return ['process', '--files-from', requirePath(input.filesFromPath, 'filesFromPath'), '--no-ignore', '--comment-out', commentOutPath];
}
