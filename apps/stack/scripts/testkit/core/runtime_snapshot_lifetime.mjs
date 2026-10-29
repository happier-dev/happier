import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LIFETIME_FILE = '.runtime-snapshot-fixture-lifetime';

export async function prepareRuntimeSnapshotFixtureLifetime(stackDir) {
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, LIFETIME_FILE), 'prepared\n', { flag: 'wx' });
}

export function recordRuntimeSnapshotFixtureStart(stackDir) {
  const path = join(stackDir, LIFETIME_FILE);
  let state;
  try { state = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (state === 'started\n') return;
  if (state !== 'prepared\n') throw new Error('Invalid runtime snapshot fixture lifetime');
  writeFileSync(path, 'started\n');
}

export async function hasRuntimeSnapshotFixtureStarted(stackDir) {
  const state = await readFile(join(stackDir, LIFETIME_FILE), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (state === null || state === 'prepared\n') return false;
  if (state !== 'started\n') throw new Error('Invalid runtime snapshot fixture lifetime');
  return true;
}
