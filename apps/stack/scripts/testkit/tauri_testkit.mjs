import { chmod, copyFile, mkdir } from 'node:fs/promises';

import { createTempFixture } from './core/temp_fixture.mjs';
import { prependPathEntries } from './core/env_scope.mjs';

export async function createCargoProbeFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-tauri-cargo-probe-' });
  const binDir = fixture.path('bin');
  await mkdir(binDir);
  const executable = fixture.path('bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  // Launch-plan tests only probe `cargo --version`. A native executable models
  // that OS boundary on every platform without installing a Rust toolchain.
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  return env => prependPathEntries(env, [binDir]);
}
