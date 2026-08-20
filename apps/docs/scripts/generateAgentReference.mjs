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
const UI_PLUGIN_BUNDLE = join(
  REPO, 'apps', 'ui', 'sources', 'agents', 'registry', 'generatedBundledPluginEntries.ts',
);
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

/**
 * Read `availability.experimental` for every agent, or fail.
 *
 * Two layouts are supported because the two lines of the codebase store this
 * differently and this generator is meant to serve both:
 *
 *   - **Per-agent core files** (`agents/providers/<id>/core.ts`), the 0.2.x
 *     layout, where each agent owns its own module.
 *   - **A single generated bundle** (`agents/registry/generatedBundledPluginEntries.ts`),
 *     the layout after agents became plugins, where every agent's core config
 *     is emitted into one file.
 *
 * Whichever is present, a missing agent throws rather than defaulting. Silently
 * rendering an experimental agent as Stable is the failure this guards against.
 */
export function collectStability({ providersDir = UI_PROVIDERS, bundlePath = UI_PLUGIN_BUNDLE, agentIds } = {}) {
  const bundled = readBundledStability(bundlePath);
  const stability = {};
  const missing = [];
  for (const id of agentIds) {
    const fromDir = readAgentDirStability(providersDir, id);
    const value = fromDir ?? bundled[id] ?? null;
    if (value === null) missing.push(id);
    else stability[id] = value;
  }
  if (missing.length) {
    throw new Error(
      `Could not read availability.experimental for: ${missing.join(', ')}. ` +
        `Looked in ${providersDir} and ${bundlePath}.`,
    );
  }
  return stability;
}

function readAgentDirStability(providersDir, id) {
  let source;
  try {
    source = readFileSync(join(providersDir, id, 'core.ts'), 'utf8');
  } catch {
    return null;
  }
  const match = source.match(/availability\s*:\s*\{[^}]*?experimental\s*:\s*(true|false)/s);
  return match ? (match[1] === 'true' ? 'Experimental' : 'Stable') : null;
}

/** `id: 'claude', … availability: { experimental: false }` within one bundle. */
function readBundledStability(bundlePath) {
  let source;
  try {
    source = readFileSync(bundlePath, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const match of source.matchAll(
    /id:\s*'([a-zA-Z]+)'[\s\S]{0,600}?availability:\s*\{[^}]*?experimental:\s*(true|false)/g,
  )) {
    out[match[1]] = match[2] === 'true' ? 'Experimental' : 'Stable';
  }
  return out;
}

const YES = 'Yes';
const NO = '—';

function supported(value) {
  if (value === 'supported' || value === true) return YES;
  if (value === 'experimental') return 'Experimental';
  if (value === 'unsupported' || value === false || value == null) return NO;
  return String(value);
}

/**
 * What kind of session modes an agent has, and where the list comes from.
 *
 * This replaced a bare "Plan mode: yes/no" column, which was actively
 * misleading. `supportsPlanMode` is derived from `semantics === 'agent-modes'`
 * and describes whether Happier offers Claude's *dedicated* plan-mode control —
 * not whether the agent has a plan mode at all. Codex's modes arrive over ACP
 * and really can include `plan`; rendering that as a dash told readers the
 * opposite of the truth.
 */
function sessionModesCell(descriptor) {
  if (!descriptor || descriptor.source === 'none') return NO;
  const kind = descriptor.semantics === 'agent-modes' ? 'Agent modes' : 'Policy presets';
  const origin = descriptor.source === 'acp' ? 'from the agent' : 'built in';
  return `${kind}, ${origin}`;
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
  bundlePath = UI_PLUGIN_BUNDLE,
} = {}) {
  const agents = await import(`file://${agentsModulePath}`);
  const cliRuntime = await import(`file://${cliRuntimeModulePath}`);
  const ids = [...agents.AGENT_IDS];
  const stability = collectStability({ providersDir, bundlePath, agentIds: ids });

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
    ['Agent', 'Resume its own sessions', 'Fork a conversation', 'Fork from a message', 'Roll back', 'Declares session listing'],
    ids.map((id) => {
      const c = core(id).sessionCapabilities;
      return [
        `**${name(id)}**`,
        supported(core(id).resume?.vendorResume),
        supported(c.sessionFork?.conversation),
        supported(c.sessionFork?.fromMessage),
        supported(c.sessionRollback?.conversation),
        supported(c.sessionListing),
      ];
    }),
  );

  const runtime = table(
    ['Agent', 'Steer a running turn', 'Session modes', 'Dedicated plan control', 'Accept edits'],
    ids.map((id) => {
      const advanced = agents.getAgentAdvancedModeCapabilities(id);
      return [
        `**${name(id)}**`,
        supported(core(id).runtimeInput?.inFlightSteerSupported),
        sessionModesCell(agents.getAgentSessionModeDescriptor(id)),
        supported(advanced.supportsPlanMode),
        supported(advanced.supportsAcceptEdits),
      ];
    }),
  );

  const mediaTools = table(
    ['Agent', 'Publishes generated media', 'Declares image input', 'Declares native image generation', 'Happier tools', 'Connected Services'],
    ids.map((id) => {
      const m = agents.getAgentMediaCapabilities(id);
      const t = core(id).tools;
      const cs = core(id).connectedServices?.supportedServiceIds ?? [];
      return [
        `**${name(id)}**`,
        supported(m.emitsSessionMedia),
        supported(m.acceptsImageInput),
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

The last column is a declaration rather than a gate — nothing currently reads
it, so it does not decide whether you can browse an agent's own sessions. What
you can actually browse and import is described in
[Browse and import provider sessions](/features/browse-and-import-sessions).

## Running a turn

${runtime}

Steering is what lets you add a correction to a turn already in flight instead
of interrupting it. Where an agent cannot steer, Happier interrupts and resends,
which is slower and loses less than it sounds — see [Steering](/features/steering).

**Session modes are not permission modes.** Where the list comes *from the
agent*, Happier shows whichever modes that build advertises for the session, so
the choices can differ between versions and the Mode control is hidden when the
runtime offers none. A dash under "Dedicated plan control" means Happier has no
plan-specific affordance for that agent — **not** that the agent lacks a plan
mode. Codex, for instance, reaches \`plan\` through the Mode control.

## Media and tools

${mediaTools}

Two of these columns describe what an integration **declares**, not what Happier
enforces, and the distinction matters if you are deciding whether to attach a
screenshot.

**Publishes generated media** is behavioural: Happier reads it when wiring an
agent's runtime, so an agent marked here really can put generated images into a
session.

**Declares image input** and **Declares native image generation** are the
integration's own statements about the agent, and no code path currently gates
on either. In practice, an ACP-backed session attaches your trusted local images
to the prompt regardless of what the manifest says — whether the agent then does
anything useful with them is the agent's business, not Happier's. So treat a
dash in those two columns as "not claimed", not "will be refused", and expect
some declarations to lag the runtime.

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
