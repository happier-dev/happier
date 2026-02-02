import { prompt, promptSelect, promptWorktreeSource } from '../cli/wizard.mjs';
import { gitCapture, gitOk } from '../git/git.mjs';
import { parseGithubOwnerRepo } from '../git/worktrees.mjs';
import { getRepoDir } from '../paths/paths.mjs';
import { bold, cyan, dim, green } from '../ui/ansi.mjs';

function wantsNo(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'n' || v === 'no' || v === '0' || v === 'false';
}

async function describeGitRemote({ repoDir, remote }) {
  const r = String(remote ?? '').trim();
  if (!repoDir || !r) return '';
  try {
    const url = (await gitCapture({ cwd: repoDir, args: ['remote', 'get-url', r] })).trim();
    if (!url) return '';
    const parsed = parseGithubOwnerRepo(url);
    return parsed ? `${parsed.owner}/${parsed.repo}` : url;
  } catch {
    return '';
  }
}

async function resolveDefaultCreateRemote({ repoDir }) {
  // Prefer upstream when present (clean PR history), else fall back to origin.
  if (await gitOk({ cwd: repoDir, args: ['remote', 'get-url', 'upstream'] })) return 'upstream';
  if (await gitOk({ cwd: repoDir, args: ['remote', 'get-url', 'origin'] })) return 'origin';
  return 'upstream';
}

export async function interactiveNew({ rootDir, rl, defaults, deps = {} }) {
  const promptFn = deps.prompt ?? prompt;
  const promptSelectFn = deps.promptSelect ?? promptSelect;
  const promptWorktreeSourceFn = deps.promptWorktreeSource ?? promptWorktreeSource;

  const out = { ...defaults };

  if (!out.stackName) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Create a stack'));
    // eslint-disable-next-line no-console
    console.log(dim('Stacks are isolated local environments (ports + dirs + DB + CLI home).'));
    out.stackName = (await rl.question(`${dim('Stack name')}: `)).trim();
  }
  if (!out.stackName) {
    throw new Error('[stack] stack name is required');
  }
  if (out.stackName === 'main') {
    throw new Error('[stack] stack name "main" is reserved (use the default stack without creating it)');
  }

  if (!out.serverComponent) {
    out.serverComponent = await promptSelectFn(rl, {
      title: `${bold('Server flavor')}\n${dim('Pick the backend this stack should run. You can switch later with `stack srv`.')}`,
      options: [
        { label: `happier-server-light (${green('recommended')}) — simplest local install (SQLite)`, value: 'happier-server-light' },
        { label: `happier-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happier-server' },
      ],
      defaultIndex: 0,
    });
  }

  if (!out.port) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Ports'));
    // eslint-disable-next-line no-console
    console.log(dim('Tip: leaving this empty uses an ephemeral port (recommended for non-main stacks).'));
    const want = (await rl.question(`${dim('Port')} (empty = ephemeral): `)).trim();
    out.port = want ? Number(want) : null;
  }

  if (!out.createRemote) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Worktrees'));
    const mainDir = getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
    const upstreamRepo = await describeGitRemote({ repoDir: mainDir, remote: 'upstream' });
    const originRepo = await describeGitRemote({ repoDir: mainDir, remote: 'origin' });
    const defaultRemote = await resolveDefaultCreateRemote({ repoDir: mainDir });

    // eslint-disable-next-line no-console
    console.log(
      dim(`New worktrees are typically based on ${cyan('upstream')}${upstreamRepo ? ` (${upstreamRepo})` : ''} (clean PR history).`)
    );
    if (upstreamRepo || originRepo) {
      // eslint-disable-next-line no-console
      console.log(dim(`Remotes: ${upstreamRepo ? `upstream=${upstreamRepo}` : 'upstream=(missing)'}, ${originRepo ? `origin=${originRepo}` : 'origin=(missing)'}`));
    }

    out.createRemote = await promptFn(rl, `${dim('Git remote for new worktrees')} (default: ${defaultRemote}): `, { defaultValue: defaultRemote });
  }

  if (out.repo == null) {
    // NOTE: promptWorktreeSource is still component-named internally; for hstack, this is the monorepo checkout.
    out.repo = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happier-ui',
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  return out;
}

export async function interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults, deps = {} }) {
  const promptFn = deps.prompt ?? prompt;
  const promptSelectFn = deps.promptSelect ?? promptSelect;
  const promptWorktreeSourceFn = deps.promptWorktreeSource ?? promptWorktreeSource;

  const out = { ...defaults, stackName };

  const currentServer = existingEnv.HAPPIER_STACK_SERVER_COMPONENT ?? '';
  out.serverComponent = await promptSelectFn(rl, {
    title: `${bold('Server flavor')}\n${dim('Pick the backend this stack should run. You can switch again later.')}`,
    options: [
      { label: `happier-server-light (${green('recommended')}) — simplest local install (SQLite)`, value: 'happier-server-light' },
      { label: `happier-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happier-server' },
    ],
    defaultIndex: (currentServer || 'happier-server-light') === 'happier-server' ? 1 : 0,
  });

  const currentPort = existingEnv.HAPPIER_STACK_SERVER_PORT ?? '';
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('Ports'));
  const wantPort = await promptFn(rl, `${dim(`Port`)} (empty = keep ${currentPort || 'ephemeral'}; type 'ephemeral' to unpin): `, { defaultValue: '' });
  const wantTrimmed = wantPort.trim().toLowerCase();
  out.port = wantTrimmed === 'ephemeral' ? null : wantPort ? Number(wantPort) : currentPort ? Number(currentPort) : null;

  const currentRemote = existingEnv.HAPPIER_STACK_STACK_REMOTE ?? '';
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('Worktrees'));
  const mainDir = getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
  const upstreamRepo = await describeGitRemote({ repoDir: mainDir, remote: 'upstream' });
  const originRepo = await describeGitRemote({ repoDir: mainDir, remote: 'origin' });
  if (upstreamRepo || originRepo) {
    // eslint-disable-next-line no-console
    console.log(dim(`Remotes: ${upstreamRepo ? `upstream=${upstreamRepo}` : 'upstream=(missing)'}, ${originRepo ? `origin=${originRepo}` : 'origin=(missing)'}`));
  }
  const defaultRemote = (currentRemote || (await resolveDefaultCreateRemote({ repoDir: mainDir })) || 'upstream').trim();
  out.createRemote = await promptFn(rl, `${dim('Git remote for new worktrees')} (default: ${defaultRemote}): `, {
    defaultValue: defaultRemote,
  });

  out.repo = await promptWorktreeSourceFn({
    rl,
    rootDir,
    component: 'happier-ui',
    stackName,
    createRemote: out.createRemote,
  });

  return out;
}
