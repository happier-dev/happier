import { commandExists } from '../proc/commands.mjs';

/**
 * We keep this list intentionally small and capability-driven.
 * The important distinction is whether we can run an agent with a pre-filled prompt reliably.
 */
const KNOWN_LLM_TOOLS = [
  {
    id: 'codex',
    cmd: 'codex',
    label: 'Codex CLI',
    note: 'Supports non-interactive runs with a prompt.',
    supportsPromptStdin: true,
    supportsAutoExec: true,
  },
  {
    id: 'claude',
    cmd: 'claude',
    label: 'Claude CLI',
    note: 'Supports starting interactive mode with an initial prompt.',
    supportsPromptStdin: false,
    supportsAutoExec: false,
  },
  {
    id: 'opencode',
    cmd: 'opencode',
    label: 'OpenCode',
    note: 'Supports starting TUI with an initial prompt.',
    supportsPromptStdin: false,
    supportsAutoExec: false,
  },
  {
    id: 'aider',
    cmd: 'aider',
    label: 'Aider',
    note: 'Prompt injection varies by mode; copy/paste fallback supported.',
    supportsPromptStdin: false,
    supportsAutoExec: false,
  },
];

export function getKnownLlmTools() {
  return [...KNOWN_LLM_TOOLS];
}

export async function detectInstalledLlmTools({ onlyAutoExec = false } = {}) {
  const installed = [];
  for (const t of KNOWN_LLM_TOOLS) {
    if (onlyAutoExec && !t.supportsAutoExec) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await commandExists(t.cmd);
    if (ok) installed.push(t);
  }
  return installed;
}

