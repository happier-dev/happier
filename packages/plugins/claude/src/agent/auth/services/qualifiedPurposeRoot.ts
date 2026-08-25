import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import { resolveClaudeConfigDir } from '../../environment.js';
import { isClaudeProviderOwnedEnvName } from '../../providerBinding/adapter.js';
import { claudeAuthStateSharingDescriptor } from './stateSharing.js';
import { projectClaudeWorkspaceTrust } from './workspaceTrust.js';

export async function prepareClaudeQualifiedPurposeRoot(input: Readonly<{
  rootDir: string;
  processEnv: NodeJS.ProcessEnv;
  sessionDirectory: string | null;
}>): Promise<void> {
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 });
  await projectClaudeWorkspaceTrust({
    sourceEnv: input.processEnv,
    targetDir: input.rootDir,
    sessionDirectory: input.sessionDirectory,
  });
}

/**
 * Claude config entries that are the stored account identity. They are never
 * shared with the isolated root. Settings documents are shared as sanitized
 * copies instead — see `CLAUDE_USER_SETTINGS_ENTRY_NAMES` — and every
 * remaining entry is shared by link so an isolated launch keeps the user's
 * skills, hooks, commands, plugins, and transcript history.
 */
function isClaudeIdentityConfigEntry(name: string): boolean {
  const folded = foldClaudeConfigEntryName(name);
  return folded === '.credentials.json' || folded.startsWith('.claude.json');
}

/**
 * Config entry names are classified by a case-folded identity for the same
 * reason environment names are: Windows NTFS and the default macOS APFS volume
 * resolve `Settings.json` and `settings.json` to the one file Claude Code
 * reads. A case-sensitive classification would link the user's own credential
 * or credential-resolving settings document into the pinned root verbatim.
 */
function foldClaudeConfigEntryName(name: string): string {
  return name.toLowerCase();
}

/**
 * The entries Claude's own state-sharing descriptor classifies as session
 * state rather than configuration. `ConnectedServiceStateSharingDescriptor` is
 * the single owner of that classification, so the pinned root reads it here
 * instead of naming `projects` again: a descriptor that grows a state entry
 * must not leave this path sharing it behind the user's back.
 */
const CLAUDE_STATE_ENTRY_NAMES: ReadonlySet<string> = new Set(
  claudeAuthStateSharingDescriptor.state.entries.map((entry) => foldClaudeConfigEntryName(entry.path)),
);

/**
 * Claude's user-scope settings documents. They are shared as sanitized copies
 * rather than links because Claude Code resolves a request credential from
 * them: `apiKeyHelper` is executed for a key, and `env` is applied to the
 * launched process. Observed against Claude Code 2.1.237 on macOS, either one
 * inside the pinned config root sends its value to `ANTHROPIC_BASE_URL`, which
 * is exactly the identity the pinned root exists to withhold from a
 * credential-less redirected upstream.
 */
const CLAUDE_USER_SETTINGS_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'settings.json',
  'settings.local.json',
]);

/**
 * Removes the credential-resolving keys from one settings document.
 *
 * The `env` filter reuses the Provider binding's own owned-name decision, so the
 * binding stays the single owner of which environment names it decides: its
 * upstream, its headers, and its credential can never be re-supplied by the
 * user's inherited settings. That decision is case-insensitive because Windows
 * environment names are, so a mixed-case entry cannot survive isolation.
 *
 * Returns null when the document cannot be read as a settings object. The
 * caller then omits it entirely — an unsanitizable document must never be
 * shared verbatim.
 */
function sanitizeClaudeUserSettings(source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { apiKeyHelper: _apiKeyHelper, env, ...rest } = parsed as Record<string, unknown>;
  const sharedEnv = typeof env === 'object' && env !== null && !Array.isArray(env)
    ? Object.fromEntries(
        Object.entries(env as Record<string, unknown>).filter(([name]) => (
          !isClaudeProviderOwnedEnvName(name)
        )),
      )
    : null;
  return JSON.stringify(sharedEnv === null ? rest : { ...rest, env: sharedEnv });
}

/** An unreadable Claude config directory shares nothing and fails no launch. */
async function readClaudeConfigDirEntries(sourceDir: string) {
  try {
    return await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function shareSanitizedClaudeUserSettings(input: Readonly<{
  sourcePath: string;
  targetPath: string;
}>): Promise<void> {
  let source: string;
  try {
    source = await readFile(input.sourcePath, 'utf8');
  } catch {
    return;
  }
  const sanitized = sanitizeClaudeUserSettings(source);
  if (sanitized === null) return;
  try {
    await writeFile(input.targetPath, `${sanitized}\n`, { mode: 0o600 });
  } catch {
    // Losing one shared settings document degrades convenience only; the
    // identity stays isolated either way.
  }
}

/**
 * Shares the user's non-identity Claude configuration with an isolated root.
 *
 * Isolating the account must not also isolate the workspace: without this the
 * pinned root is bare, and the session silently loses the user's skills,
 * hooks, commands, plugins, settings, and history. Sharing is best effort per
 * entry — a platform that refuses a link, or a settings document that cannot
 * be sanitized, costs that one entry and must never fail the launch that is
 * isolating the identity.
 *
 * `stateMode` is the user's own provider state-sharing choice, resolved by the
 * canonical policy owner and carried on the launch request. Sharing history is
 * the default and the industry norm, but a user who chose `isolated` must not
 * find their whole conversation history linked into a pinned root anyway.
 */
export async function shareClaudeUserConfigWithIsolatedRoot(input: Readonly<{
  rootDir: string;
  processEnv: NodeJS.ProcessEnv;
  stateMode: NonNullable<AgentSessionOpenRequest['stateSharing']>['stateMode'];
}>): Promise<void> {
  const sourceDir = resolve(resolveClaudeConfigDir(input.processEnv));
  if (sourceDir === resolve(input.rootDir)) return;
  for (const entry of await readClaudeConfigDirEntries(sourceDir)) {
    if (isClaudeIdentityConfigEntry(entry.name)) continue;
    const foldedName = foldClaudeConfigEntryName(entry.name);
    if (input.stateMode === 'isolated' && CLAUDE_STATE_ENTRY_NAMES.has(foldedName)) continue;
    if (CLAUDE_USER_SETTINGS_ENTRY_NAMES.has(foldedName)) {
      await shareSanitizedClaudeUserSettings({
        sourcePath: join(sourceDir, entry.name),
        targetPath: join(input.rootDir, entry.name),
      });
      continue;
    }
    try {
      await symlink(
        join(sourceDir, entry.name),
        join(input.rootDir, entry.name),
        entry.isDirectory() ? 'junction' : 'file',
      );
    } catch {
      // A pre-existing target, an unsupported link, or a refused privilege
      // costs this one shared entry, never the identity isolation.
    }
  }
}
