import { prompt, promptSelect, promptWorktreeSource } from '../cli/wizard.mjs';
import { bold, cyan, dim, green } from '../ui/ansi.mjs';

function wantsNo(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'n' || v === 'no' || v === '0' || v === 'false';
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
        { label: `happy-server-light (${green('recommended')}) — simplest local install (SQLite)`, value: 'happy-server-light' },
        { label: `happy-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happy-server' },
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
    // eslint-disable-next-line no-console
    console.log(dim(`New worktrees are typically based on ${cyan('upstream')} (clean PR history).`));
    out.createRemote = await promptFn(rl, `${dim('Git remote for new worktrees')} (default: upstream): `, { defaultValue: 'upstream' });
  }

  if (out.repo == null) {
    // NOTE: promptWorktreeSource is still component-named internally; for hstack, this is the monorepo checkout.
    out.repo = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happy',
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
      { label: `happy-server-light (${green('recommended')}) — simplest local install (SQLite)`, value: 'happy-server-light' },
      { label: `happy-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happy-server' },
    ],
    defaultIndex: (currentServer || 'happy-server-light') === 'happy-server' ? 1 : 0,
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
  out.createRemote = await promptFn(rl, `${dim('Git remote for new worktrees')} (default: ${currentRemote || 'upstream'}): `, {
    defaultValue: currentRemote || 'upstream',
  });

  out.repo = await promptWorktreeSourceFn({
    rl,
    rootDir,
    component: 'happy',
    stackName,
    createRemote: out.createRemote,
  });

  return out;
}
