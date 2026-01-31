import { join, resolve } from 'node:path';

import { prompt, promptSelect, promptWorktreeSource } from '../cli/wizard.mjs';
import { coerceHappyMonorepoRootFromPath, getComponentsDir } from '../paths/paths.mjs';
import { resolveComponentSpecToDir } from '../git/worktrees.mjs';
import { bold, cyan, dim, green } from '../ui/ansi.mjs';

function wantsNo(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'n' || v === 'no' || v === '0' || v === 'false';
}

function resolveHappySpecDir({ rootDir, spec }) {
  if (!spec) return '';
  if (spec === 'default' || spec === 'main') {
    return join(getComponentsDir(rootDir), 'happy');
  }
  if (typeof spec === 'string') {
    const dir = resolveComponentSpecToDir({ rootDir, component: 'happy', spec });
    return dir ? resolve(rootDir, dir) : '';
  }
  return '';
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

  if (out.components.happy == null) {
    out.components.happy = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happy',
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  const happyIsCreate = Boolean(out.components.happy && typeof out.components.happy === 'object' && out.components.happy.create);
  const happyMonoRoot = coerceHappyMonorepoRootFromPath(resolveHappySpecDir({ rootDir, spec: out.components.happy }));
  const canDeriveMonorepoGroup = Boolean(happyMonoRoot) || happyIsCreate;
  let deriveMonorepoGroup = false;

  if (canDeriveMonorepoGroup) {
    deriveMonorepoGroup = await promptSelectFn(rl, {
      title: `${bold('Monorepo mode detected')}\n${dim(
        `This ${cyan('happy')} checkout looks like a monorepo (packages/happy-* or legacy expo-app/cli/server).`
      )}\n${dim('Recommended: derive CLI + server from the same monorepo checkout to avoid version skew.')}`,
      options: [
        { label: `yes (${green('recommended')}) — derive happy-cli + happy-server from this checkout`, value: true },
        { label: `no — pick CLI/server worktrees separately`, value: false },
      ],
      defaultIndex: 0,
    });
  }

  if (deriveMonorepoGroup) {
    out.components['happy-cli'] = null;
    out.components['happy-server'] = null;
    // In monorepo mode, happy-server-light is derived when supported by the monorepo server checkout.
    // If not supported, the stack env will keep the default separate happy-server-light checkout.
    out.components['happy-server-light'] = null;
  } else if (out.components['happy-cli'] == null) {
    out.components['happy-cli'] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happy-cli',
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  if (serverComponent === 'happy-server-light' && deriveMonorepoGroup) {
    out.components['happy-server-light'] = null;
    return out;
  }
  if (serverComponent === 'happy-server' && deriveMonorepoGroup) {
    out.components['happy-server'] = null;
  } else if (out.components[serverComponent] == null) {
    out.components[serverComponent] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: serverComponent,
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

  out.components.happy = await promptWorktreeSourceFn({
    rl,
    rootDir,
    component: 'happy',
    stackName,
    createRemote: out.createRemote,
  });

  const happyIsCreate = Boolean(out.components.happy && typeof out.components.happy === 'object' && out.components.happy.create);
  const happyMonoRoot = coerceHappyMonorepoRootFromPath(resolveHappySpecDir({ rootDir, spec: out.components.happy }));
  const canDeriveMonorepoGroup = Boolean(happyMonoRoot) || happyIsCreate;
  let deriveMonorepoGroup = false;
  if (canDeriveMonorepoGroup) {
    deriveMonorepoGroup = await promptSelectFn(rl, {
      title: `${bold('Monorepo mode detected')}\n${dim('Recommended: derive CLI + server from the same monorepo checkout to avoid version skew.')}`,
      options: [
        { label: `yes (${green('recommended')}) — derive happy-cli + happy-server`, value: true },
        { label: `no — pick CLI/server worktrees separately`, value: false },
      ],
      defaultIndex: 0,
    });
  }

  if (deriveMonorepoGroup) {
    out.components['happy-cli'] = null;
    out.components['happy-server'] = null;
    out.components['happy-server-light'] = null;
  } else if (out.components['happy-cli'] == null) {
    out.components['happy-cli'] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happy-cli',
      stackName,
      createRemote: out.createRemote,
    });
  }

  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  if (serverComponent === 'happy-server-light' && deriveMonorepoGroup) {
    out.components['happy-server-light'] = null;
    return out;
  }
  if (serverComponent === 'happy-server' && deriveMonorepoGroup) {
    out.components['happy-server'] = null;
  } else {
    out.components[serverComponent] = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: serverComponent,
      stackName,
      createRemote: out.createRemote,
    });
  }

  return out;
}
