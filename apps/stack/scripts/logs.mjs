import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getDefaultAutostartPaths, getStackName, resolveStackBaseDir } from './utils/paths/paths.mjs';
import { getStackRuntimeStatePath, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { readLastLines } from './utils/fs/tail.mjs';
import { banner, bullets, cmd as cmdFmt, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { run } from './utils/proc/proc.mjs';
import { getSystemdUnitInfo } from './utils/paths/paths.mjs';

function coerceInt(raw, fallback) {
  const s = String(raw ?? '').trim();
  const n = s ? Number(s) : null;
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function coerceComponent(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return 'auto';
  if (v === 'all' || v === '*') return 'all';
  if (v === 'runner') return 'runner';
  if (v === 'server') return 'server';
  if (v === 'expo' || v === 'metro') return 'expo';
  if (v === 'ui' || v === 'gateway') return 'ui';
  if (v === 'daemon') return 'daemon';
  if (v === 'service') return 'service';
  if (v === 'auto') return 'auto';
  return 'auto';
}

function resolveLatestFileBySuffix(dir, suffix) {
  try {
    if (!dir || !existsSync(dir)) return null;
    const entries = readdirSync(dir);
    const candidates = [];
    for (const name of entries) {
      if (!name.endsWith(suffix)) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        candidates.push({ path, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

function existingFile(path) {
  try {
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function resolveStackLogPaths({ env, stackName }) {
  const { baseDir } = resolveStackBaseDir(stackName, env);
  const logsDir = join(baseDir, 'logs');
  const cliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? '').toString().trim() || join(baseDir, 'cli');
  const cliLogsDir = join(cliHomeDir, 'logs');

  const service = getDefaultAutostartPaths(env);
  const serverLog = join(logsDir, 'server.log');
  const expoLog = join(logsDir, 'expo.log');
  const uiLog = join(logsDir, 'ui.log');

  return {
    baseDir,
    logsDir,
    cliHomeDir,
    cliLogsDir,
    runner: null, // filled from runtime when available
    server: serverLog,
    expo: expoLog,
    ui: uiLog,
    daemon: resolveLatestFileBySuffix(cliLogsDir, '-daemon.log'),
    serviceOut: service.stdoutPath,
    serviceErr: service.stderrPath,
    systemd: getSystemdUnitInfo({ env, mode: (env.HAPPIER_STACK_SERVICE_MODE ?? '').toString().trim() || 'user' }),
  };
}

function selectAutoComponent(paths) {
  if (existingFile(paths.runner)) return 'runner';
  if (existingFile(paths.server) || existingFile(paths.expo) || existingFile(paths.ui)) return 'all';
  if (existingFile(paths.daemon)) return 'daemon';
  return 'service';
}

function selectedPathsForComponent(component, paths) {
  const c = coerceComponent(component);
  if (c === 'runner') return existingFile(paths.runner) ? [paths.runner] : [];
  if (c === 'server') return existingFile(paths.server) ? [paths.server] : [];
  if (c === 'expo') return existingFile(paths.expo) ? [paths.expo] : [];
  if (c === 'ui') return existingFile(paths.ui) ? [paths.ui] : [];
  if (c === 'daemon') return existingFile(paths.daemon) ? [paths.daemon] : [];
  if (c === 'service') {
    const out = [];
    const err = existingFile(paths.serviceErr);
    const o = existingFile(paths.serviceOut);
    if (err) out.push(err);
    if (o) out.push(o);
    return out;
  }
  if (c === 'all') {
    // Prefer runner log when present (it typically contains the full multiplexed output).
    const runner = existingFile(paths.runner);
    if (runner) return [runner];
    const out = [];
    for (const p of [paths.server, paths.expo, paths.ui, paths.daemon, paths.serviceErr, paths.serviceOut]) {
      const e = existingFile(p);
      if (e) out.push(e);
    }
    return out;
  }
  const auto = selectAutoComponent(paths);
  return selectedPathsForComponent(auto, paths);
}

async function printLastLines({ label, path, lines }) {
  const tail = await readLastLines(path, lines).catch(() => '');
  process.stdout.write(`${sectionTitle(label)}\n`);
  process.stdout.write(`${dim('path:')} ${path}\n`);
  if (!tail.trim()) {
    process.stdout.write(`${dim('(no output)')}\n\n`);
    return;
  }
  process.stdout.write(`${dim('---')}\n`);
  process.stdout.write(tail.trimEnd() + '\n');
  process.stdout.write(`${dim('---')}\n\n`);
}

async function tailFiles({ paths }) {
  // Cross-platform: use tail where available; Linux service logs (journalctl) are handled separately.
  const child = spawn('tail', ['-f', ...paths], { stdio: 'inherit' });
  await new Promise((resolve) => child.on('exit', resolve));
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const helpText = [
    banner('logs', { subtitle: 'Stream or inspect stack logs (runner/server/expo/daemon/service).' }),
    '',
    sectionTitle('usage:'),
    `  ${cyan('hstack logs')} [--component=auto|all|runner|server|expo|ui|daemon|service] [--lines N] [--follow] [--json]`,
    `  ${cyan('hstack logs')} tail [--component=...] [--lines N]`,
    '',
    sectionTitle('notes:'),
    bullets([
      `Default component is ${cyan('auto')}: prefers runner when available, otherwise server/expo/ui, then daemon, then service.`,
      `Server/Expo/UI component logs are written to ${cyan('<stack>/logs/<component>.log')} when log teeing is enabled.`,
      `Service logs reflect the autostart service (launchd/systemd) output, not the dev runner.`,
    ]),
    '',
    sectionTitle('examples:'),
    bullets([
      cmdFmt('hstack logs --component=all --follow'),
      cmdFmt('hstack logs --component=server --lines 200'),
      cmdFmt('hstack logs tail --component=expo'),
    ]),
  ].join('\n');

  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { ok: true, usage: 'hstack logs [--component=...] [--follow] [--lines N] [--json]' }, text: helpText });
    return;
  }

  const positionals = argv.filter((a) => a && !a.startsWith('--'));
  const wantsTailPositional = (positionals[0] ?? '').toString().trim().toLowerCase() === 'tail';

  const follow =
    flags.has('--follow') ||
    flags.has('-f') ||
    wantsTailPositional ||
    (kv.get('--follow') ?? '').toString().trim() === '1';
  const noFollow = flags.has('--no-follow');
  const effectiveFollow = noFollow ? false : Boolean(follow);

  const componentRaw =
    kv.get('--component') ??
    kv.get('--source') ??
    kv.get('--stream') ??
    kv.get('--kind') ??
    '';
  const component = coerceComponent(componentRaw);
  const lines = coerceInt(kv.get('--lines') ?? process.env.HAPPIER_STACK_LOG_LINES ?? '', 120);

  const env = process.env;
  const stackName = getStackName(env);
  const runtimePath = getStackRuntimeStatePath(stackName);
  const runtime = await readStackRuntimeStateFile(runtimePath).catch(() => null);

  const paths = resolveStackLogPaths({ env, stackName });
  paths.runner = existingFile(String(runtime?.logs?.runner ?? '').trim());

  const selectedComponent = component === 'auto' ? selectAutoComponent(paths) : component;
  const selected = selectedPathsForComponent(selectedComponent, paths);

  if (json) {
    printResult({
      json,
      data: {
        ok: true,
        stackName,
        baseDir: paths.baseDir,
        runtimePath,
        sources: {
          runner: { path: paths.runner, exists: Boolean(existingFile(paths.runner)) },
          server: { path: paths.server, exists: Boolean(existingFile(paths.server)) },
          expo: { path: paths.expo, exists: Boolean(existingFile(paths.expo)) },
          ui: { path: paths.ui, exists: Boolean(existingFile(paths.ui)) },
          daemon: { path: paths.daemon, exists: Boolean(existingFile(paths.daemon)) },
          service: { stdoutPath: paths.serviceOut, stderrPath: paths.serviceErr },
        },
        selected: { component: selectedComponent, follow: effectiveFollow, lines, paths: selected },
      },
      text: '',
    });
    return;
  }

  if (!selected.length) {
    const hint = selectedComponent === 'runner'
      ? `No runner log recorded in ${runtimePath}. If you started a stack in the background, rerun it with --background; otherwise use ${cmdFmt('hstack tui')} or ${cmdFmt('hstack logs --component=service')}.`
      : `No log files found for component=${selectedComponent}.`;
    console.log(banner('logs', { subtitle: `stack=${stackName}` }));
    console.log('');
    console.log(bullets([`${yellow('!')} ${hint}`]));
    return;
  }

  console.log(banner('logs', { subtitle: `stack=${stackName}` }));
  console.log(bullets([kv('component:', selectedComponent), kv('follow:', effectiveFollow ? green('yes') : dim('no'))]));
  console.log('');

  // Special-case: Linux service logs are in journald, not files, and `tail` on out/err logs isn't meaningful there.
  if (selectedComponent === 'service' && process.platform === 'linux') {
    const unit = paths.systemd.unitName;
    if (!unit) {
      console.warn('[logs] missing systemd unit name');
      return;
    }
    if (effectiveFollow) {
      await run('journalctl', [...paths.systemd.journalctlArgsPrefix, '-u', unit, '-f']);
    } else {
      await run('journalctl', [...paths.systemd.journalctlArgsPrefix, '-u', unit, '-n', String(lines), '--no-pager']);
    }
    return;
  }

  if (effectiveFollow) {
    await tailFiles({ paths: selected });
    return;
  }

  if (selected.length === 1) {
    await printLastLines({ label: selectedComponent, path: selected[0], lines });
    return;
  }

  for (const p of selected) {
    // eslint-disable-next-line no-await-in-loop
    await printLastLines({ label: selectedComponent, path: p, lines });
  }
}

main().catch((err) => {
  console.error('[logs] failed:', err);
  process.exit(1);
});

