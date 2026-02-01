import './utils/env/env.mjs';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { runCapture } from './utils/proc/proc.mjs';
import { gethstackRegistry } from './utils/cli/cli_registry.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { getHappyStacksHomeDir, getRootDir } from './utils/paths/paths.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { banner, bullets, cmd, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, yellow } from './utils/ui/ansi.mjs';

function detectShell() {
  const raw = (process.env.SHELL ?? '').toLowerCase();
  if (raw.includes('fish')) return 'fish';
  if (raw.includes('bash')) return 'bash';
  return 'zsh';
}

function parseShellArg({ argv, kv }) {
  const fromKv = (kv.get('--shell') ?? '').trim();
  const fromEnv = (process.env.HAPPIER_STACK_SHELL ?? '').trim();
  const raw = fromKv || fromEnv || detectShell();
  const v = raw.toLowerCase();
  if (v === 'zsh' || v === 'bash' || v === 'fish') return v;
  throw new Error(`[completion] invalid --shell: ${raw} (expected: zsh|bash|fish)`);
}

function visibleTopLevelCommands() {
  const { commands } = gethstackRegistry();
  // Hide legacy aliases; include visible primary names and visible aliases.
  const out = [];
  for (const c of commands) {
    if (c.hidden) continue;
    out.push(c.name);
    for (const a of c.aliases ?? []) out.push(a);
  }
  // Deduplicate + stable order.
  return Array.from(new Set(out)).sort();
}

async function helpJsonSubcommands({ cliRootDir, scriptRelPath, fallback = [] }) {
  try {
    const raw = await runCapture(process.execPath, [join(cliRootDir, scriptRelPath), '--help', '--json'], { cwd: cliRootDir });
    const parsed = JSON.parse(raw);
    const cmds = Array.isArray(parsed?.commands) ? parsed.commands : Array.isArray(parsed?.data?.commands) ? parsed.data.commands : null;
    if (Array.isArray(cmds) && cmds.length) {
      return cmds;
    }
  } catch {
    // ignore
  }
  return fallback;
}

function expandStarCommands(cmds, { tailscale = [], service = [] } = {}) {
  const out = [];
  for (const c of cmds) {
    if (c === 'tailscale:*') {
      out.push(...tailscale.map((s) => `tailscale:${s}`));
      continue;
    }
    if (c === 'service:*') {
      out.push(...service.map((s) => `service:${s}`));
      continue;
    }
    out.push(c);
  }
  return Array.from(new Set(out));
}

async function buildCompletionModel({ cliRootDir }) {
  const top = visibleTopLevelCommands();

  const service = await helpJsonSubcommands({ cliRootDir, scriptRelPath: 'scripts/service.mjs', fallback: ['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs', 'tail'] });
  const tailscale = await helpJsonSubcommands({ cliRootDir, scriptRelPath: 'scripts/tailscale.mjs', fallback: ['status', 'enable', 'disable', 'reset', 'url'] });
  const self = await helpJsonSubcommands({ cliRootDir, scriptRelPath: 'scripts/self.mjs', fallback: ['status', 'update', 'check'] });
  const srv = await helpJsonSubcommands({ cliRootDir, scriptRelPath: 'scripts/server_flavor.mjs', fallback: ['status', 'use'] });
  const menubar = await helpJsonSubcommands({ cliRootDir, scriptRelPath: 'scripts/menubar.mjs', fallback: ['install', 'uninstall', 'open'] });
  const wt = await helpJsonSubcommands({
    cliRootDir,
    scriptRelPath: 'scripts/worktrees.mjs',
    fallback: ['migrate', 'sync', 'sync-all', 'list', 'new', 'pr', 'use', 'status', 'update', 'update-all', 'push', 'git', 'shell', 'code', 'cursor'],
  });
  const stackRaw = await helpJsonSubcommands({
    cliRootDir,
    scriptRelPath: 'scripts/stack.mjs',
    fallback: ['new', 'edit', 'list', 'migrate', 'auth', 'dev', 'start', 'build', 'doctor', 'mobile', 'srv', 'wt', 'tailscale:*', 'service:*'],
  });
  const stack = expandStarCommands(stackRaw, { tailscale, service });

  return {
    top,
    groups: {
      wt,
      stack,
      srv,
      service,
      tailscale,
      self,
      menubar,
      completion: ['print', 'install'],
    },
  };
}

