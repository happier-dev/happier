import { chmod, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureFileExists, type RunCommand } from './commands.js';
import type { BinaryTarget } from './targets.js';

const CLIPROXYAPI_MANAGED_RUNTIME_PACKAGE = '@happier-dev/plugins-cliproxyapi';
const CLIPROXYAPI_MANAGED_RUNTIME_BUILD_SCRIPT = 'managed-runtime:build';
const CLIPROXYAPI_MANAGED_RUNTIME_EXECUTABLE = 'happier-cliproxyapi-managed';
const CLIPROXYAPI_LICENSE = 'CLIProxyAPI-LICENSE';
const CLIPROXYAPI_THIRD_PARTY_NOTICES_SOURCE = 'THIRD-PARTY-NOTICES';
const CLIPROXYAPI_THIRD_PARTY_NOTICES = 'CLIProxyAPI-THIRD-PARTY-NOTICES';

function resolveGoTarget(target: BinaryTarget): string {
  const goArch = target.arch === 'x64' ? 'amd64' : target.arch;
  const value = `${target.os}-${goArch}`;
  switch (value) {
    case 'darwin-amd64':
    case 'darwin-arm64':
    case 'linux-amd64':
    case 'linux-arm64':
    case 'windows-amd64':
    case 'windows-arm64':
      return value;
    default:
      throw new Error(`[component-artifacts] unsupported CLIProxyAPI managed runtime target: ${target.os}-${target.arch}`);
  }
}

export async function stageCliProxyApiManagedRuntime({
  repoRoot,
  payloadDir,
  target,
  yarn,
  runCommand,
  prebuiltExecutablePath,
}: {
  repoRoot: string;
  payloadDir: string;
  target: BinaryTarget;
  yarn: Readonly<{ cmd: string; args: string[] }>;
  runCommand: RunCommand;
  prebuiltExecutablePath?: string;
}): Promise<{ executablePath: string; licensePath: string; thirdPartyNoticesPath: string }> {
  const toolsDir = join(payloadDir, 'tools', 'unpacked');
  const executablePath = join(toolsDir, `${CLIPROXYAPI_MANAGED_RUNTIME_EXECUTABLE}${target.exeExt}`);
  const licenseSourcePath = join(
    repoRoot,
    'packages',
    'plugins',
    'cliproxyapi',
    'managed-runtime',
    'licenses',
    CLIPROXYAPI_LICENSE,
  );
  const licensePath = join(toolsDir, CLIPROXYAPI_LICENSE);
  const thirdPartyNoticesSourcePath = join(
    repoRoot,
    'packages',
    'plugins',
    'cliproxyapi',
    'managed-runtime',
    'licenses',
    CLIPROXYAPI_THIRD_PARTY_NOTICES_SOURCE,
  );
  const thirdPartyNoticesPath = join(toolsDir, CLIPROXYAPI_THIRD_PARTY_NOTICES);

  await ensureFileExists(licenseSourcePath);
  await ensureFileExists(thirdPartyNoticesSourcePath);
  await mkdir(toolsDir, { recursive: true });

  if (prebuiltExecutablePath) {
    await ensureFileExists(prebuiltExecutablePath);
    await cp(prebuiltExecutablePath, executablePath);
  } else {
    await runCommand(
      yarn.cmd,
      [
        ...yarn.args,
        'workspace',
        CLIPROXYAPI_MANAGED_RUNTIME_PACKAGE,
        CLIPROXYAPI_MANAGED_RUNTIME_BUILD_SCRIPT,
        '--target',
        resolveGoTarget(target),
        '--output',
        executablePath,
      ],
      { cwd: repoRoot },
    );
  }

  await ensureFileExists(executablePath);
  if (target.os !== 'windows') {
    await chmod(executablePath, 0o755);
  }
  await cp(licenseSourcePath, licensePath);
  await cp(thirdPartyNoticesSourcePath, thirdPartyNoticesPath);

  return { executablePath, licensePath, thirdPartyNoticesPath };
}
