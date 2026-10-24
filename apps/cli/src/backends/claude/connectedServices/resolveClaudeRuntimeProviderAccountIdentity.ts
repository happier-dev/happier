import { join } from 'node:path';

import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';

import { readClaudeOauthAccountIdentity, readClaudeRootConfigFile } from './claudeRootConfig';

export type ClaudeRuntimeProviderAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerEmail: string | null;
  providerOrganizationId: string | null;
}>;

/**
 * Read the live provider-account identity from a materialized Claude config dir
 * (`<dir>/.claude.json` → `oauthAccount`). This is the SAME identity the runtime-auth adapter
 * consults when it forms exact-identity source links; keeping one owner avoids a second, drifting
 * identity source (mirrors Codex `readCodexAuthStoreProviderAccountId`).
 */
export async function readClaudeMaterializedOAuthAccountIdentity(
  claudeConfigDir: string,
): Promise<ClaudeRuntimeProviderAccountIdentity> {
  const rootConfig = await readClaudeRootConfigFile(join(claudeConfigDir, '.claude.json'));
  const identity = readClaudeOauthAccountIdentity(rootConfig?.oauthAccount);
  return {
    providerAccountId: identity.accountId,
    providerEmail: identity.email,
    providerOrganizationId: identity.providerOrganizationId,
  };
}

/**
 * Resolve the live provider-account identity for the CURRENT runtime, from the configured Claude
 * config dir (`CLAUDE_CONFIG_DIR` override or the default home). Fails closed — returns a null
 * `providerAccountId` when the account is genuinely unknown (e.g. api-key/anthropic sessions with
 * no `oauthAccount`), so unproven evidence never forms a source link.
 */
export async function resolveClaudeRuntimeProviderAccountIdentity(
  params: Readonly<{ env: NodeJS.ProcessEnv }>,
): Promise<ClaudeRuntimeProviderAccountIdentity> {
  return readClaudeMaterializedOAuthAccountIdentity(
    resolveConfiguredClaudeConfigDir({ env: params.env }),
  );
}