function renderZsh(model) {
  const top = model.top.join(' ');
  const group = (name) => (model.groups?.[name] ?? []).join(' ');

  return [
    '#compdef hstack',
    '',
    '_hstack() {',
    '  local -a top',
    `  top=(${top})`,
    '',
    '  local cmd',
    '  cmd="${words[2]:-}"',
    '',
    '  if (( CURRENT == 2 )); then',
    "    _describe -t commands 'hstack command' top",
    '    return',
    '  fi',
    '',
    '  case "$cmd" in',
    `    wt) _describe -t subcommands 'wt subcommand' (${group('wt')}) ;;`,
    `    stack) _describe -t subcommands 'stack subcommand' (${group('stack')}) ;;`,
    `    srv) _describe -t subcommands 'srv subcommand' (${group('srv')}) ;;`,
    `    service) _describe -t subcommands 'service subcommand' (${group('service')}) ;;`,
    `    tailscale) _describe -t subcommands 'tailscale subcommand' (${group('tailscale')}) ;;`,
    `    self) _describe -t subcommands 'self subcommand' (${group('self')}) ;;`,
    `    menubar) _describe -t subcommands 'menubar subcommand' (${group('menubar')}) ;;`,
    `    completion) _describe -t subcommands 'completion subcommand' (${group('completion')}) ;;`,
    '    *) ;;',
    '  esac',
    '}',
    '',
    'compdef _hstack hstack',
    '',
  ].join('\n');
}

