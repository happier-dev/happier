export function gethstackRegistry() {
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
        'hstack init [--home-dir=PATH] [--workspace-dir=PATH] [--runtime-dir=PATH] [--install-path] [--no-runtime] [--no-bootstrap] [--] [bootstrap args...]',
      description: 'Initialize ~/.happier-stack (runtime + shims)',
      hidden: true,
    },
    {
      name: 'setup',
      kind: 'node',
      scriptRelPath: 'scripts/setup.mjs',
      rootUsage: 'hstack setup [--profile=selfhost|dev] [--json]',
      description: 'Guided setup (selfhost or dev)',
    },
    {
      name: 'contrib',
      kind: 'node',
      scriptRelPath: 'scripts/contrib.mjs',
      rootUsage: 'hstack contrib status|ensure-dev|sync|extract [--json]',
      description: 'Contributor workflows (dev checkout + branch extraction)',
    },
    {
      name: 'tools',
      kind: 'node',
      scriptRelPath: 'scripts/tools.mjs',
      rootUsage: 'hstack tools <tool> [-- ...]',
      description: 'Maintainer tools (setup-pr, review-pr, import, review, edison)',
    },
    {
      name: 'setup-pr',
      aliases: ['setupPR', 'setuppr'],
      kind: 'node',
      scriptRelPath: 'scripts/setup_pr.mjs',
      rootUsage: 'hstack setup-pr --repo=<pr-url|number> [--dev|--start] [--json] [-- ...]',
      description: 'One-shot: set up + run a PR stack (maintainer-friendly)',
      hidden: true,
    },
    {
      name: 'review-pr',
      aliases: ['reviewPR', 'reviewpr'],
      kind: 'node',
      scriptRelPath: 'scripts/review_pr.mjs',
      rootUsage: 'hstack review-pr --repo=<pr-url|number> [--dev|--start] [--json] [-- ...]',
      description: 'Run setup-pr in a temporary sandbox (auto-cleaned)',
      hidden: true,
    },
    {
      name: 'uninstall',
      kind: 'node',
      scriptRelPath: 'scripts/uninstall.mjs',
      rootUsage: 'hstack uninstall [--remove-workspace] [--remove-stacks] [--yes] [--json]',
      description: 'Remove ~/.happier-stack and related files',
    },
    {
      name: 'where',
      kind: 'node',
      scriptRelPath: 'scripts/where.mjs',
      rootUsage: 'hstack where [--json]',
      description: 'Show resolved paths and env sources',
    },
    {
      name: 'env',
      kind: 'node',
      scriptRelPath: 'scripts/env.mjs',
      rootUsage: 'hstack env set KEY=VALUE [KEY2=VALUE2...]   (defaults to main stack)',
      description: 'Set per-stack env vars (defaults to main)',
    },
    {
      name: 'bootstrap',
      kind: 'node',
      scriptRelPath: 'scripts/install.mjs',
      rootUsage: 'hstack bootstrap [-- ...]',
      description: 'Clone/install components and deps',
      hidden: true,
    },
    {
      name: 'start',
      kind: 'node',
      scriptRelPath: 'scripts/run.mjs',
      rootUsage: 'hstack start [-- ...]',
      description: 'Start local stack (prod-like)',
    },
    {
      name: 'dev',
      kind: 'node',
      scriptRelPath: 'scripts/dev.mjs',
      rootUsage: 'hstack dev [-- ...]',
      description: 'Start local stack (dev)',
    },
    {
      name: 'stop',
      kind: 'node',
      scriptRelPath: 'scripts/stop.mjs',
      rootUsage: 'hstack stop [--except-stacks=main,exp1] [--yes] [--aggressive] [--no-docker] [--no-service] [--json]',
      description: 'Stop stacks and related local processes',
    },
    {
      name: 'build',
      kind: 'node',
      scriptRelPath: 'scripts/build.mjs',
      rootUsage: 'hstack build [-- ...]',
      description: 'Build UI bundle',
    },
    {
      name: 'review',
      kind: 'node',
      scriptRelPath: 'scripts/review.mjs',
      rootUsage:
        'hstack tools review [ui|cli|server|all] [--reviewers=coderabbit,codex,augment] [--base-remote=<remote>] [--base-branch=<branch>] [--base-ref=<ref>] [--json]',
      description: 'Run LLM reviews (maintainer tool)',
      hidden: true,
    },
    {
      name: 'lint',
      kind: 'node',
      scriptRelPath: 'scripts/lint.mjs',
      rootUsage: 'hstack lint [ui|cli|server|all] [--json]',
      description: 'Run linters (ui/cli/server)',
    },
    {
      name: 'typecheck',
      aliases: ['type-check', 'check-types'],
      kind: 'node',
      scriptRelPath: 'scripts/typecheck.mjs',
      rootUsage: 'hstack typecheck [ui|cli|server|all] [--json]',
      description: 'Run TypeScript typechecks (ui/cli/server)',
    },
	    {
	      name: 'test',
	      kind: 'node',
	      scriptRelPath: 'scripts/test_cmd.mjs',
	      rootUsage: 'hstack test [ui|cli|server|all|stacks] [--json]',
	      description: 'Run tests (ui/cli/server + stacks)',
	    },
    {
      name: 'pack',
      kind: 'node',
      scriptRelPath: 'scripts/pack.mjs',
      rootUsage: 'hstack pack cli|server|ui [--dir=/abs/path] [--json]',
      description: 'Validate npm pack tarball contents (best-effort)',
    },
    {
      name: 'ci',
      kind: 'node',
      scriptRelPath: 'scripts/ci.mjs',
      rootUsage: 'hstack ci act [--json]',
      description: 'CI helpers (e.g. act)',
    },
    {
      name: 'edison',
      kind: 'node',
      scriptRelPath: 'scripts/edison.mjs',
      rootUsage: 'hstack edison [--stack=<name>] -- <edison args...>',
      description: 'Run Edison with hstack integration',
      hidden: true,
    },
    {
      name: 'migrate',
      kind: 'node',
      scriptRelPath: 'scripts/migrate.mjs',
      rootUsage: 'hstack migrate light-to-server --from-stack=<name> --to-stack=<name> [--include-files] [--force] [--json]',
      description: 'Migrate data between server flavors (experimental)',
    },
    {
      name: 'monorepo',
      kind: 'node',
      scriptRelPath: 'scripts/monorepo.mjs',
      rootUsage: 'hstack monorepo port --target=/abs/path/to/monorepo [--branch=port/<name>] [--dry-run] [--3way] [--json]',
      description: 'Port split-repo commits into monorepo (experimental)',
    },
    {
      name: 'import',
      kind: 'node',
      scriptRelPath: 'scripts/import.mjs',
      rootUsage: 'hstack import [--json]',
      description: 'Guided: import legacy split repos (and migrate to monorepo)',
      hidden: true,
    },
    {
      name: 'mobile',
      kind: 'node',
      scriptRelPath: 'scripts/mobile.mjs',
      rootUsage: 'hstack mobile [-- ...]',
      description: 'Mobile helper (iOS)',
    },
    {
      name: 'mobile-dev-client',
      aliases: ['dev-client', 'devclient'],
      kind: 'node',
      scriptRelPath: 'scripts/mobile_dev_client.mjs',
      rootUsage: 'hstack mobile-dev-client --install [--device=...] [--clean] [--configuration=Debug|Release] [--json]',
      description: 'Install the shared hstack dev-client app (iOS)',
    },
    {
      name: 'eas',
      kind: 'node',
      scriptRelPath: 'scripts/eas.mjs',
      rootUsage: 'hstack eas build [--platform=ios|android|all] [--profile=production] [--local] [--no-wait] [--json] [-- <extra eas args...>]',
      description: 'EAS Build wrapper (uses stack env when scoped)',
    },
    {
      name: 'doctor',
      kind: 'node',
      scriptRelPath: 'scripts/doctor.mjs',
      rootUsage: 'hstack doctor [--fix] [--json]',
      description: 'Diagnose/fix local setup',
    },
    {
      name: 'tui',
      kind: 'node',
      scriptRelPath: 'scripts/tui.mjs',
      rootUsage: 'hstack tui <hstack args...> [--json]',
      description: 'Run hstack commands in a split-pane TUI',
    },
    {
      name: 'self',
      kind: 'node',
      scriptRelPath: 'scripts/self.mjs',
      rootUsage: 'hstack self status|update|check [--json]',
      description: 'Runtime install + self-update',
    },
    {
      name: 'auth',
      kind: 'node',
      scriptRelPath: 'scripts/auth.mjs',
      rootUsage: 'hstack auth status|login|seed|copy-from|dev-key [--json]',
      description: 'Auth helpers (login + dev-auth seeding)',
    },
    {
      name: 'happier',
      kind: 'node',
      scriptRelPath: 'scripts/happier.mjs',
      rootUsage: 'hstack happier <happier-cli args...>',
      description: 'Run the Happier CLI against this stack',
    },
    {
      name: 'wt',
      kind: 'node',
      scriptRelPath: 'scripts/worktrees.mjs',
      rootUsage: 'hstack wt <args...>',
      description: 'Worktrees (Happier monorepo)',
    },
    {
      name: 'srv',
      aliases: ['server-flavor'],
      kind: 'node',
      scriptRelPath: 'scripts/server_flavor.mjs',
      rootUsage: 'hstack srv <status|use ...>',
      description: 'Select server flavor',
    },
    {
      name: 'stack',
      kind: 'node',
      scriptRelPath: 'scripts/stack.mjs',
      rootUsage: 'hstack stack <args...>',
      description: 'Multiple isolated stacks',
    },
    {
      name: 'tailscale',
      kind: 'node',
      scriptRelPath: 'scripts/tailscale.mjs',
      rootUsage: 'hstack tailscale <status|enable|disable|url ...>',
      description: 'Tailscale Serve (HTTPS secure context)',
    },
    {
      name: 'service',
      kind: 'node',
      scriptRelPath: 'scripts/service.mjs',
      rootUsage: 'hstack service <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
      description: 'LaunchAgent service management',
    },
    {
      name: 'menubar',
      kind: 'node',
      scriptRelPath: 'scripts/menubar.mjs',
      rootUsage: 'hstack menubar <install|uninstall|open>',
      description: 'SwiftBar menu bar plugin',
    },
    {
      name: 'completion',
      kind: 'node',
      scriptRelPath: 'scripts/completion.mjs',
      rootUsage: 'hstack completion <print|install> [--shell=zsh|bash|fish] [--json]',
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

export function resolvehstackCommand(cmd) {
  const registry = gethstackRegistry();
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
  const c = resolvehstackCommand(cmd);
  if (!c) return null;
  return c.helpArgs ?? ['--help'];
}

import { ansiEnabled, bold, cyan, dim } from '../ui/ansi.mjs';

export function renderhstackRootHelp() {
  const { commands } = gethstackRegistry();
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
    ansiEnabled() ? bold(`${cyan('hstack')} — hstack (Happier Stack) CLI`) : 'hstack - hstack (Happier Stack) CLI',
    '',
    ansiEnabled() ? bold('global flags:') : 'global flags:',
    `  ${ansiEnabled() ? cyan('--sandbox-dir') : '--sandbox-dir'} PATH   ${ansiEnabled() ? dim('Run fully isolated under PATH (no writes to your real ~/.happier-stack or ~/.happier/stacks)') : 'Run fully isolated under PATH (no writes to your real ~/.happier-stack or ~/.happier/stacks)'}`,
    '',
    ansiEnabled() ? bold('usage:') : 'usage:',
    ...usageLines.map((l) => `  ${l}`),
    '',
    ansiEnabled() ? bold('stack shorthand:') : 'stack shorthand:',
    '  hstack <stack> <command> ...   (equivalent to: hstack stack <command> <stack> ...)',
    '',
    ansiEnabled() ? bold('commands:') : 'commands:',
    ...commandsLines,
    '',
    ansiEnabled() ? bold('help:') : 'help:',
    '  hstack help [command]',
  ].join('\n');
}
