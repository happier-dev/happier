import { commandExists } from '../proc/commands.mjs';
import { getKnownLlmToolSpecs } from './registry.mjs';

export function getKnownLlmTools() {
  return getKnownLlmToolSpecs();
}

export async function detectInstalledLlmTools({ onlyAutoExec = false } = {}) {
  const installed = [];
  for (const t of getKnownLlmToolSpecs()) {
    if (onlyAutoExec && !t.supportsAutoExec) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await commandExists(t.cmd);
    if (ok) installed.push(t);
  }
  return installed;
}
