export function getHappysRegistry() {
  /**
   * Command definition shape:
   * - name: primary token users type (e.g. "wt")
   * - aliases: alternative tokens (e.g. ["server-flavor"])
   * - kind: "node" | "external"
   * - scriptRelPath: for kind==="node"
   * - external: { cmd, argsFromRest?: (rest)=>string[] } for kind==="external"
   * - argsFromRest: transform passed to the script (default: identity)
   * - helpArgs: argv passed to show help (default: ["--help"])
   * - rootUsage: optional line(s) for root usage output
   * - description: short one-liner for root commands list
   * - hidden: omit from root help (legacy aliases still work)
   */
  const commands = [
    {
      name: 'init',
      kind: 'node',
      scriptRelPath: 'scripts/init.mjs',
      rootUsage:
        'happys init [--home-dir=PATH] [--workspace-dir=PATH] [--runtime-dir=PATH] [--install-path] [--no-runtime] [--no-bootstrap] [--] [bootstrap args...]',
      description: 'Initialize ~/.happy-stacks (runtime + shims)',
      hidden: true,
    },
    {
      name: 'setup',
      kind: 'node',
      scriptRelPath: 'scripts/setup.mjs',
      rootUsage: 'happys setup [--profile=selfhost|dev] [--json]',
      description: 'Guided setup (selfhost or dev)',
    },
    {
      name: 'setup-pr',
      aliases: ['setupPR', 'setuppr'],
      kind: 'node',
      scriptRelPath: 'scripts/setup_pr.mjs',
      rootUsage: 'happys setup-pr --happy=<pr-url|number> [--happy-server-light=<pr-url|number>] [--dev|--start] [--json] [-- ...]',
      description: 'One-shot: set up + run a PR stack (maintainer-friendly)',
    },
    {
      name: 'review-pr',
      aliases: ['reviewPR', 'reviewpr'],
      kind: 'node',
      scriptRelPath: 'scripts/review_pr.mjs',
      rootUsage: 'happys review-pr --happy=<pr-url|number> [--happy-server-light=<pr-url|number>] [--dev|--start] [--json] [-- ...]',
      description: 'Run setup-pr in a temporary sandbox (auto-cleaned)',
    },
    {
      name: 'uninstall',
      kind: 'node',
      scriptRelPath: 'scripts/uninstall.mjs',
      rootUsage: 'happys uninstall [--remove-workspace] [--remove-stacks] [--yes] [--json]',
      description: 'Remove ~/.happy-stacks and related files',
    },
    {
      name: 'where',
      kind: 'node',
      scriptRelPath: 'scripts/where.mjs',
      rootUsage: 'happys where [--json]',
      description: 'Show resolved paths and env sources',
    },
    {
      name: 'env',
      kind: 'node',
      scriptRelPath: 'scripts/env.mjs',
      rootUsage: 'happys env set KEY=VALUE [KEY2=VALUE2...]   (defaults to main stack)',
      description: 'Set per-stack env vars (defaults to main)',
    },
    {
      name: 'bootstrap',
      kind: 'node',
      scriptRelPath: 'scripts/install.mjs',
      rootUsage: 'happys bootstrap [-- ...]',
      description: 'Clone/install components and deps',
      hidden: true,
    },
    {
      name: 'start',
      kind: 'node',
      scriptRelPath: 'scripts/run.mjs',
      rootUsage: 'happys start [-- ...]',
      description: 'Start local stack (prod-like)',
    },
    {
      name: 'dev',
      kind: 'node',
      scriptRelPath: 'scripts/dev.mjs',
      rootUsage: 'happys dev [-- ...]',
      description: 'Start local stack (dev)',
    },
    {
      name: 'stop',
      kind: 'node',
      scriptRelPath: 'scripts/stop.mjs',
      rootUsage: 'happys stop [--except-stacks=main,exp1] [--yes] [--aggressive] [--no-docker] [--no-service] [--json]',
      description: 'Stop stacks and related local processes',
    },
    {
      name: 'build',
      kind: 'node',
      scriptRelPath: 'scripts/build.mjs',
      rootUsage: 'happys build [-- ...]',
      description: 'Build UI bundle',
    },
    {
      name: 'review',
      kind: 'node',
      scriptRelPath: 'scripts/review.mjs',
      rootUsage:
        'happys review [component...] [--reviewers=coderabbit,codex] [--base-remote=<remote>] [--base-branch=<branch>] [--base-ref=<ref>] [--json]',
      description: 'Run CodeRabbit/Codex reviews for component worktrees',
    },
    {
      name: 'lint',
      kind: 'node',
      scriptRelPath: 'scripts/lint.mjs',
      rootUsage: 'happys lint [component...] [--json]',
      description: 'Run linters for components',
    },
    {
      name: 'typecheck',
      aliases: ['type-check', 'check-types'],
      kind: 'node',
      scriptRelPath: 'scripts/typecheck.mjs',
      rootUsage: 'happys typecheck [component...] [--json]',
      description: 'Run TypeScript typechecks for components',
    },
    {
      name: 'test',
      kind: 'node',
      scriptRelPath: 'scripts/test.mjs',
      rootUsage: 'happys test [component...] [--json]',
      description: 'Run tests for components',
    },
    {
      name: 'pack',
      kind: 'node',
      scriptRelPath: 'scripts/pack.mjs',
      rootUsage: 'happys pack happy-cli|happy-server [--dir=/abs/path] [--json]',
      description: 'Validate npm pack tarball contents (bundled deps)',
    },
    {
      name: 'ci',
      kind: 'node',
      scriptRelPath: 'scripts/ci.mjs',
      rootUsage: 'happys ci act [--json]',
      description: 'CI helpers (e.g. act)',
    },
    {
      name: 'edison',
      kind: 'node',
      scriptRelPath: 'scripts/edison.mjs',
      rootUsage: 'happys edison [--stack=<name>] -- <edison args...>',
      description: 'Run Edison with Happy Stacks integration',
    },
    {
      name: 'migrate',
      kind: 'node',
      scriptRelPath: 'scripts/migrate.mjs',
      rootUsage: 'happys migrate light-to-server --from-stack=<name> --to-stack=<name> [--include-files] [--force] [--json]',
      description: 'Migrate data between server flavors (experimental)',
    },
    {
      name: 'monorepo',
      kind: 'node',
      scriptRelPath: 'scripts/monorepo.mjs',
      rootUsage: 'happys monorepo port --target=/abs/path/to/monorepo [--branch=port/<name>] [--dry-run] [--3way] [--json]',
      description: 'Port split-repo commits into monorepo (experimental)',
    },
    {
      name: 'import',
      kind: 'node',
      scriptRelPath: 'scripts/import.mjs',
      rootUsage: 'happys import [--json]',
      description: 'Guided: import legacy split repos (and migrate to monorepo)',
    },
    {
      name: 'mobile',
      kind: 'node',
      scriptRelPath: 'scripts/mobile.mjs',
      rootUsage: 'happys mobile [-- ...]',
      description: 'Mobile helper (iOS)',
    },
    {
      name: 'mobile-dev-client',
      aliases: ['dev-client', 'devclient'],
      kind: 'node',
      scriptRelPath: 'scripts/mobile_dev_client.mjs',
      rootUsage: 'happys mobile-dev-client --install [--device=...] [--clean] [--configuration=Debug|Release] [--json]',
      description: 'Install the shared Happy Stacks dev-client app (iOS)',
    },
    {
      name: 'eas',
      kind: 'node',
      scriptRelPath: 'scripts/eas.mjs',
      rootUsage: 'happys eas build [--platform=ios|android|all] [--profile=production] [--local] [--no-wait] [--json] [-- <extra eas args...>]',
      description: 'EAS Build wrapper (uses stack env when scoped)',
    },
    {
      name: 'doctor',
      kind: 'node',
      scriptRelPath: 'scripts/doctor.mjs',
      rootUsage: 'happys doctor [--fix] [--json]',
      description: 'Diagnose/fix local setup',
    },
    {
      name: 'tui',
      kind: 'node',
      scriptRelPath: 'scripts/tui.mjs',
      rootUsage: 'happys tui <happys args...> [--json]',
      description: 'Run happys commands in a split-pane TUI',
    },
    {
      name: 'self',
      kind: 'node',
      scriptRelPath: 'scripts/self.mjs',
      rootUsage: 'happys self status|update|check [--json]',
      description: 'Runtime install + self-update',
    },
    {
      name: 'auth',
      kind: 'node',
      scriptRelPath: 'scripts/auth.mjs',
      rootUsage: 'happys auth status|login [--json]',
      description: 'CLI auth helper',
    },
    {
      name: 'happy',
      kind: 'node',
      scriptRelPath: 'scripts/happy.mjs',
      rootUsage: 'happys happy <happy-cli args...>',
      description: 'Run happy-cli against this stack',
    },
    {
      name: 'wt',
      kind: 'node',
      scriptRelPath: 'scripts/worktrees.mjs',
      rootUsage: 'happys wt <args...>',
      description: 'Worktrees across components',
    },
    {
      name: 'srv',
      aliases: ['server-flavor'],
      kind: 'node',
      scriptRelPath: 'scripts/server_flavor.mjs',
      rootUsage: 'happys srv <status|use ...>',
      description: 'Select server flavor',
    },
    {
      name: 'stack',
      kind: 'node',
      scriptRelPath: 'scripts/stack.mjs',
      rootUsage: 'happys stack <args...>',
      description: 'Multiple isolated stacks',
    },
    {
      name: 'tailscale',
      kind: 'node',
      scriptRelPath: 'scripts/tailscale.mjs',
      rootUsage: 'happys tailscale <status|enable|disable|url ...>',
      description: 'Tailscale Serve (HTTPS secure context)',
    },
    {
      name: 'service',
      kind: 'node',
      scriptRelPath: 'scripts/service.mjs',
      rootUsage: 'happys service <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
      description: 'LaunchAgent service management',
    },
    {
      name: 'menubar',
      kind: 'node',
      scriptRelPath: 'scripts/menubar.mjs',
      rootUsage: 'happys menubar <install|uninstall|open>',
      description: 'SwiftBar menu bar plugin',
    },
    {
      name: 'completion',
      kind: 'node',
      scriptRelPath: 'scripts/completion.mjs',
      rootUsage: 'happys completion <print|install> [--shell=zsh|bash|fish] [--json]',
      description: 'Shell completions (optional)',
    },

    // ---- Legacy aliases (hidden) ----
    { name: 'stack:doctor', kind: 'node', scriptRelPath: 'scripts/doctor.mjs', hidden: true },
    { name: 'stack:fix', kind: 'node', scriptRelPath: 'scripts/doctor.mjs', argsFromRest: (rest) => ['--fix', ...rest], hidden: true },

    { name: 'cli:link', kind: 'node', scriptRelPath: 'scripts/cli-link.mjs', hidden: true },
    { name: 'logs', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['logs', ...rest], hidden: true },
    { name: 'logs:tail', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['tail', ...rest], hidden: true },

    {
      name: 'service:status',
      kind: 'node',
      scriptRelPath: 'scripts/service.mjs',
      argsFromRest: (rest) => ['status', ...rest],
      hidden: true,
    },
    { name: 'service:start', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['start', ...rest], hidden: true },
    { name: 'service:stop', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['stop', ...rest], hidden: true },
    { name: 'service:restart', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['restart', ...rest], hidden: true },
    { name: 'service:enable', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['enable', ...rest], hidden: true },
    { name: 'service:disable', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['disable', ...rest], hidden: true },
    { name: 'service:install', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['install', ...rest], hidden: true },
    { name: 'service:uninstall', kind: 'node', scriptRelPath: 'scripts/service.mjs', argsFromRest: (rest) => ['uninstall', ...rest], hidden: true },

    { name: 'tailscale:status', kind: 'node', scriptRelPath: 'scripts/tailscale.mjs', argsFromRest: (rest) => ['status', ...rest], hidden: true },
    { name: 'tailscale:enable', kind: 'node', scriptRelPath: 'scripts/tailscale.mjs', argsFromRest: (rest) => ['enable', ...rest], hidden: true },
    { name: 'tailscale:disable', kind: 'node', scriptRelPath: 'scripts/tailscale.mjs', argsFromRest: (rest) => ['disable', ...rest], hidden: true },
    { name: 'tailscale:reset', kind: 'node', scriptRelPath: 'scripts/tailscale.mjs', argsFromRest: (rest) => ['reset', ...rest], hidden: true },
    { name: 'tailscale:url', kind: 'node', scriptRelPath: 'scripts/tailscale.mjs', argsFromRest: (rest) => ['url', ...rest], hidden: true },

    { name: 'menubar:install', kind: 'node', scriptRelPath: 'scripts/menubar.mjs', argsFromRest: (rest) => ['menubar:install', ...rest], hidden: true },
    { name: 'menubar:uninstall', kind: 'node', scriptRelPath: 'scripts/menubar.mjs', argsFromRest: (rest) => ['menubar:uninstall', ...rest], hidden: true },
    { name: 'menubar:open', kind: 'node', scriptRelPath: 'scripts/menubar.mjs', argsFromRest: (rest) => ['menubar:open', ...rest], hidden: true },

    { name: 'mobile:prebuild', kind: 'node', scriptRelPath: 'scripts/mobile.mjs', argsFromRest: (rest) => ['--prebuild', '--clean', '--no-metro', ...rest], hidden: true },
    { name: 'mobile:ios', kind: 'node', scriptRelPath: 'scripts/mobile.mjs', argsFromRest: (rest) => ['--run-ios', '--no-metro', ...rest], hidden: true },
    {
      name: 'mobile:ios:release',
      kind: 'node',
      scriptRelPath: 'scripts/mobile.mjs',
      argsFromRest: (rest) => ['--run-ios', '--no-metro', '--configuration=Release', ...rest],
      hidden: true,
    },
    {
      name: 'mobile:install',
      kind: 'node',
      scriptRelPath: 'scripts/mobile.mjs',
      argsFromRest: (rest) => ['--run-ios', '--no-metro', '--configuration=Release', ...rest],
      hidden: true,
    },
    {
      name: 'mobile:devices',
      kind: 'external',
      external: { cmd: 'xcrun', argsFromRest: () => ['xcdevice', 'list'] },
      hidden: true,
    },
  ];

  return { commands };
}

