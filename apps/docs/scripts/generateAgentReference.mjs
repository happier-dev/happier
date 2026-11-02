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
 * Regenerate with `pnpm --dir apps/docs run generate:reference`.
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

/**
 * What an agent declares for compacting while idle, across every runtime mode it can start in: the
 * same any-mode fact that decides whether its Agent page shows the switch. Null when no mode does.
 */
export function idleCompactionDeclaration(definition) {
  const core = definition?.core ?? {};
  const modes = [
    core.sessionCapabilities?.compaction,
    ...Object.values(core.runtimeKinds?.byKind ?? {}).map((kind) => kind?.overrides?.sessionCapabilities?.compaction),
  ];
  return modes.map((compaction) => compaction?.idle ?? null).find((idle) => idle !== null) ?? null;
}

const tokens = (count) => `${new Intl.NumberFormat('en-US').format(count)} tokens`;

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

  const idleRows = agents.flatMap((a) => {
    const idle = idleCompactionDeclaration(a);
    if (!idle) return [];
    return [[
      a.cli?.displayName ?? a.id,
      idle.defaultEnabled ? 'On' : 'Off',
      idle.defaultMinContextTokens ? tokens(idle.defaultMinContextTokens) : 'No minimum',
    ]];
  });
  const idleTable = idleRows.length > 0
    ? table(['Agent', 'Compact while idle', 'Minimum conversation size'], idleRows)
    : 'No agent in this build offers it yet.';

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

## Compacting while idle

**Development only:** these controls are available in the 0.3 development source.

Providers keep a recent conversation in a prompt cache for a limited time, and
a long conversation that is read again after the cache expires costs its full
size. With **Compact while idle** on, a long conversation is compacted shortly
before the cache expires, so the next message you send starts from a small, warm
context.

You choose it per agent under **Settings → Agents → {agent} → Session defaults**.
While it is on, **When to compact** holds two refinements, each shown only where
the agent's runtime honours it:

- **Minimum conversation size** — shorter conversations aren't compacted. Leave
  it empty to use the agent's default; clearing it returns to that default.
- **Cache window** — **Automatic** uses the window the provider reports for the
  session. Pick a documented window or a custom number of minutes to override it.

A change applies to sessions started after it. The compaction appears in the
transcript as one quiet "Compacted while idle" row, with the measured token
counts when the agent reports them. It never marks the session unread, moves it
up the list, shows it as working or sends a notification.

${idleTable}

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
