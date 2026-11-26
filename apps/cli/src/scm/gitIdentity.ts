import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ScmGitIdentitySchema, type ScmGitIdentity, type ScmGitIdentityResolution } from '@happier-dev/protocol/scm/gitIdentity';
import type { ScmCommandInput, ScmCommandRunner } from './runtime';

export type GitIdentityResolution = ScmGitIdentityResolution & Readonly<{
  environment: Readonly<Record<string, string>>;
  processEnvironment: Readonly<Record<string, string>>;
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
    return { source: 'native', identity: match ? { name: match[1]!, email: match[2]! } : null, environment: {}, processEnvironment: {} };
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
  const parsedRepository = name && email && ![name, email].some(value => /\p{Cc}/u.test(value))
    ? ScmGitIdentitySchema.safeParse({ name, email }) : undefined;
  const repository = parsedRepository?.success ? parsedRepository.data : null;
  const identity = repository ?? input.person;
  const environment = {
    GIT_AUTHOR_NAME: identity?.name ?? '', GIT_AUTHOR_EMAIL: identity?.email ?? '',
    GIT_COMMITTER_NAME: identity?.name ?? '', GIT_COMMITTER_EMAIL: identity?.email ?? '',
  };
  // The guest overlay follows the Agent into other repositories and keeps
  // Git from falling back to the Machine identity. Empty values make Git refuse.
  return {
    source: repository ? 'repository' : input.person ? 'person' : 'none',
    identity,
    environment,
    processEnvironment: repository && input.isCustodian ? {} : environment,
  };
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

/** Explicit describe and author-writing commands share the admitted operation's resolution. */
export function resolveScmGitIdentity(cwd: string, run: ScmCommandRunner): Promise<GitIdentityResolution> | undefined {
  const current = scope.getStore();
  if (!current) return undefined;
  let result = current.resolutions.get(cwd);
  if (!result) {
    result = resolveGitIdentity({ ...current, cwd, run });
    current.resolutions.set(cwd, result);
  }
  return result;
}

/** Git's author-producing commands, including explicit attribution probes used by publication. */
export function gitCommandUsesIdentity(args: readonly string[]): boolean {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const option = args[index++];
    if (option === '-c' || option === '-C' || option === '--git-dir' || option === '--work-tree' || option === '--config-env') index++;
  }
  const command = args[index];
  const rest = args.slice(index + 1);
  switch (command) {
    case 'var': return rest[0] === 'GIT_AUTHOR_IDENT' || rest[0] === 'GIT_COMMITTER_IDENT';
    case 'stash': return rest.length === 0 || rest[0] === 'push' || rest[0] === 'save' || rest[0] === 'create';
    case 'commit': case 'commit-tree': case 'merge': case 'rebase': case 'revert': case 'cherry-pick': case 'am': case 'pull':
      return !rest.includes('--abort') && !rest.includes('--quit') && !rest.includes('--show-current-patch');
    default: return false;
  }
}

/** Resolve once per repository per admitted operation, through its already-selected process port. */
export async function applyGitIdentity(input: ScmCommandInput, run: ScmCommandRunner): Promise<ScmCommandInput> {
  const resolved = await resolveScmGitIdentity(input.cwd, run);
  if (!resolved) return input;
  return { ...input, env: { ...resolved.environment, ...input.env } };
}