function renderBash(model) {
  const quoteList = (arr) => arr.map((s) => s.replace(/"/g, '\\"')).join(' ');
  const top = quoteList(model.top);

  const group = (name) => quoteList(model.groups?.[name] ?? []);
  return [
    '_hstack_completions() {',
    '  local cur prev cmd',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  cmd="${COMP_WORDS[1]}"',
    '',
    '  if [[ $COMP_CWORD -eq 1 ]]; then',
    `    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )`,
    '    return 0',
    '  fi',
    '',
    '  case "$cmd" in',
    `    wt) COMPREPLY=( $(compgen -W "${group('wt')}" -- "$cur") ) ;;`,
    `    stack) COMPREPLY=( $(compgen -W "${group('stack')}" -- "$cur") ) ;;`,
    `    srv) COMPREPLY=( $(compgen -W "${group('srv')}" -- "$cur") ) ;;`,
    `    service) COMPREPLY=( $(compgen -W "${group('service')}" -- "$cur") ) ;;`,
    `    tailscale) COMPREPLY=( $(compgen -W "${group('tailscale')}" -- "$cur") ) ;;`,
    `    self) COMPREPLY=( $(compgen -W "${group('self')}" -- "$cur") ) ;;`,
    `    menubar) COMPREPLY=( $(compgen -W "${group('menubar')}" -- "$cur") ) ;;`,
    `    completion) COMPREPLY=( $(compgen -W "${group('completion')}" -- "$cur") ) ;;`,
    '    *) ;;',
    '  esac',
    '  return 0',
    '}',
    '',
    'complete -F _hstack_completions hstack',
    '',
  ].join('\n');
}

function renderFish(model) {
  const lines = [];
  const add = (cmd, sub = null) => {
    for (const bin of ['hstack']) {
      if (sub) {
        lines.push(`complete -c ${bin} -n '__fish_seen_subcommand_from ${cmd}' -f -a '${sub.join(' ')}'`);
      } else {
        lines.push(`complete -c ${bin} -f -a '${cmd.join(' ')}'`);
      }
    }
  };

  add(model.top);
  add(['wt'], model.groups.wt ?? []);
  add(['stack'], model.groups.stack ?? []);
  add(['srv'], model.groups.srv ?? []);
  add(['service'], model.groups.service ?? []);
  add(['tailscale'], model.groups.tailscale ?? []);
  add(['self'], model.groups.self ?? []);
  add(['menubar'], model.groups.menubar ?? []);
  add(['completion'], model.groups.completion ?? []);

  return lines.join('\n') + '\n';
}

function completionPaths({ homeDir, shell }) {
  const dir = join(homeDir, 'completions');
  if (shell === 'zsh') return { dir, file: join(dir, '_hstack') };
  if (shell === 'bash') return { dir, file: join(dir, 'hstack.bash') };
  return { dir, file: join(dir, 'hstack.fish') };
}

async function ensureShellInstall({ homeDir, shell }) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    return { updated: false, path: null, skipped: 'sandbox' };
  }
  const shellPath = (process.env.SHELL ?? '').toLowerCase();
  const isDarwin = process.platform === 'darwin';

  const zshrc = join(homedir(), '.zshrc');
  const bashrc = join(homedir(), '.bashrc');
  const bashProfile = join(homedir(), '.bash_profile');

  const fishDir = join(homedir(), '.config', 'fish', 'conf.d');
  const fishConf = join(fishDir, 'hstack.fish');

  const markerStart = '# >>> hstack completions >>>';
  const markerEnd = '# <<< hstack completions <<<';

  const completionsDir = join(homeDir, 'completions');
  const shBlock = [
    '',
    markerStart,
    `export HAPPIER_STACK_COMPLETIONS_DIR="${completionsDir}"`,
    `if [[ -d "$HAPPIER_STACK_COMPLETIONS_DIR" ]]; then`,
    `  fpath=("$HAPPIER_STACK_COMPLETIONS_DIR" $fpath)`,
    `  autoload -Uz compinit && compinit`,
    'fi',
    markerEnd,
    '',
  ].join('\n');

  const bashBlock = [
    '',
    markerStart,
    `if [[ -f "${join(completionsDir, 'hstack.bash')}" ]]; then`,
    `  . "${join(completionsDir, 'hstack.bash')}"`,
    'fi',
    markerEnd,
    '',
  ].join('\n');

  const writeIfMissing = async (path, block) => {
    let existing = '';
    try {
      existing = await readFile(path, 'utf-8');
    } catch {
      existing = '';
    }
    if (existing.includes(markerStart)) {
      return { updated: false, path };
    }
    await writeFile(path, existing.replace(/\s*$/, '') + block, 'utf-8');
    return { updated: true, path };
  };

  if (shell === 'fish' || shellPath.includes('fish')) {
    await mkdir(fishDir, { recursive: true });
    const res = await writeIfMissing(fishConf, [
      '',
      markerStart,
      `set -gx HAPPIER_STACK_COMPLETIONS_DIR "${completionsDir}"`,
      markerEnd,
      '',
    ].join('\n'));
    return res;
  }

  if (shell === 'bash' || shellPath.includes('bash')) {
    const target = isDarwin ? bashProfile : bashrc;
    return await writeIfMissing(target, bashBlock);
  }

  // Default to zsh.
  return await writeIfMissing(zshrc, shBlock);
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === 'completion' ? rawArgv.slice(1) : rawArgv;
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] ?? 'help';

  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['print', 'install'], flags: ['--shell=zsh|bash|fish', '--json'] },
      text: [
        banner('completion', { subtitle: 'Shell completions for hstack.' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack completion')} print [--shell=zsh|bash|fish] [--json]`,
        `  ${cyan('hstack completion')} install [--shell=zsh|bash|fish] [--json]`,
        '',
        sectionTitle('notes:'),
        bullets([
          dim('Installs best-effort completions for hstack.'),
          dim('Re-run after upgrading hstack to refresh completions.'),
        ]),
      ].join('\n'),
    });
    return;
  }

  const cliRootDir = getRootDir(import.meta.url);
  const shell = parseShellArg({ argv, kv });

  const model = await buildCompletionModel({ cliRootDir });
  const contents =
    shell === 'zsh' ? renderZsh(model) : shell === 'bash' ? renderBash(model) : renderFish(model);

  const homeDir = getHappyStacksHomeDir();
  const { dir, file } = completionPaths({ homeDir, shell });

  if (cmd === 'print') {
    printResult({
      json,
      data: { ok: true, shell, path: file, bytes: contents.length, homeDir },
      text: json ? null : contents,
    });
    return;
  }

  if (cmd === 'install') {
    await mkdir(dir, { recursive: true });
    await writeFile(file, contents, 'utf-8');

    // fish loads completions automatically; zsh/bash need a tiny shell config hook.
    const hook =
      shell === 'fish'
        ? { updated: false, path: null }
        : await ensureShellInstall({ homeDir, shell });

    printResult({
      json,
      data: { ok: true, shell, file, hook },
      text: [
        `[completion] installed: ${file}`,
        hook?.path ? (hook.updated ? `[completion] enabled via: ${hook.path}` : `[completion] already enabled in: ${hook.path}`) : null,
        hook?.skipped === 'sandbox'
          ? `[completion] note: skipped editing shell rc files (sandbox mode). To enable this, re-run with ${cyan('HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1')}`
          : null,
        `[completion] note: restart your terminal (or source your shell config) to pick it up.`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return;
  }

  throw new Error(`[completion] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[completion] failed:', err);
  process.exit(1);
});