export function resolveHappysCommand(cmd) {
  const registry = getHappysRegistry();
  const map = new Map();
  for (const c of registry.commands) {
    map.set(c.name, c);
    for (const a of c.aliases ?? []) {
      map.set(a, c);
    }
  }
  return map.get(cmd) ?? null;
}

export function commandHelpArgs(cmd) {
  const c = resolveHappysCommand(cmd);
  if (!c) return null;
  return c.helpArgs ?? ['--help'];
}

import { ansiEnabled, bold, cyan, dim } from '../ui/ansi.mjs';

export function renderHappysRootHelp() {
  const { commands } = getHappysRegistry();
  const visible = commands.filter((c) => !c.hidden);

  const usageLines = [];
  for (const c of visible) {
    if (!c.rootUsage) continue;
    if (Array.isArray(c.rootUsage)) usageLines.push(...c.rootUsage);
    else usageLines.push(c.rootUsage);
  }

  const rows = visible
    .filter((c) => c.description)
    .map((c) => ({ name: c.name, desc: c.description }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const pad = rows.reduce((m, r) => Math.max(m, r.name.length), 0);
  const commandsLines = rows.map((r) => {
    const name = ansiEnabled() ? cyan(r.name) : r.name;
    const desc = ansiEnabled() ? dim(r.desc) : r.desc;
    return `  ${name.padEnd(pad + (ansiEnabled() ? 9 : 0))}  ${desc}`;
  });

  return [
    ansiEnabled() ? bold(`${cyan('happys')} — Happy Stacks CLI`) : 'happys - Happy Stacks CLI',
    '',
    ansiEnabled() ? bold('global flags:') : 'global flags:',
    `  ${ansiEnabled() ? cyan('--sandbox-dir') : '--sandbox-dir'} PATH   ${ansiEnabled() ? dim('Run fully isolated under PATH (no writes to your real ~/.happy-stacks or ~/.happy/stacks)') : 'Run fully isolated under PATH (no writes to your real ~/.happy-stacks or ~/.happy/stacks)'}`,
    '',
    ansiEnabled() ? bold('usage:') : 'usage:',
    ...usageLines.map((l) => `  ${l}`),
    '',
    ansiEnabled() ? bold('stack shorthand:') : 'stack shorthand:',
    '  happys <stack> <command> ...   (equivalent to: happys stack <command> <stack> ...)',
    '',
    ansiEnabled() ? bold('commands:') : 'commands:',
    ...commandsLines,
    '',
    ansiEnabled() ? bold('help:') : 'help:',
    '  happys help [command]',
  ].join('\n');
}
