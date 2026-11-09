import type { DeepSecProviderRoute } from '../providerBinding.js';

export type DeepSecReviewMode =
  | 'repository_security_audit'
  | 'current_diff'
  | 'staged'
  | 'working_tree'
  | 'selected_files';

export type DeepSecCommandMode = DeepSecReviewMode | 'repository_security_audit_process';

export type DeepSecCommandInput = Readonly<{
  mode: DeepSecCommandMode;
  commentOutPath?: string;
  filesFromPath?: string;
  provider?: DeepSecProviderRoute;
  claudeSubscription?: boolean;
}>;

function requirePath(value: string | undefined, label: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function buildDeepSecCommand(input: DeepSecCommandInput): readonly string[] {
  if (input.mode === 'repository_security_audit') return ['scan'];
  const args = buildProcessCommand(input);
  if (input.claudeSubscription) {
    // An explicit endpoint prevents a persisted DeepSec model route replacing
    // the access-only native Claude environment selected for this finite Run.
    return [...args, '--agent', 'claude', '--ai-provider', 'anthropic', '--ai-base-url', 'https://api.anthropic.com'];
  }
  if (!input.provider) return args;
  // The explicit base flag also prevents DeepSec from reapplying a persisted
  // model route. The Codex harness consumes the matching child environment.
  return [...args, '--agent', input.provider.agent, '--model', input.provider.model,
    '--ai-provider', input.provider.provider, '--ai-base-url', input.provider.baseUrl];
}

function buildProcessCommand(input: DeepSecCommandInput): readonly string[] {
  const commentOutPath = requirePath(input.commentOutPath, 'commentOutPath');
  if (input.mode === 'repository_security_audit_process') return ['process', '--comment-out', commentOutPath];
  if (input.mode === 'staged') return ['process', '--diff-staged', '--comment-out', commentOutPath];
  if (input.mode === 'working_tree') return ['process', '--diff-working', '--comment-out', commentOutPath];
  // Happier owns these paths, including untracked and normally ignored files.
  return ['process', '--files-from', requirePath(input.filesFromPath, 'filesFromPath'), '--no-ignore', '--comment-out', commentOutPath];
}
