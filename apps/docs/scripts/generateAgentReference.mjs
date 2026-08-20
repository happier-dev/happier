/**
 * Renders the agent capability reference from the agent manifest.
 *
 * This page used to be maintained by hand as `features/feature-matrix.mdx`, and
 * it drifted the way hand-maintained tables always do: it listed 10 of 14
 * agents, omitted Cursor entirely, and marked three default-on features
 * "Experimental" while the genuinely experimental ones were not distinguished.
 * A capability matrix is a projection of data that already exists in code, so
 * it should be projected, not retyped.
 *
 * Two sources, because the data genuinely lives in two places:
 *
 *   - `@happier-dev/agents` owns what an agent can *do* — resume, fork,
 *     steering, media, tools, models, auth. Imported from the built package so
 *     the types are real rather than regex-guessed.
 *   - `apps/ui/sources/agents/providers/<id>/core.ts` owns whether the app
 *     presents the agent as Stable or Experimental, which is a product decision
 *     the client makes and the shared package does not model. That one field is
 *     read from source, and `collectStability` throws if any agent is missing,
 *     so a shape change fails loudly here instead of silently publishing a
 *     wrong status column.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`. The drift test in
 * `generateAgentReference.test.mjs` fails the build if the published page and
 * this renderer disagree.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const UI_PROVIDERS = join(REPO, 'apps', 'ui', 'sources', 'agents', 'providers');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'providers', 'capabilities.mdx');

const AGENTS_DIST = join(REPO, 'packages', 'agents', 'dist', 'index.js');
const CLI_RUNTIME_DIST = join(REPO, 'packages', 'agents', 'dist', 'providers', 'providerCliRuntime.js');

/** Display names as the app renders them in the AI backends list. */
const DISPLAY_NAMES = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  auggie: 'Auggie',
  qwen: 'Qwen Code',
  kimi: 'Kimi',
  kilo: 'Kilo',
  kiro: 'Kiro',
  customAcp: 'Custom ACP',
  pi: 'Pi',
  copilot: 'Copilot',
  cursor: 'Cursor',
  grok: 'Grok',
};

