const STACK_HELP_USAGE_LINES = [
  'hstack stack new <name> [--port=NNN] [--server=happier-server|happier-server-light] [--repo=default|dev|<owner/...>|<path>] [--db-provider=pglite|sqlite|postgres|mysql] [--database-url=<url>] [--interactive] [--non-interactive] [--copy-auth-from=<stack>] [--no-copy-auth] [--force-port] [--json]',
  'hstack stack edit <name> --interactive [--json]',
  'hstack stack list [--json]',
  'hstack stack audit [--fix] [--fix-main] [--fix-ports] [--fix-workspace] [--fix-paths] [--unpin-ports] [--unpin-ports-except=stack1,stack2] [--json]',
  'hstack stack archive <name> [--dry-run] [--date=YYYY-MM-DD] [--json]',
  'hstack stack duplicate <from> <to> [--duplicate-worktrees] [--deps=none|link|install|link-or-install] [--json]',
  'hstack stack info <name> [--json]',
  'hstack stack pr <name> --repo=<pr-url|number> [--server-flavor=light|full] [--dev|--start] [--reuse] [--update] [--force] [--background] [--mobile] [--expo-tailscale] [--json] [-- ...]',
  'hstack stack create-dev-auth-seed [name] [--server=happier-server|happier-server-light] [--login|--no-login] [--skip-default-seed] [--non-interactive] [--json]',
  'hstack stack daemon <name> start|stop|restart|status [--json]',
  'hstack stack happier <name> [-- ...]',
  'hstack stack bug-report <name> [-- ...]',
  'hstack stack env <name> set KEY=VALUE [KEY2=VALUE2...] | unset KEY [KEY2...] | get KEY | list | path [--json]',
  'hstack stack auth <name> status|login|copy-from [--json]',
  'hstack stack dev <name> [-- ...]',
  'hstack stack start <name> [-- ...]',
  'hstack stack build <name> [-- ...]',
  'hstack stack review <name> [component...] [--reviewers=coderabbit,codex] [--base-remote=<remote>] [--base-branch=<branch>] [--base-ref=<ref>] [--chunks|--no-chunks] [--chunking=auto|head-slice|commit-window] [--chunk-max-files=N] [--json]',
  'hstack stack typecheck <name> [component...] [--json]',
  'hstack stack lint <name> [component...] [--json]',
  'hstack stack test <name> [component...] [--json]',
  'hstack stack doctor <name> [-- ...]',
  'hstack stack mobile <name> [-- ...]',
  'hstack stack mobile:install <name> [--name="Happier (exp1)"] [--device=...] [--json]',
  'hstack stack mobile-dev-client <name> --install [--device=...] [--clean] [--configuration=Debug|Release] [--json]',
  'hstack stack resume <name> <sessionId...> [--json]',
  'hstack stack stop <name> [--aggressive] [--sweep-owned] [--no-docker] [--json]',
  'hstack stack code <name> [--no-stack-dir] [--include-all-components] [--include-cli-home] [--json]',
  'hstack stack cursor <name> [--no-stack-dir] [--include-all-components] [--include-cli-home] [--json]',
  'hstack stack open <name> [--no-stack-dir] [--include-all-components] [--include-cli-home] [--json]   # prefer Cursor, else VS Code',
  'hstack stack srv <name> -- status|use ...',
  'hstack stack wt <name> -- <wt args...>',
  'hstack stack tailscale:status|enable|disable|url <name> [-- ...]',
  'hstack stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
  'hstack stack service:* <name>   # legacy alias',
];

export const STACK_HELP_COMMANDS = [
  'new',
  'edit',
  'list',
  'audit',
  'archive',
  'duplicate',
  'info',
  'pr',
  'create-dev-auth-seed',
  'daemon',
  'eas',
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
  'tailscale:*',
  'service:*',
];

const STACK_HELP_USAGE_BY_CMD = (() => {
  const map = new Map();
  for (const line of STACK_HELP_USAGE_LINES) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'hstack' || parts[1] !== 'stack') continue;
    const command = parts[2] ?? '';
    if (command) map.set(command, line);
  }
  return map;
})();

export function getStackHelpUsageLine(cmd) {
  const command = (cmd ?? '').toString().trim();
  if (!command) return null;
  return STACK_HELP_USAGE_BY_CMD.get(command) ?? null;
}

export function renderStackRootHelpText() {
  return ['[stack] usage:', ...STACK_HELP_USAGE_LINES.map((line) => `  ${line}`)].join('\n');
}

export function renderStackSubcommandHelpText(cmd) {
  const command = (cmd ?? '').toString().trim();
  if (!command) return null;

  const lines = [];
  const direct = STACK_HELP_USAGE_BY_CMD.get(command);
  if (direct) lines.push(direct);
  else if (command.startsWith('tailscale:')) lines.push(STACK_HELP_USAGE_BY_CMD.get('tailscale:status|enable|disable|url'));
  else if (command.startsWith('service:')) lines.push(STACK_HELP_USAGE_BY_CMD.get('service:*') || STACK_HELP_USAGE_BY_CMD.get('service'));

  const filtered = lines.filter(Boolean);
  if (!filtered.length) return null;

  return [`[stack ${command}] usage:`, ...filtered.map((line) => `  ${line}`), '', 'see also:', '  hstack stack --help'].join('\n');
}
