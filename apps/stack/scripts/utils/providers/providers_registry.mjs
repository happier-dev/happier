export const PROVIDERS = [
  {
    id: 'claude',
    title: 'Claude Code CLI',
    binaries: ['claude'],
    install: {
      // Recommended upstream install methods (see apps/cli/scripts/claude_version_utils.cjs).
      darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] }],
      linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] }],
      win32: [{ cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] }],
    },
  },
  {
    id: 'codex',
    title: 'OpenAI Codex CLI',
    binaries: ['codex'],
    install: {
      darwin: [{ cmd: 'npm', args: ['install', '-g', '@openai/codex'] }],
      linux: [{ cmd: 'npm', args: ['install', '-g', '@openai/codex'] }],
      win32: [{ cmd: 'npm', args: ['install', '-g', '@openai/codex'] }],
    },
  },
  {
    id: 'gemini',
    title: 'Google Gemini CLI',
    binaries: ['gemini'],
    install: {
      darwin: [{ cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'] }],
      linux: [{ cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'] }],
      win32: [{ cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'] }],
    },
  },
  // Known providers in Happier that currently require manual CLI installation.
  // These are listed so users can discover them via `hstack providers list`,
  // and we can add install recipes once upstream guidance is confirmed.
  { id: 'opencode', title: 'OpenCode CLI', binaries: ['opencode'], install: null },
  { id: 'auggie', title: 'Auggie CLI', binaries: ['auggie'], install: null },
  { id: 'kilo', title: 'Kilo CLI', binaries: ['kilo'], install: null },
  { id: 'kimi', title: 'Kimi CLI', binaries: ['kimi'], install: null },
  { id: 'qwen', title: 'Qwen CLI', binaries: ['qwen'], install: null },
  { id: 'pi', title: 'Pi CLI', binaries: ['pi'], install: null },
];

export function resolveProvider(id) {
  const key = String(id ?? '').trim().toLowerCase();
  if (!key) return null;
  return PROVIDERS.find((p) => p.id === key) ?? null;
}

