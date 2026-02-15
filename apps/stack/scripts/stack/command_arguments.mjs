import { resolvehstackCommand } from '../utils/cli/cli_registry.mjs';

const STACK_NAME_FIRST_SUPPORTED_COMMANDS = new Set([
  'new',
  'edit',
  'list',
  'migrate',
  'audit',
  'archive',
  'duplicate',
  'info',
  'pr',
  'create-dev-auth-seed',
  'daemon',
  'happier',
  'bug-report',
  'env',
  'auth',
  'dev',
  'start',
  'build',
  'review',
  'typecheck',
  'lint',
  'test',
  'doctor',
  'mobile',
  'mobile:install',
  'mobile-dev-client',
  'resume',
  'stop',
  'code',
  'cursor',
  'open',
  'srv',
  'wt',
  'service',
]);

export function resolveTopLevelNodeScriptFile(cmd) {
  const command = resolvehstackCommand(cmd);
  if (!command || command.kind !== 'node') return null;
  const rel = String(command.scriptRelPath ?? '').trim();
  if (!rel) return null;
  return rel.startsWith('scripts/') ? rel.slice('scripts/'.length) : rel;
}

export function stackNameFromArg(positionals, idx) {
  const name = positionals[idx]?.trim() ? positionals[idx].trim() : '';
  return name;
}

export function isKnownStackCommandToken(token) {
  const value = (token ?? '').toString().trim();
  if (!value) return false;
  if (value.startsWith('service:')) return true;
  if (value.startsWith('tailscale:')) return true;
  return STACK_NAME_FIRST_SUPPORTED_COMMANDS.has(value);
}

export function normalizeStackNameFirstArgs(argv, { stackExists }) {
  // Back-compat UX:
  // Allow `hstack stack <name> <command> ...` (stack name first) as a shortcut for:
  //   `hstack stack <command> <name> ...`
  //
  // We only apply this rewrite when the first positional is *not* a known stack subcommand,
  // but *is* an existing stack name.
  const args = Array.isArray(argv) ? argv : [];
  const positionalIdx = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a) continue;
    if (a === '--') continue;
    if (a.startsWith('-')) continue;
    positionalIdx.push(i);
    if (positionalIdx.length >= 2) break;
  }
  if (positionalIdx.length < 2) return args;

  const [i0, i1] = positionalIdx;
  const first = args[i0];
  const second = args[i1];

  if (isKnownStackCommandToken(first)) return args;
  if (!isKnownStackCommandToken(second)) return args;
  if (typeof stackExists !== 'function' || !stackExists(first)) return args;

  const next = [...args];
  next[i0] = second;
  next[i1] = first;
  return next;
}
