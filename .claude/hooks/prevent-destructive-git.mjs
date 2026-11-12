import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { evaluateDependencyPatchGuard } from './dependencyPatchGuard.mjs';
import { evaluateRefWriteGuard } from './refWriteGuard.mjs';
import { evaluateStaleWriteGuard } from './staleWriteGuard.mjs';
import { evaluateSearchCommandGuard } from './searchCommandGuard.mjs';

// Preserve Bash command substitution: only string fields are used, and trailing
// newlines and NUL bytes do not survive the original shell envelope adapter.
const field = (value) => typeof value === 'string' ? value.replaceAll('\0', '').replace(/\n+$/, '') : '';

export function evaluateGitGuard(event) {
  const dependencyRefusal = evaluateDependencyPatchGuard(event);
  if (dependencyRefusal) return { status: 1, stdout: '', stderr: dependencyRefusal };

  const tool = field(event.tool_name) || field(event.tool);
  const command = field(event.tool_input?.command) || field(event.args?.command);
  if (tool !== 'Bash' || !command || (process.env.ALLOW_DESTRUCTIVE_GIT && process.env.ALLOW_DESTRUCTIVE_GIT !== '0')) {
    return { status: 0, stdout: '', stderr: '' };
  }

  // Strip read-only stash clauses before checking the remaining command, just
  // as the shell guard did, so compound commands retain the same refusals.
  const stashStripped = (spawnSync('sed', [
    '-E', 's/git[[:space:]]+stash[[:space:]]+(list|show)[^;&|]*//g',
  ], { input: command, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).stdout ?? '').replace(/\n+$/, '');
  const checkoutStripped = command.replaceAll('git checkout-index', 'git __checkout_index__');
  let matched = ['git reset', 'git restore', 'git clean', 'git checkout', 'git switch']
    .find((candidate) => checkoutStripped.includes(candidate)) ?? '';
  if (!matched && stashStripped.includes('git stash')) matched = 'git stash';
  matched ||= evaluateRefWriteGuard(command);
  matched ||= evaluateStaleWriteGuard(command);
  matched ||= evaluateSearchCommandGuard(command);
  if (!matched) return { status: 0, stdout: '', stderr: '' };

  return { status: 1, stderr: '', stdout: `
❌ BLOCKED: destructive git command detected

Command:
  ${command}

Matched:
  ${matched}

Repo policy: do not discard, revert, or clean unrelated/uncommitted work unless the user explicitly asked for that exact destructive action.

Stale-write policy: observe RED in an OS-temp copy or a separate git worktree add;
never restore older bytes over shared source. The shared index is not source authority.

Search policy: controller-wide searches are blocked to protect the shared checkout. Use:
  ./apps/stack/bin/hstack-exec -- rg <pattern> <narrow path>

If this destructive operation is truly required, ask for explicit approval first. After approval, re-run with:
  export ALLOW_DESTRUCTIVE_GIT=1

Prefer inspection commands when possible:
  git status --porcelain
  git diff

` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(0, 'utf8').replaceAll('\0', '') || '{}');
  const result = evaluateGitGuard(event);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
