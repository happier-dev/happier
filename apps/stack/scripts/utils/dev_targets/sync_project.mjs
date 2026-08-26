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

export async function resumeDevTargetSync(
  { target, env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const result = await runProcess({
    label: `sync:${target.name}`,
    command: 'mutagen',
    args: ['sync', 'resume', resolveMutagenSessionName(target.name)],
    env,
  });
  requireSuccessful(result, `${target.name} Mutagen resume`);
}

export async function flushDevTargetSync(
  { target, env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const result = await runProcess({
    label: `sync:${target.name}`,
    command: 'mutagen',
    args: ['sync', 'flush', resolveMutagenSessionName(target.name)],
    env,
  });
  requireSuccessful(result, `${target.name} Mutagen initial flush`);
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
  const existingProject = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
  const borrowingIndependentProject = Boolean(
    allowIndependentBorrow
    && isMutagenProjectOwnedBy(existingProject, INDEPENDENT_DEV_TARGET_SYNC_OWNER),
  );
  const desiredProject = renderMutagenProject({
    sourceDir,
    targets,
    ownerId: borrowingIndependentProject ? INDEPENDENT_DEV_TARGET_SYNC_OWNER : ownerId,
  });

  if (
    borrowingIndependentProject
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
    let result = await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    resumed = result?.code === 0;
    if (!resumed && openSsh.sshArgs.length > 0) {
      requireSuccessful(await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: ['daemon', 'stop'],
        env: mutagenRuntime.env,
      }), 'Mutagen daemon restart');
      result = await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
        env: mutagenRuntime.env,
      });
      resumed = result?.code === 0;
    }
    if (!resumed) {
      const sessionResults = await Promise.all(targets.map((target) => runProcess({
        label: `sync:${target.name}`,
        command: 'mutagen',
        args: [
          'sync',
          'list',
          resolveMutagenSessionName(target.name),
          '--template',
          MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
        ],
        env: mutagenRuntime.env,
      })));
      resumed = sessionResults.every((sessionResult) => sessionResult?.code === 0);
    }
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
    ownership: borrowingIndependentProject ? 'independent' : 'owned',
    projectCreated,
    async release(action) {
      if (borrowingIndependentProject) return;
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

export async function pauseOwnedDevTargetSyncProject(
  { stackBaseDir, ownerId, env = process.env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const contents = await readFile(runtime.projectFile, 'utf8').catch(() => null);
  if (!isMutagenProjectOwnedBy(contents, ownerId)) return false;
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('pause', runtime.projectFile),
    env: runtime.env,
  }), 'owned Mutagen project pause');
  return true;
}
