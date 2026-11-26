import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScmGitIdentity } from '@happier-dev/protocol/scm/gitIdentity';
import type { ScmCommandInput, ScmCommandRunner } from './runtime';

export type GitIdentityResolution = Readonly<{
  source: 'repository' | 'person' | 'native' | 'none';
  identity: ScmGitIdentity | null;
  environment: Readonly<Record<string, string>>;
}>;

/** The only precedence decision, shared by SCM and Agent launch composition. */
export async function resolveGitIdentity(input: Readonly<{
  person: ScmGitIdentity | null;
  isCustodian: boolean;
  cwd: string;
  run: ScmCommandRunner;
}>): Promise<GitIdentityResolution> {
  // No override: Git itself owns repository, environment and native fallback precedence.
  if (input.isCustodian && !input.person) {
    const native = await input.run({ bin: 'git', cwd: input.cwd, args: ['var', 'GIT_COMMITTER_IDENT'] });
    const match = native.success ? /^(.*) <([^<>]*)> \d+ [+-]\d+$/.exec(native.stdout.trim()) : null;
    return { source: 'native', identity: match ? { name: match[1]!, email: match[2]! } : null, environment: {} };
  }
  const local = await input.run({ bin: 'git', cwd: input.cwd, args: ['config', '--includes', '--null', '--show-scope', '--get-regexp', '^user\\.(name|email)$'] });
  const records = local.stdout.split('\0');
  const values = new Map<string, string>();
  for (let i = 0; i + 1 < records.length; i += 2) {
    if (records[i] !== 'local' && records[i] !== 'worktree') continue;
    const record = records[i + 1]!;
    const end = record.indexOf('\n');
    values.set(record.slice(0, end), record.slice(end + 1));
  }
  const name = values.get('user.name');
  const email = values.get('user.email');
  // Decision B: an explicit complete repository identity wins over the person.
  const repository = name && email ? { name, email } : null;
  const identity = repository ?? input.person;
  if (identity) return { source: repository ? 'repository' : 'person', identity, environment: {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  } };
  // Decision A: no implicit host identity for another person; git var retains its typed refusal.
  return { source: 'none', identity: null, environment: {
    GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '',
  } };
}

type IdentityScope = { person: ScmGitIdentity | null; isCustodian: boolean; resolutions: Map<string, Promise<GitIdentityResolution>> };
const scope = new AsyncLocalStorage<IdentityScope>();
/** Requester data, or the custodian's own Account preference; never the host's setting for a guest. */
export function readScmPersonGitIdentity(person: ScmGitIdentity | undefined, isCustodian: boolean): ScmGitIdentity | null {
  const current = scope.getStore();
  return current ? current.person : person ?? (isCustodian ? getActiveAccountSettingsSnapshot()?.settings.scmGitIdentity : null) ?? null;
}
export function runWithGitIdentity<T>(input: Readonly<{ person: ScmGitIdentity | null; isCustodian: boolean }>, run: () => T): T {
  return scope.getStore() ? run() : scope.run({ ...input, resolutions: new Map() }, run);
}

export function readResolvedGitIdentity(cwd: string): Promise<GitIdentityResolution> | undefined {
  return scope.getStore()?.resolutions.get(cwd);
}

/** Resolve once per repository per admitted operation, through its already-selected process port. */
export async function applyGitIdentity(input: ScmCommandInput, run: ScmCommandRunner): Promise<ScmCommandInput> {
  const current = scope.getStore();
  if (!current) return input;
  let result = current.resolutions.get(input.cwd);
  if (!result) {
    result = resolveGitIdentity({ ...current, cwd: input.cwd, run });
    current.resolutions.set(input.cwd, result);
  }
  const resolved = await result;
  return { ...input, env: { ...resolved.environment, ...input.env } };
}