/** Read `availability.experimental` for every agent, or fail. */
export function collectStability({ providersDir = UI_PROVIDERS, agentIds } = {}) {
  const dirs = new Set(
    readdirSync(providersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  const stability = {};
  for (const id of agentIds) {
    if (!dirs.has(id)) throw new Error(`No UI core directory for agent "${id}" in ${providersDir}`);
    const source = readFileSync(join(providersDir, id, 'core.ts'), 'utf8');
    const match = source.match(/availability\s*:\s*\{[^}]*?experimental\s*:\s*(true|false)/s);
    if (!match) throw new Error(`Could not read availability.experimental for agent "${id}"`);
    stability[id] = match[1] === 'true' ? 'Experimental' : 'Stable';
  }
  return stability;
}

const YES = 'Yes';
const NO = '—';

function supported(value) {
  if (value === 'supported' || value === true) return YES;
  if (value === 'experimental') return 'Experimental';
  if (value === 'unsupported' || value === false || value == null) return NO;
  return String(value);
}

function modelsCell(config) {
  if (!config?.supportsSelection) return 'Not selectable';
  const parts = [];
  if (config.dynamicProbe === 'static-only') parts.push('Fixed list');
  else parts.push('Queried from the agent');
  if (config.supportsFreeform) parts.push('custom ids allowed');
  return parts.join(', ');
}

function installCell(spec) {
  const managed = spec?.managedInstall;
  if (managed?.kind === 'managed_package' && managed.packageName) return `\`${managed.packageName}\``;
  if (spec?.manualInstallKind === 'command') return "Vendor's own installer";
  return 'Vendor recipe';
}

function authCell(probe) {
  if (!probe) return NO;
  const bits = [];
  if (probe.credentialPaths?.length) bits.push(`\`${probe.credentialPaths[0]}\``);
  if (probe.envVars?.length) bits.push(probe.envVars.map((v) => `\`${v}\``).join(', '));
  return bits.length ? bits.join(' or ') : 'Agent-managed';
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, rule, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export async function renderAgentReferenceMarkdown({
  agentsModulePath = AGENTS_DIST,
  cliRuntimeModulePath = CLI_RUNTIME_DIST,
  providersDir = UI_PROVIDERS,
} = {}) {
  const agents = await import(`file://${agentsModulePath}`);
  const cliRuntime = await import(`file://${cliRuntimeModulePath}`);
  const ids = [...agents.AGENT_IDS];
  const stability = collectStability({ providersDir, agentIds: ids });

  const name = (id) => DISPLAY_NAMES[id] ?? id;
  const core = (id) => agents.AGENTS_CORE[id];

  const overview = table(
    ['Agent', 'Start it with', 'Status', 'Models', 'Managed install'],
    ids.map((id) => [
      `**${name(id)}**`,
      `\`happier ${core(id).cliSubcommand}\``,
      stability[id],
      modelsCell(agents.getAgentModelConfig(id)),
      installCell(cliRuntime.getProviderCliRuntimeSpec(id)),
    ]),
  );

  const sessions = table(
    ['Agent', 'Resume its own sessions', 'Browse its sessions', 'Fork a conversation', 'Fork from a message', 'Roll back'],
    ids.map((id) => {
      const c = core(id).sessionCapabilities;
      return [
        `**${name(id)}**`,
        supported(core(id).resume?.vendorResume),
        supported(c.sessionListing),
        supported(c.sessionFork?.conversation),
        supported(c.sessionFork?.fromMessage),
        supported(c.sessionRollback?.conversation),
      ];
    }),
  );

  const runtime = table(
    ['Agent', 'Steer a running turn', 'Plan mode', 'Accept edits', 'Mode switching', 'Session modes'],
    ids.map((id) => {
      const advanced = agents.getAgentAdvancedModeCapabilities(id);
      return [
        `**${name(id)}**`,
        supported(core(id).runtimeInput?.inFlightSteerSupported),
        supported(advanced.supportsPlanMode),
        supported(advanced.supportsAcceptEdits),
        advanced.supportsRuntimeModeSwitch === false ? NO : `\`${advanced.supportsRuntimeModeSwitch}\``,
        `\`${agents.getAgentSessionModesKind(id)}\``,
      ];
    }),
  );

  const mediaTools = table(
    ['Agent', 'Send it images', 'Publishes generated media', 'Generates images natively', 'Happier tools', 'Connected Services'],
    ids.map((id) => {
      const m = agents.getAgentMediaCapabilities(id);
      const t = core(id).tools;
      const cs = core(id).connectedServices?.supportedServiceIds ?? [];
      return [
        `**${name(id)}**`,
        supported(m.acceptsImageInput),
        supported(m.emitsSessionMedia),
        supported(m.nativeImageGeneration),
        t?.support === 'supported' ? `Yes (\`${t.delivery}\`)` : NO,
        cs.length ? cs.map((s) => `\`${s}\``).join(', ') : NO,
      ];
    }),
  );

  const auth = table(
    ['Agent', 'Where its credentials live', 'Background auth checks'],
    ids.map((id) => {
      const probe = agents.getAgentAuthProbeConfig(id);
      return [`**${name(id)}**`, authCell(probe), probe?.backgroundChecks === 'safe' ? 'Automatic' : 'Manual only'];
    }),
  );

  const stable = ids.filter((id) => stability[id] === 'Stable').map(name);
  const aliased = ids
    .filter((id) => core(id).flavorAliases?.length)
    .map((id) => `\`${core(id).cliSubcommand}\` also answers to ${core(id).flavorAliases.map((a) => `\`${a}\``).join(', ')}`);

  return `---
title: Agent capabilities
description: What each coding agent can and cannot do inside Happier, generated from the agent manifest.
---

Happier drives coding agents; it does not replace them. What any given session
can do is therefore the intersection of what Happier supports and what that
agent's own CLI exposes — which is why these tables exist rather than one list
of features.

Every table on this page is generated from the agent manifest in
\`packages/agents\`, so it describes the build you are reading the docs for
rather than the state of things whenever someone last updated a wiki page. A
dash means the agent does not support that capability, not that Happier has not
got to it yet.

${stable.length} of the ${ids.length} agents are marked Stable: ${stable.join(', ')}.
The rest are Experimental — they work, and people use them daily, but their
integration is younger and more likely to change. Availability of an agent is
separate from availability of a feature; see
[Server feature flags](/features/feature-flags) for the latter.

## Agents at a glance

${overview}

Where the managed-install column names a package, Happier can install the agent
for you from the machine's detail screen. Where it says the vendor's own
installer, run that first — see the agent's own page for the exact command.

**Custom ACP** is not a bundled agent. It is how you point Happier at any agent
that speaks the Agent Client Protocol, so its row describes the adapter rather
than a particular vendor. See [Custom ACP](/providers/custom-acp).

Several subcommands accept aliases, so the name you already have in your fingers
usually works: ${aliased.join('; ')}.

## Sessions

Resume, browse, fork and roll back are the four things people most often assume
work everywhere. They do not.

${sessions}

"Resume its own sessions" means Happier can reattach to a conversation the agent
started outside Happier. "Fork" means the agent's own runtime can branch a
conversation; where it cannot, Happier's replay fork still works, because that
is Happier's own mechanism rather than the agent's. See
[Session forking](/features/session-forking).

## Running a turn

${runtime}

Steering is what lets you add a correction to a turn already in flight instead
of interrupting it. Where an agent cannot steer, Happier interrupts and resends,
which is slower and loses less than it sounds — see [Steering](/features/steering).

## Media and tools

${mediaTools}

## Authentication

${auth}

Agents whose background checks are manual only will not be re-probed on a timer;
their status refreshes when you open the backend's settings screen or start a
session. See [Agent authentication](/features/provider-authentication).

## Related

- [Coding agents](/providers) — one page per agent, with setup and known limits.
- [Model and engine selection](/features/model-and-engine-selection)
- [Server feature flags](/features/feature-flags)
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  const markdown = await renderAgentReferenceMarkdown();
  writeFileSync(OUTPUT_PATH, markdown, 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
