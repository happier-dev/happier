export const GITHUB_TOKEN_CREDENTIAL_KEY = 'token';

/** GitHub documents fine-grained PAT, OAuth and App-user grants for Copilot CLI. */
export function isGithubCopilotCompatibleToken(token: string): boolean {
  return /^(?:github_pat_|gho_|ghu_).+$/u.test(token.trim());
}
