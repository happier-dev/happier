import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';

const COMPONENTS = ['server', 'daemon', 'ui'];

function rollbackPath(stackBaseDir) {
  return join(stackBaseDir, 'source-runtime', 'rollback.json');
}

function selectionPath(stackBaseDir, component) {
  return join(stackBaseDir, 'source-runtime', `selected-${component}.json`);
}

function selectionPaths(selection) {
  return [selection?.entrypoint, selection?.uiDir, selection?.exportDir, selection?.runtimeDir]
    .filter(path => typeof path === 'string');
}

function unavailable(reason) {
  return Object.assign(new Error(`[reload] the incumbent revision cannot be restarted: ${reason}`),
    { code: 'ESOURCEROLLBACKUNAVAILABLE', reason });
}

/** Called right before a reload activates its replacement selection: the
 * selection it replaces is the incumbent's revision, retained until settled. */
export async function recordSourceSelectionRollback({ stackBaseDir }) {
  const selections = {};
  for (const component of COMPONENTS) selections[component] = await readJsonIfExists(selectionPath(stackBaseDir, component));
  await writeJsonAtomic(rollbackPath(stackBaseDir), { selections });
}

/** Paths a pending rollback still needs; the retention and tree-release owners keep them. */
export function readSourceSelectionRollbackPaths(stackBaseDir) {
  let record;
  try { record = JSON.parse(readFileSync(rollbackPath(stackBaseDir), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Object.values(record?.selections ?? {}).flatMap(selectionPaths);
}

/** Select the incumbent's revision again after its replacement failed readiness.
 * Refuses, keeping the current selection, unless every recorded entry still exists. */
export async function restoreSourceSelectionRollback({ stackBaseDir }) {
  const record = await readJsonIfExists(rollbackPath(stackBaseDir));
  if (!record?.selections) throw unavailable('no recorded incumbent selection');
  const restored = [];
  for (const component of COMPONENTS) {
    const selection = record.selections[component] ?? null;
    if (selection && !existsSync(selection.entrypoint ?? selection.uiDir ?? '')) {
      throw unavailable(`the incumbent ${component} revision was released`);
    }
  }
  for (const component of COMPONENTS) {
    const selection = record.selections[component] ?? null;
    const current = await readJsonIfExists(selectionPath(stackBaseDir, component));
    if (JSON.stringify(current) === JSON.stringify(selection)) continue;
    if (selection) await writeJsonAtomic(selectionPath(stackBaseDir, component), selection);
    else await rm(selectionPath(stackBaseDir, component), { force: true });
    restored.push(component);
  }
  return restored;
}

/** The replacement is ready (or the restart settled otherwise): release the pin. */
export async function settleSourceSelectionRollback({ stackBaseDir }) {
  await rm(rollbackPath(stackBaseDir), { force: true });
}
