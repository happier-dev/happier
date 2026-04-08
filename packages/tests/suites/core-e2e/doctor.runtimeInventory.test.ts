import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';

const run = createRunDirs({ runLabel: 'core' });

function buildLaunchdPlist(params: Readonly<{
  label: string;
  programArgs: readonly string[];
  env?: Record<string, string>;
}>): string {
  const envEntries = Object.entries(params.env ?? {})
    .map(([key, value]) => `      <key>${key}</key>\n      <string>${value}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${params.label}</string>
    <key>ProgramArguments</key>
    <array>
${params.programArgs.map((arg) => `      <string>${arg}</string>`).join('\n')}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
  </dict>
</plist>
`;
}

function buildSystemdUnit(params: Readonly<{
  description: string;
  execStart: readonly string[];
  env?: Record<string, string>;
}>): string {
  const envEntries = Object.entries(params.env ?? {})
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join('\n');

  return [
    '[Unit]',
    `Description=${params.description}`,
    '[Service]',
    envEntries,
    `ExecStart=${params.execStart.join(' ')}`,
    '[Install]',
    'WantedBy=default.target',
    '',
  ].filter(Boolean).join('\n');
}

function buildWindowsWrapper(params: Readonly<{
  workingDirectory: string;
  programArgs: readonly string[];
  env?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}>): string {
  const envAssignments = Object.entries(params.env ?? {})
    .map(([key, value]) => `$env:${key} = "${value}"`)
    .join('\n');

  return [
    '$ErrorActionPreference = "Stop"',
    `Set-Location -LiteralPath "${params.workingDirectory}"`,
    envAssignments,
    `& ${params.programArgs.map((arg) => `"${arg}"`).join(' ')} 1>> "${params.stdoutPath}" 2>> "${params.stderrPath}"`,
    '',
  ].filter(Boolean).join('\n');
}

async function writeExecutable(path: string, contents = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await writeFile(path, contents, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(path, 0o755);
  }
}

async function writeServiceFixtures(params: Readonly<{
  homeDir: string;
  happierHomeDir: string;
}>): Promise<void> {
  if (process.platform === 'darwin') {
    const launchAgentsDir = join(params.homeDir, 'Library', 'LaunchAgents');
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(
      join(launchAgentsDir, 'com.happier.cli.daemon.preview.cloud.plist'),
      buildLaunchdPlist({
        label: 'com.happier.cli.daemon.preview.cloud',
        programArgs: ['/usr/bin/env', join(params.happierHomeDir, 'cli-preview', 'current', 'happier'), 'daemon', 'start-sync'],
        env: {
          HAPPIER_ACTIVE_SERVER_ID: 'cloud',
          HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
        },
      }),
      'utf8',
    );
    await writeFile(
      join(launchAgentsDir, 'dev.happier.stack.dev-built.plist'),
      buildLaunchdPlist({
        label: 'dev.happier.stack.dev-built',
        programArgs: [join(params.homeDir, '.happier-stack', 'bin', 'hstack'), 'start', '--restart'],
        env: {
          HAPPIER_STACK_ENV_FILE: join(params.happierHomeDir, 'stacks', 'dev-built', 'env'),
        },
      }),
      'utf8',
    );
    return;
  }

  if (process.platform === 'win32') {
    const servicesDir = join(params.happierHomeDir, 'services');
    await mkdir(servicesDir, { recursive: true });
    await writeFile(
      join(servicesDir, 'happier-daemon.preview.cloud.ps1'),
      buildWindowsWrapper({
        workingDirectory: params.homeDir,
        programArgs: [join(params.happierHomeDir, 'cli-preview', 'current', 'happier.exe'), 'daemon', 'start-sync'],
        env: {
          HAPPIER_ACTIVE_SERVER_ID: 'cloud',
          HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
        },
        stdoutPath: join(params.happierHomeDir, 'logs', 'daemon.out.log'),
        stderrPath: join(params.happierHomeDir, 'logs', 'daemon.err.log'),
      }),
      'utf8',
    );
    await writeFile(
      join(servicesDir, 'dev.happier.stack.dev-built.ps1'),
      buildWindowsWrapper({
        workingDirectory: params.homeDir,
        programArgs: [join(params.homeDir, '.happier-stack', 'bin', 'hstack.exe'), 'start', '--restart'],
        env: {
          HAPPIER_STACK_ENV_FILE: join(params.happierHomeDir, 'stacks', 'dev-built', 'env'),
        },
        stdoutPath: join(params.homeDir, '.happier-stack', 'logs', 'stack.out.log'),
        stderrPath: join(params.homeDir, '.happier-stack', 'logs', 'stack.err.log'),
      }),
      'utf8',
    );
    return;
  }

  const systemdUserDir = join(params.homeDir, '.config', 'systemd', 'user');
  await mkdir(systemdUserDir, { recursive: true });
  await writeFile(
    join(systemdUserDir, 'happier-daemon.preview.cloud.service'),
    buildSystemdUnit({
      description: 'Happier Daemon',
      execStart: [join(params.happierHomeDir, 'cli-preview', 'current', 'happier'), 'daemon', 'start-sync'],
      env: {
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
      },
    }),
    'utf8',
  );
  await writeFile(
    join(systemdUserDir, 'dev.happier.stack.dev-built.service'),
    buildSystemdUnit({
      description: 'Happier Stack',
      execStart: [join(params.homeDir, '.happier-stack', 'bin', 'hstack'), 'start', '--restart'],
      env: {
        HAPPIER_STACK_ENV_FILE: join(params.happierHomeDir, 'stacks', 'dev-built', 'env'),
      },
    }),
    'utf8',
  );
}

describe('core e2e: happier doctor runtime inventory', () => {
  it('reports detected installations, services, and warnings from first-party fixtures', async () => {
    const testDir = run.testDir(`doctor-runtime-inventory-${randomUUID()}`);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const happierHomeDir = resolve(join(cliHome, '.happier'));
    const binDir = resolve(join(testDir, 'bin'));
    const managedPreviewDir = join(happierHomeDir, 'cli-preview', 'current');
    const managedStableDir = join(happierHomeDir, 'cli', 'current');
    const stdoutPath = resolve(join(testDir, 'doctor.stdout.log'));
    const stderrPath = resolve(join(testDir, 'doctor.stderr.log'));

    await mkdir(binDir, { recursive: true });
    await mkdir(managedPreviewDir, { recursive: true });
    await mkdir(managedStableDir, { recursive: true });

    await writeFile(join(managedPreviewDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', version: '1.2.3-preview.1' }), 'utf8');
    await writeFile(join(managedStableDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', version: '1.1.0' }), 'utf8');
    await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: 'path-shims', version: '0.9.0' }), 'utf8');
    await writeExecutable(join(binDir, process.platform === 'win32' ? 'happier.exe' : 'happier'));
    await writeExecutable(join(binDir, process.platform === 'win32' ? 'hprev.exe' : 'hprev'));
    await writeServiceFixtures({ homeDir: cliHome, happierHomeDir });

    const cliLaunchSpec = await resolveCliTestLaunchSpec(
      { testDir, env: process.env },
      {
        snapshotDir: resolve(join(testDir, 'cli-dist')),
        preferSourceEntrypoint: true,
        skipSourceFreshnessCheck: true,
      },
    );

    await runLoggedCommand({
      command: cliLaunchSpec.command,
      args: [...cliLaunchSpec.args, 'doctor', '--json'],
      cwd: repoRootDir(),
      env: {
        ...process.env,
        ...(cliLaunchSpec.env ?? {}),
        CI: '1',
        HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: cliHome,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        HOME: cliHome,
        USERPROFILE: cliHome,
      },
      stdoutPath,
      stderrPath,
      timeoutMs: 120_000,
    });

    const stdoutText = await readFile(stdoutPath, 'utf8');
    const snapshot = JSON.parse(stdoutText) as {
      installations?: { happier?: { installations?: Array<{ ring?: string | null; shimName?: string | null }> } };
      services?: { happier?: { services?: Array<{ serviceType?: string; label?: string }> } };
      warnings?: Array<{ code?: string }>;
    };

    expect(snapshot.installations?.happier?.installations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ring: 'preview' }),
      expect.objectContaining({ ring: 'stable', shimName: 'happier' }),
      expect.objectContaining({ ring: 'preview', shimName: 'hprev' }),
    ]));
    expect(snapshot.services?.happier?.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ serviceType: 'daemon' }),
      expect.objectContaining({ serviceType: 'stack-service' }),
    ]));
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH' }),
    ]));
  }, 240_000);
});
