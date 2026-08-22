/**
 * Renders the agent capability table from the bundled agent definitions.
 *
 * The previous version of this generator was written for the 0.2 layout: it
 * parsed per-agent `core.ts` files, imported `dist/providers/providerCliRuntime.js`
 * — a module this line of the codebase no longer has — and carried a hardcoded
 * `DISPLAY_NAMES` map whose values ("Claude", "Codex", "Qwen Code") disagreed
 * with the names the app actually shows ("Claude Code CLI", "OpenAI Codex CLI",
 * "Qwen CLI"). A hand-kept copy of a generated fact drifts; that is the whole
 * reason these pages are generated.
 *
 * `packages/agents/src/generated/bundledAgentDefinitions.ts` is now a single
 * generated artifact holding every agent's definition, so this reads its built
 * form and projects it. Nothing here is retyped.
 *
 * The wording comes from `settingsAgents.*` in the app's own translations, so
 * the page uses the same words as the agent's page in Settings. That matters:
 * a reader comparing this table against what they see should find the same
 * vocabulary, not a paraphrase of it.
 *
 * One field is deliberately absent. `supportsPlanMode` is derived in
 * `advancedModes.ts` as `semantics === 'agent-modes'`, so it reads `false` for
 * Codex — but Codex does have a plan mode, reached through ACP policy presets
 * discovered at runtime. The flag means "Happier surfaces its own plan-mode
 * control", not "this agent has no plan mode", and rendering it as a capability
 * states the opposite of the truth. The mode columns below describe where an
 * agent's modes come from instead, which is the fact the flag was standing in for.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const DEFINITIONS = join(REPO, 'packages', 'agents', 'dist', 'generated', 'bundledAgentDefinitions.js');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'agents', 'capabilities.mdx');

/** `settingsAgents.sessionMode*` in en.ts. */
const SESSION_MODES = {
  none: 'No ACP modes',
  acpPolicyPresets: 'ACP policy presets',
  acpAgentModes: 'ACP agent modes',
  staticAgentModes: 'Static agent modes',
};

/** `settingsAgents.runtimeSwitch*` in en.ts. */
const RUNTIME_SWITCH = {
  none: 'No runtime switch',
  'metadata-gating': 'Metadata-gated',
  'acp-setSessionMode': 'ACP setSessionMode',
  'provider-native': 'Agent native',
};

/** `settingsAgents.resumeSupport*` in en.ts. */
const SUPPORT = {
  supported: 'Supported',
  experimental: 'Supported (experimental)',
  unsupported: 'Not supported',
};

const support = (value) => SUPPORT[value] ?? 'Not supported';

/**
 * `sessionModesKind` is stored per agent, but it is derived in `sessionModes.ts`
 * from the descriptor. Deriving it the same way here means a definition whose
 * stored kind has gone stale cannot publish a wrong column.
 */
export function sessionModesKind(descriptor) {
  if (!descriptor) return 'none';
  const { source, semantics } = descriptor;
  if (source === 'provider-native' && semantics === 'agent-modes') return 'staticAgentModes';
  if (source === 'acp' && semantics === 'agent-modes') return 'acpAgentModes';
  if (source === 'acp' && semantics === 'policy-presets') return 'acpPolicyPresets';
  return 'none';
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

export async function renderAgentReferenceMarkdown({ definitionsPath = DEFINITIONS } = {}) {
  const { BUNDLED_AGENT_DEFINITIONS_BY_ID } = await import(`file://${definitionsPath}`);
  const agents = Object.values(BUNDLED_AGENT_DEFINITIONS_BY_ID)
    .slice()
    .sort((a, b) => (a.cli?.displayName ?? a.id).localeCompare(b.cli?.displayName ?? b.id));

  if (agents.length === 0) throw new Error('bundled agent definitions parsed to zero agents');

  const modeRows = agents.map((a) => [
    a.cli?.displayName ?? a.id,
    SESSION_MODES[sessionModesKind(a.sessionModeDescriptor)],
    RUNTIME_SWITCH[a.sessionModeDescriptor?.runtimeSwitch] ?? 'No runtime switch',
  ]);

  const sessionRows = agents.map((a) => {
    const caps = a.core?.sessionCapabilities ?? {};
    return [
      a.cli?.displayName ?? a.id,
      support(a.core?.resume?.vendorResume),
      support(a.core?.handoff?.vendorStateTransfer),
      support(caps.sessionListing),
      support(caps.sessionFork?.conversation),
    ];
  });

  return `---
title: Agent capabilities
description: What each coding agent supports in Happier — session modes, resuming, handoff, listing and forking — generated from the bundled agent definitions.
---

Happier drives ${agents.length} coding agents, and they do not all support the same
things. This page is generated from the agent definitions the app ships with, so
it says what your build actually does rather than what an agent's own
documentation claims.

The same facts are on each agent's page in **Settings → Agents**, in the same
words, if you would rather read them next to the agent you are configuring.

## Session modes

An agent's *modes* are things like plan or accept-edits. Where they come from
decides how they behave in Happier.

- **Static agent modes** are built into the agent and Happier knows them ahead of time.
- **ACP agent modes** are discovered over the Agent Client Protocol when the session starts.
- **ACP policy presets** are also discovered over ACP, but they are permission
  policies rather than named modes — the agent may still offer something it
  calls plan mode; Happier just does not present its own control for it.
- **No ACP modes** means the agent exposes none of this to Happier.

The second column is whether you can change mode *during* a session, rather
than only when starting one.

${table(['Agent', 'Session modes', 'Switching mid-session'], modeRows)}

## Sessions

- **Resume** — picking a previous session back up through the agent's own state.
- **Handoff** — carrying a session's state to a different agent.
- **Listing** — Happier can enumerate the agent's own sessions.
- **Fork** — branching a conversation into a new session.

"Supported (experimental)" is the agent definition's own word for it: the path
works and is not yet considered settled.

${table(['Agent', 'Resume', 'Handoff', 'Listing', 'Fork'], sessionRows)}

## Related

- [Agents](/agents) — setting each one up.
- [Feature flags](/extras/feature-flags) — what your server and build allow.
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderAgentReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
