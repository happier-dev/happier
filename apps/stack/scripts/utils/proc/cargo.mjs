import { accessSync, constants, existsSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

export function resolveCargoBinDir({ env = process.env, resolveUserHomeDir } = {}) {
  const input = env && typeof env === 'object' ? env : process.env;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const cargoBinaryName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

  let resolvedHomeDir = '';
  if (typeof resolveUserHomeDir === 'function') {
    resolvedHomeDir = String(resolveUserHomeDir()).trim();
  }
  if (!resolvedHomeDir) {
    try {
      resolvedHomeDir = String(os.userInfo()?.homedir ?? '').trim();
    } catch {
      resolvedHomeDir = '';
    }
  }

  // Stack tooling sometimes isolates HOME while Rust toolchains remain installed
  // under the real user home. Prefer that toolchain over a PATH shim in this case.
  const envHome = String(input.HOME ?? input.USERPROFILE ?? '').trim();
  const homeIsolated = Boolean(envHome && resolvedHomeDir && envHome !== resolvedHomeDir);

  const cargoHomeFromEnv = String(input.CARGO_HOME ?? '').trim();
  if (cargoHomeFromEnv) {
    const cargoHomeBinDir = join(cargoHomeFromEnv, 'bin');
    const cargoHomeCandidate = join(cargoHomeBinDir, cargoBinaryName);
    if (existsSync(cargoHomeCandidate)) {
      try {
        accessSync(cargoHomeCandidate, constants.X_OK);
        return cargoHomeBinDir;
      } catch {
        // ignore non-executable candidates
      }
    }
  }

  if (homeIsolated && resolvedHomeDir) {
    const resolvedCargoBinDir = join(resolvedHomeDir, '.cargo', 'bin');
    const resolvedCargoCandidate = join(resolvedCargoBinDir, cargoBinaryName);
    if (existsSync(resolvedCargoCandidate)) {
      try {
        accessSync(resolvedCargoCandidate, constants.X_OK);
        return resolvedCargoBinDir;
      } catch {
        // ignore non-executable candidates
      }
    }
  }

  const pathEntries = String(input.PATH ?? '')
    .split(delimiter)
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);

  for (const dir of pathEntries) {
    const candidate = join(dir, cargoBinaryName);
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return dir;
    } catch {
      // ignore non-executable candidates
    }
  }

  // Default rustup location, including non-login workers whose PATH omits it.
  const cargoHomeBin = join(resolvedHomeDir || os.homedir(), '.cargo', 'bin');
  const cargoHomeCandidate = join(cargoHomeBin, cargoBinaryName);
  if (existsSync(cargoHomeCandidate)) {
    try {
      accessSync(cargoHomeCandidate, constants.X_OK);
      return cargoHomeBin;
    } catch {
      // ignore non-executable candidates
    }
  }
  return '';
}
