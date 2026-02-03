import './utils/env/env.mjs';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { banner, bullets, cmd, kv, sectionTitle } from './utils/ui/layout.mjs';
import { bold, cyan, dim, green, red, yellow } from './utils/ui/ansi.mjs';
import { getDevRepoDir, getRootDir } from './utils/paths/paths.mjs';
import { ensureDevCheckout, resolveDevBranchName, resolveDevPushRemote, resolveDevSyncRemote } from './utils/git/dev_checkout.mjs';
import { parseGithubOwnerRepo } from './utils/git/worktrees.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';

function sanitizeBranchSlug(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

async function gitStatusPorcelain(cwd) {
  try {
    return (await runCapture('git', ['status', '--porcelain=v1'], { cwd })).trim();
  } catch {
    return '';
  }
}

async function parseRemoteOwnerRepo({ repoDir, remoteName }) {
  try {
    const url = (await runCapture('git', ['remote', 'get-url', remoteName], { cwd: repoDir })).trim();
    return parseGithubOwnerRepo(url);
  } catch {
    return null;
  }
}

async function computePrUrl({ repoDir, baseBranch, headBranch }) {
  const base = (await parseRemoteOwnerRepo({ repoDir, remoteName: 'upstream' })) ?? (await parseRemoteOwnerRepo({ repoDir, remoteName: 'origin' }));
  const head = (await parseRemoteOwnerRepo({ repoDir, remoteName: 'origin' })) ?? base;
  if (!base?.owner || !base?.repo) return null;
  if (!head?.owner) return null;

  const baseRef = String(baseBranch ?? '').trim() || 'dev';
  const headRef = String(headBranch ?? '').trim();
  if (!headRef) return null;

  // GitHub compare URL for PR creation (targets base=<baseRef> on base repo).
  // When head owner differs, include owner prefix. When same, it still works.
  return `https://github.com/${base.owner}/${base.repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(
    head.owner
  )}:${encodeURIComponent(headRef)}?expand=1`;
}

async function cmdEnsureDev({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const remoteFlag = String(kv.get('--remote') ?? '').trim();
  const res = await ensureDevCheckout({ rootDir, env: process.env, remote: remoteFlag });
  printResult({
    json,
    data: res,
    text: res.created ? `${green('✓')} created dev checkout at ${cyan(res.devDir)}` : `${green('✓')} dev checkout present ${dim('(')}${cyan(res.devDir)}${dim(')')}`,
  });
}

async function cmdStatus({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const devDir = getDevRepoDir(rootDir, process.env);
  const exists = Boolean(devDir && existsSync(devDir) && existsSync(join(devDir, '.git')));

  let branch = '';
  let head = '';
  let dirty = '';
  if (exists) {
    branch = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: devDir })).trim();
    head = (await runCapture('git', ['rev-parse', '--short', 'HEAD'], { cwd: devDir })).trim();
    dirty = await gitStatusPorcelain(devDir);
  }

  printResult({
    json,
    data: { ok: true, devDir: devDir || null, exists, branch: branch || null, head: head || null, dirty: Boolean(dirty) },
    text: [
      '',
      banner('contrib', { subtitle: 'Contributor workflows (dev checkout + branch extraction).' }),
      '',
      sectionTitle('Dev checkout'),
      bullets([
        kv('dir:', devDir || dim('(unknown)')),
        kv('exists:', exists ? green('yes') : red('no')),
        exists ? kv('branch:', cyan(branch)) : null,
        exists ? kv('head:', cyan(head)) : null,
        exists ? kv('dirty:', dirty ? yellow('yes') : green('no')) : null,
      ].filter(Boolean)),
      !exists ? `\n${dim('Fix:')} ${cmd('hstack contrib ensure-dev')}` : null,
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function cmdSync({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const remoteFlag = String(kv.get('--remote') ?? '').trim();
  const hardReset = flags.has('--hard-reset');
  const force = flags.has('--force');

  const { devDir, devBranch, mainDir } = await ensureDevCheckout({ rootDir, env: process.env, remote: remoteFlag });
  const chosenRemote = await resolveDevSyncRemote({ repoDir: mainDir, env: process.env, preferred: remoteFlag });
  if (!chosenRemote) throw new Error('[contrib sync] no remote available (expected upstream or origin)');

  const dirty = await gitStatusPorcelain(devDir);
  if (dirty && !force) {
    throw new Error(`[contrib sync] dev checkout has uncommitted changes.\nFix: commit/stash, or re-run with --force.`);
  }

  await run('git', ['fetch', chosenRemote, devBranch], { cwd: devDir });
  await run('git', ['checkout', devBranch], { cwd: devDir });
  if (hardReset) {
    await run('git', ['reset', '--hard', `${chosenRemote}/${devBranch}`], { cwd: devDir });
  } else {
    await run('git', ['merge', '--ff-only', `${chosenRemote}/${devBranch}`], { cwd: devDir });
  }

  printResult({
    json,
    data: { ok: true, devDir, devBranch, remote: chosenRemote, hardReset },
    text: `${green('✓')} synced ${cyan(devBranch)} from ${cyan(`${chosenRemote}/${devBranch}`)} ${dim('(')}${cyan(devDir)}${dim(')')}`,
  });
}

async function cmdExtract({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const preferredRemote = String(kv.get('--remote') ?? '').trim();
  const modeFlag = String(kv.get('--mode') ?? '').trim(); // stack|reset
  const push = flags.has('--push');
  const open = flags.has('--open');

  const interactive = isTty();
  const { devDir, devBranch, mainDir } = await ensureDevCheckout({ rootDir, env: process.env, remote: preferredRemote });
  const syncRemote = await resolveDevSyncRemote({ repoDir: mainDir, env: process.env, preferred: preferredRemote });
  const pushRemote = await resolveDevPushRemote({ repoDir: mainDir, env: process.env, preferred: preferredRemote });
  if (!syncRemote) throw new Error('[contrib extract] no sync remote available (expected upstream or origin)');
  if (!pushRemote) throw new Error('[contrib extract] no push remote available (expected origin or upstream)');

  const dirty = await gitStatusPorcelain(devDir);
  if (dirty) {
    throw new Error(`[contrib extract] dev checkout has uncommitted changes.\nFix: commit/stash first.`);
  }

  const positional = argv.filter((a) => !a.startsWith('--'));
  let slug = positional[1] ?? '';
  if (!slug && interactive) {
    slug = await withRl(async (rl) => await prompt(rl, 'Feature name (branch slug): ', { defaultValue: '' }));
  }
  slug = sanitizeBranchSlug(slug);
  if (!slug) {
    throw new Error('[contrib extract] missing feature name.\nUsage: hstack contrib extract <name> [--mode=reset|stack]');
  }

  let mode = modeFlag;
  if (!mode && interactive) {
    mode = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: `${bold('Extract mode')}\n${dim('How should we handle the dev branch after creating the feature branch?')}`,
        options: [
          { label: `${cyan('reset')} — create branch, then reset dev back to remote dev (recommended)`, value: 'reset' },
          { label: `${cyan('stack')} — keep dev as-is (stack PRs on top of each other)`, value: 'stack' },
        ],
        defaultIndex: 0,
      });
    });
  }
  if (!mode) {
    throw new Error('[contrib extract] missing --mode (non-interactive shell).\nPass: --mode=reset|stack');
  }
  if (mode !== 'reset' && mode !== 'stack') {
    throw new Error(`[contrib extract] invalid --mode: ${mode} (expected reset|stack)`);
  }

  const featureBranch = `feature/${slug}`;
  await run('git', ['checkout', devBranch], { cwd: devDir });
  await run('git', ['branch', featureBranch], { cwd: devDir });

  if (push) {
    // Push the feature branch, leaving dev untouched unless mode=reset.
    // Default remote is origin (fork), so contributors don't accidentally try to push to upstream.
    await run('git', ['push', pushRemote, `${featureBranch}:${featureBranch}`], { cwd: devDir });
  }

  if (mode === 'reset') {
    await run('git', ['fetch', syncRemote, devBranch], { cwd: devDir });
    await run('git', ['reset', '--hard', `${syncRemote}/${devBranch}`], { cwd: devDir });
  }

  const prUrl = await computePrUrl({ repoDir: devDir, baseBranch: resolveDevBranchName(process.env), headBranch: featureBranch });
  if (open && prUrl) {
    await openUrlInBrowser(prUrl);
  }

  printResult({
    json,
    data: { ok: true, devDir, devBranch, syncRemote, pushRemote, featureBranch, mode, pushed: push, prUrl: prUrl || null },
    text: [
      `${green('✓')} created ${cyan(featureBranch)} from ${cyan(devBranch)}`,
      mode === 'reset'
        ? `${green('✓')} reset ${cyan(devBranch)} to ${cyan(`${syncRemote}/${devBranch}`)}`
        : `${yellow('!')} kept ${cyan(devBranch)} as-is (stacking PRs)`,
      push
        ? `${green('✓')} pushed ${cyan(featureBranch)} to ${cyan(pushRemote)}`
        : `${dim('Tip:')} ${cmd(`git -C ${devDir} push ${pushRemote} ${featureBranch}:${featureBranch}`)}`,
      prUrl ? `${dim('PR:')} ${prUrl}` : null,
    ].join('\n'),
  });
}

async function cmdPr({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const open = flags.has('--open');

  const positional = argv.filter((a) => !a.startsWith('--'));
  const headBranch = String(positional[1] ?? '').trim();
  if (!headBranch) {
    throw new Error('[contrib pr] missing branch name.\nUsage: hstack contrib pr <branch> [--open]');
  }

  const { devDir } = await ensureDevCheckout({ rootDir, env: process.env });
  const prUrl = await computePrUrl({ repoDir: devDir, baseBranch: resolveDevBranchName(process.env), headBranch });
  if (!prUrl) {
    throw new Error('[contrib pr] unable to compute PR URL (missing/invalid git remotes)');
  }
  if (open) {
    await openUrlInBrowser(prUrl);
  }
  printResult({
    json,
    data: { ok: true, prUrl },
    text: prUrl,
  });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags } = parseArgs(helpScopeArgv);
  const json = wantsJson(helpScopeArgv, { flags });

  const cmdName = helpScopeArgv.find((a) => a && a !== '--' && !a.startsWith('-')) ?? 'help';
  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });

  const usageByCmd = new Map([
    ['status', 'hstack contrib status'],
    ['ensure-dev', 'hstack contrib ensure-dev [--remote=upstream|origin]'],
    ['sync', 'hstack contrib sync [--remote=upstream|origin] [--hard-reset] [--force]'],
    ['extract', 'hstack contrib extract <name> [--mode=reset|stack] [--remote=upstream|origin] [--push] [--open]'],
    ['pr', 'hstack contrib pr <branch> [--open]'],
  ]);

  if (wantsHelpFlag && cmdName !== 'help') {
    const usage = usageByCmd.get(cmdName);
    if (usage) {
      printResult({
        json,
        data: { ok: true, cmd: cmdName, usage },
        text: [`[contrib ${cmdName}] usage:`, `  ${usage}`, '', 'see also:', '  hstack contrib --help'].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmdName === 'help') {
    printResult({
      json,
      data: {
        commands: ['status', 'ensure-dev', 'sync', 'extract', 'pr'],
        flags: ['--remote=upstream|origin', '--hard-reset', '--force', '--mode=reset|stack', '--push', '--open', '--json'],
      },
      text: [
        '[contrib] usage:',
        '  hstack contrib status',
        '  hstack contrib ensure-dev [--remote=upstream|origin]',
        '  hstack contrib sync [--remote=upstream|origin] [--hard-reset] [--force]',
        '  hstack contrib extract <name> [--mode=reset|stack] [--remote=upstream|origin] [--push] [--open]',
        '  hstack contrib pr <branch> [--open]',
      ].join('\n'),
    });
    return;
  }

  if (cmdName === 'status') {
    await cmdStatus({ rootDir, argv });
    return;
  }
  if (cmdName === 'ensure-dev') {
    await cmdEnsureDev({ rootDir, argv });
    return;
  }
  if (cmdName === 'sync') {
    await cmdSync({ rootDir, argv });
    return;
  }
  if (cmdName === 'extract') {
    await cmdExtract({ rootDir, argv });
    return;
  }
  if (cmdName === 'pr') {
    await cmdPr({ rootDir, argv });
    return;
  }

  throw new Error(`[contrib] unknown command: ${cmdName}`);
}

main().catch((err) => {
  console.error('[contrib] failed:', err);
  process.exit(1);
});
