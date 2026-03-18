import { spawnSync } from 'node:child_process';

function defaultCommandExists(name) {
  if (process.platform === 'win32') {
    const result = spawnSync('where', [name], { encoding: 'utf-8', stdio: 'ignore' });
    return result.status === 0;
  }
  const result = spawnSync('sh', ['-lc', `command -v ${name} >/dev/null 2>&1`], { encoding: 'utf-8', stdio: 'ignore' });
  return result.status === 0;
}

function defaultRunCommand(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf-8',
    env: options.env,
    stdio: options.stdio ?? 'pipe',
  });
}

export function buildInstallCompanionCliPlan({
  withCli,
  hasCompanionCli,
  hasCurl,
  hasBash,
}) {
  if (!withCli) {
    return {
      shouldInstall: false,
      reason: 'disabled',
    };
  }
  if (hasCompanionCli) {
    return {
      shouldInstall: false,
      reason: 'already-installed',
    };
  }
  if (!hasCurl || !hasBash) {
    return {
      shouldInstall: false,
      reason: 'missing-curl-or-bash',
    };
  }
  return {
    shouldInstall: true,
    reason: 'install',
  };
}

export async function installCompanionCli({
  channel,
  nonInteractive,
  withCli,
  env = process.env,
  commandExists = defaultCommandExists,
  runCommand = defaultRunCommand,
}) {
  const plan = buildInstallCompanionCliPlan({
    withCli,
    hasCompanionCli: await commandExists('happier'),
    hasCurl: await commandExists('curl'),
    hasBash: await commandExists('bash'),
  });

  if (!plan.shouldInstall) {
    return {
      installed: false,
      reason: plan.reason,
    };
  }

  const result = await runCommand(
    'bash',
    ['-lc', 'curl -fsSL https://happier.dev/install | bash'],
    {
      allowFail: true,
      env: {
        ...env,
        HAPPIER_CHANNEL: channel,
        HAPPIER_NONINTERACTIVE: nonInteractive ? '1' : '0',
      },
      stdio: 'inherit',
    },
  );
  const installed = (result.status ?? 1) === 0;
  return {
    installed,
    reason: installed ? 'installed' : 'installer-failed',
  };
}
