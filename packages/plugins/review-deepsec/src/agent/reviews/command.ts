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
}>;

function requirePath(value: string | undefined, label: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function buildDeepSecCommand(input: DeepSecCommandInput): readonly string[] {
  if (input.mode === 'repository_security_audit') return ['scan'];
  const commentOutPath = requirePath(input.commentOutPath, 'commentOutPath');
  if (input.mode === 'repository_security_audit_process') return ['process', '--comment-out', commentOutPath];
  if (input.mode === 'current_diff') return ['process', '--diff', '--comment-out', commentOutPath];
  if (input.mode === 'staged') return ['process', '--diff-staged', '--comment-out', commentOutPath];
  if (input.mode === 'working_tree') return ['process', '--diff-working', '--comment-out', commentOutPath];
  return ['process', '--files-from', requirePath(input.filesFromPath, 'filesFromPath'), '--comment-out', commentOutPath];
}
