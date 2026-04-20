const LLM_TOOL_SPECS = [
  {
    id: 'codex',
    cmd: 'codex',
    label: 'Codex CLI',
    note: 'Supports non-interactive runs with a prompt.',
    supportsPromptStdin: true,
    supportsAutoExec: true,
    launchMode: 'codex-exec',
    prereq: {
      name: 'codex',
      why: 'required to run Codex review',
      install: [
        'Install Codex CLI and ensure `codex` is on PATH',
        'If using a managed install, ensure your PATH includes the Codex binary',
      ],
    },
  },
  {
    id: 'claude',
    cmd: 'claude',
    label: 'Claude CLI',
    note: 'Supports starting interactive mode with an initial prompt.',
    supportsPromptStdin: false,
    supportsAutoExec: false,
    launchMode: 'prompt-arg',
    prereq: {
      name: 'claude',
      why: 'required to run Claude Code review',
      install: ['Install Claude Code CLI and ensure `claude` is on PATH', 'Then authenticate (if needed) with your Claude setup'],
    },
  },
  {
    id: 'opencode',
    cmd: 'opencode',
    label: 'OpenCode',
    note: 'Supports starting TUI with an initial prompt.',
    supportsPromptStdin: false,
    supportsAutoExec: false,
    launchMode: 'prompt-flag',
    prereq: null,
  },
  {
    id: 'aider',
    cmd: 'aider',
    label: 'Aider',
    note: 'Prompt injection varies by mode; copy/paste fallback supported.',
    supportsPromptStdin: false,
    supportsAutoExec: false,
    launchMode: 'manual',
    prereq: null,
  },
];

export function getKnownLlmToolSpecs() {
  return [...LLM_TOOL_SPECS];
}

export function findKnownLlmToolSpecById(id) {
  const normalized = String(id ?? '').trim().toLowerCase();
  if (!normalized) return null;
  return LLM_TOOL_SPECS.find((spec) => spec.id === normalized) ?? null;
}

export function resolveLlmToolInteractiveLaunchLine(toolSpec) {
  if (!toolSpec) return null;
  if (toolSpec.launchMode === 'codex-exec' || toolSpec.launchMode === 'prompt-arg') {
    return `exec command ${JSON.stringify(toolSpec.cmd)} "$HS_PROMPT"`;
  }
  if (toolSpec.launchMode === 'prompt-flag') return `exec command ${JSON.stringify(toolSpec.cmd)} --prompt "$HS_PROMPT"`;
  return `exec command ${JSON.stringify(toolSpec.cmd)}`;
}

export function resolveLlmToolPrereqSpec(toolId) {
  return findKnownLlmToolSpecById(toolId)?.prereq ?? null;
}
