import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { getHappyStacksHomeDir } from '../../../paths/paths.mjs';
import { resolveCommandPath } from '../../../proc/commands.mjs';
import { runCaptureResult } from '../../../proc/proc.mjs';
import { resolveCargoBinDir } from '../../../proc/cargo.mjs';

async function matchesVersion(binary, version, env, signal) {
  const result = await runCaptureResult(binary, ['--version'], { env, signal });
  return result.ok && result.out.trim() === `iroh-relay ${version}`;
}

export async function ensureRelayBinary({ version, env = process.env, signal }) {
  const executable = process.platform === 'win32' ? 'iroh-relay.exe' : 'iroh-relay';
  const installRoot = join(getHappyStacksHomeDir(env), 'tools', 'iroh-relay', version);
  const installed = join(installRoot, 'bin', executable);
  const explicit = String(env.HAPPIER_STACK_IROH_RELAY_BIN ?? '').trim();
  if (explicit) {
    if (await matchesVersion(explicit, version, env, signal)) return explicit;
    throw Object.assign(new Error('The selected relay does not match the deployment pin'), { code: 'relay_binary_version_mismatch' });
  }
  if (existsSync(installed) && await matchesVersion(installed, version, env, signal)) return installed;
  const onPath = await resolveCommandPath(executable, { env });
  if (onPath && await matchesVersion(onPath, version, env, signal)) return onPath;
  const cargoBinDir = resolveCargoBinDir({ env });
  if (!cargoBinDir) throw Object.assign(new Error('Cargo is required to install the pinned development relay'), { code: 'relay_binary_unavailable' });
  const cargo = join(cargoBinDir, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const cargoEnv = { ...env, PATH: [cargoBinDir, env.PATH ?? env.Path].filter(Boolean).join(delimiter) };
  // Matches the deployment Dockerfile's locked, server-enabled crate build.
  // Tool files live outside repository dependency inputs, just like provisioned tools.
  const result = await runCaptureResult(cargo, ['install', 'iroh-relay', '--version', version,
    '--locked', '--features', 'server', '--root', installRoot], { env: cargoEnv, signal });
  if (!result.ok || !await matchesVersion(installed, version, env, signal)) {
    throw Object.assign(new Error('The pinned development relay could not be installed'), { code: 'relay_binary_install_failed' });
  }
  return installed;
}
