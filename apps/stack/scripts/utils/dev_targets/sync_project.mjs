import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runCaptureResult } from '../proc/proc.mjs';
import {
  buildMutagenProjectArgs,
  isEquivalentMutagenProject,
  isMutagenProjectOwnedBy,
  renderMutagenProject,
  resolveMutagenSessionName,
  withoutMutagenProjectOwner,
} from './mutagen_project.mjs';
import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  parseMutagenSyncList,
  resolveDevTargetMutagenRuntime,
} from './mutagen_runtime.mjs';

export const INDEPENDENT_DEV_TARGET_SYNC_OWNER = 'dev-target-sync-service';

export async function runDevTargetControlProcess({ label, command, args, env }) {
  const result = await runCaptureResult(command, args, { env, streamLabel: label });
  return { ...result, code: result.exitCode };
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  throw new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export async function prepareDevTargetOpenSsh({ targets, mutagenDir, env }) {
  const customConfigs = [
    ...new Set(targets.map((target) => target.sshConfigFile).filter(Boolean)),
  ];
  if (customConfigs.length === 0) {
    return { sshArgs: [], mutagenEnv: env };
  }
  if (process.platform === 'win32') {
    throw new Error('[dev-targets] sshConfigFile is not yet supported on Windows Stack hosts');
  }

  const opensshDir = join(mutagenDir, 'openssh');
  const configPath = join(opensshDir, 'config');
  await mkdir(opensshDir, { recursive: true });
  await writeFile(
    configPath,
    [
      ...customConfigs.map((path) => `Include ${JSON.stringify(path)}`),
      `Include ${JSON.stringify(join(homedir(), '.ssh', 'config'))}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  for (const executable of ['ssh', 'scp']) {
    await writeFile(
      join(opensshDir, executable),
      `#!/bin/sh\nexec /usr/bin/${executable} -F ${shellQuote(configPath)} -o ControlMaster=no "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    sshArgs: ['-F', configPath, '-o', 'ControlMaster=no'],
    mutagenEnv: { ...env, MUTAGEN_SSH_PATH: opensshDir },
  };
}

export async function ensureDevTargetSyncProject(
  {
    stackBaseDir,
    sourceDir,
    targets,
    requiredTargets = targets,
    ownerId,
    allowIndependentBorrow,
    env = process.env,
  },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const {
    HAPPIER_STACK_PROCESS_KIND: _stackProcessKind,
    ...mutagenControlEnv
  } = env;
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env: mutagenControlEnv });
  const openSsh = await prepareDevTargetOpenSsh({
    targets,
    mutagenDir: runtime.mutagenDir,
    env: mutagenControlEnv,
  });
  const mutagenRuntime = resolveDevTargetMutagenRuntime({
    stackBaseDir,
    env: openSsh.mutagenEnv,
  });
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: ['version'],
    env: mutagenRuntime.env,
  }), 'Mutagen preflight');
  const desiredProject = renderMutagenProject({ sourceDir, targets, ownerId });
  const existingProject = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);

  if (
    allowIndependentBorrow
    && isMutagenProjectOwnedBy(existingProject, INDEPENDENT_DEV_TARGET_SYNC_OWNER)
    && isEquivalentMutagenProject(existingProject, desiredProject)
  ) {
    requireSuccessful(await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('list', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    }), 'independent Mutagen project status');
    for (const target of requiredTargets) {
      const sessionName = resolveMutagenSessionName(target.name);
      const result = await runProcess({
        label: `sync:${target.name}`,
        command: 'mutagen',
        args: ['sync', 'list', sessionName, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE],
        env: mutagenRuntime.env,
      });
      requireSuccessful(result, `${target.name} independent synchronization status`);
      const status = parseMutagenSyncList(result.out, sessionName);
      if (status.state !== 'ready' && status.state !== 'synchronizing') {
        throw new Error(
          `[dev-targets] ${target.name} independent synchronization is ${status.state}`,
        );
      }
    }
    return {
      ...mutagenRuntime,
      openSsh,
      ownership: 'independent',
      projectCreated: false,
      release: async () => {},
    };
  }

  await mkdir(mutagenRuntime.mutagenDir, { recursive: true });
  await writeFile(mutagenRuntime.projectFile, desiredProject, 'utf8');
  const canResumeProject = isEquivalentMutagenProject(existingProject, desiredProject);
  let resumed = false;
  if (canResumeProject) {
    const result = await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    resumed = result?.code === 0;
  }
  let projectCreated = false;
  if (!resumed) {
    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('terminate', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    requireSuccessful(await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('start', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    }), 'Mutagen project start');
    projectCreated = true;
  }
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('list', mutagenRuntime.projectFile),
    env: mutagenRuntime.env,
  }), 'Mutagen project status');

  return {
    ...mutagenRuntime,
    openSsh,
    ownership: 'owned',
    projectCreated,
    async release(action) {
      const current = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
      if (!isMutagenProjectOwnedBy(current, ownerId)) return;
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs(action, mutagenRuntime.projectFile),
        env: mutagenRuntime.env,
      });
    },
  };
}

export async function releaseIndependentDevTargetSyncProject(
  { stackBaseDir, env = process.env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const contents = await readFile(runtime.projectFile, 'utf8').catch(() => null);
  if (!isMutagenProjectOwnedBy(contents, INDEPENDENT_DEV_TARGET_SYNC_OWNER)) return false;
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('pause', runtime.projectFile),
    env: runtime.env,
  }), 'independent Mutagen project pause');
  await writeFile(runtime.projectFile, withoutMutagenProjectOwner(contents), 'utf8');
  return true;
}
