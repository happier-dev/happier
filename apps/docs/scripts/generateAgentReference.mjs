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
 *     the client makes and the shared package does not model. It also owns each
 *     agent's `displayNameKey`, which resolves through the client's `en.ts` to
 *     the name the AI backends list actually renders. Both are read from source,
 *     and `collectStability` / `collectDisplayNames` throw if any agent is
 *     missing, so a shape change fails loudly here instead of silently
 *     publishing a wrong status column or a raw agent id.
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
const UI_TRANSLATIONS = join(
  REPO, 'apps', 'ui', 'sources', 'text', 'translations', 'en.ts',
);
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'agents', 'capabilities.mdx');

const AGENTS_DIST = join(REPO, 'packages', 'agents', 'dist', 'index.js');
const CLI_RUNTIME_DIST = join(REPO, 'packages', 'agents', 'dist', 'providers', 'providerCliRuntime.js');

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

/**
 * Read the name the app renders for every agent, or fail.
 *
 * This used to be a hand-written map in this file, which is the one thing a
 * generator must never carry: it drifted the moment three agents shipped, and
 * the published page rendered `agy`, `fx` and `droid` as bare ids while the app
 * showed Antigravity, FX and Factory Droid. The name is a product decision the client
 * owns, so it is read where the client owns it — `displayNameKey` on the agent's
 * core config, resolved through the client's English translations.
 */
export function collectDisplayNames({
  providersDir = UI_PROVIDERS,
  bundlePath = UI_PLUGIN_BUNDLE,
  translationsPath = UI_TRANSLATIONS,
  agentIds,
} = {}) {
  const bundled = readBundledDisplayNameKeys(bundlePath);
  let translations;
  try {
    translations = readFileSync(translationsPath, 'utf8');
  } catch {
    throw new Error(`Could not read agent display names: ${translationsPath} is missing.`);
  }

  const names = {};
  const missing = [];
  for (const id of agentIds) {
    const key = readAgentDirDisplayNameKey(providersDir, id) ?? bundled[id] ?? null;
    const value = key === null ? null : readTranslationString(translations, key);
    if (value === null) missing.push(key === null ? id : `${id} (${key})`);
    else names[id] = value;
  }
  if (missing.length) {
    throw new Error(
      `Could not resolve a display name for: ${missing.join(', ')}. ` +
        `Looked for displayNameKey in ${providersDir} and ${bundlePath}, and for its value in ${translationsPath}.`,
    );
  }
  return names;
}

function readAgentDirDisplayNameKey(providersDir, id) {
  let source;
  try {
    source = readFileSync(join(providersDir, id, 'core.ts'), 'utf8');
  } catch {
    return null;
  }
  const match = source.match(/displayNameKey:\s*'([^']+)'/);
  return match ? match[1] : null;
}

/** `id: 'claude', … displayNameKey: 'agentInput.agent.claude'` within one bundle. */
function readBundledDisplayNameKeys(bundlePath) {
  let source;
  try {
    source = readFileSync(bundlePath, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const match of source.matchAll(
    /id:\s*'([a-zA-Z]+)'[\s\S]{0,600}?displayNameKey:\s*'([^']+)'/g,
  )) {
    out[match[1]] = match[2];
  }
  return out;
}

/**
 * Resolve one dotted key out of the client's `en.ts`.
 *
 * `checkContent.mjs` reads that file line by line because it only needs the set
 * of shipped values; a key lookup needs the structure, since the same leaf name
 * lives under a dozen parents. So this walks the object, skipping comments,
 * strings and template expressions — a brace or an apostrophe inside copy must
 * not desynchronise the walk, which is exactly how the naive version of this
 * loses the rest of the file.
 */
function readTranslationString(source, dottedKey) {
  // The locale file is one root object plus a handful of `const …Extension` objects spread into
  // it, so a key can live in either. Try each root and take the first that resolves the whole path.
  for (const root of rootObjectBodies(source)) {
    const value = resolveTranslationInRange(source, root, dottedKey);
    if (value !== null) return value;
  }
  return null;
}

function* rootObjectBodies(source) {
  const declaration = /(?:^|\n)(?:export\s+)?const\s+[A-Za-z0-9_$]+\s*(?::[^=\n]*)?=\s*\{/g;
  let match = declaration.exec(source);
  while (match !== null) {
    const body = objectBody(source, source.indexOf('{', match.index + match[0].length - 1));
    if (body !== null) yield body;
    match = declaration.exec(source);
  }
}

function resolveTranslationInRange(source, range, dottedKey) {
  const segments = dottedKey.split('.');
  let from = range.start;
  let to = range.end;
  for (let i = 0; i < segments.length; i += 1) {
    const valueAt = findPropertyValue(source, from, to, segments[i]);
    if (valueAt === null) return null;
    if (i === segments.length - 1) return readStringLiteral(source, valueAt);
    if (source[valueAt] !== '{') return null;
    const body = objectBody(source, valueAt);
    if (body === null) return null;
    from = body.start;
    to = body.end;
  }
  return null;
}

const IDENTIFIER = /[A-Za-z0-9_$]/;

function endOfString(source, at) {
  const quote = source[at];
  let i = at + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i = endOfBraces(source, i + 1);
      continue;
    }
    i += 1;
  }
  return source.length;
}

function skipCommentOrString(source, at) {
  const ch = source[at];
  if (ch === '"' || ch === "'" || ch === '`') return endOfString(source, at);
  if (ch === '/' && source[at + 1] === '/') {
    const newline = source.indexOf('\n', at + 2);
    return newline === -1 ? source.length : newline + 1;
  }
  if (ch === '/' && source[at + 1] === '*') {
    const close = source.indexOf('*/', at + 2);
    return close === -1 ? source.length : close + 2;
  }
  return at;
}

/** Index just past the `}` that closes the `{` at `at`. */
function endOfBraces(source, at) {
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const next = skipCommentOrString(source, i);
    if (next !== i) { i = next; continue; }
    const ch = source[i];
    if (ch === '{') { depth += 1; i += 1; continue; }
    if (ch === '}') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    i += 1;
  }
  return source.length;
}

function objectBody(source, at) {
  const end = endOfBraces(source, at);
  if (end > source.length) return null;
  return { start: at + 1, end: end - 1 };
}

/** Index of the value of `name` declared directly (not nested) inside `[from, to)`. */
function findPropertyValue(source, from, to, name) {
  let depth = 0;
  let i = from;
  while (i < to) {
    const next = skipCommentOrString(source, i);
    if (next !== i) { i = next; continue; }
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '[') { depth += 1; i += 1; continue; }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      i += 1;
      if (depth < 0) return null;
      continue;
    }
    if (IDENTIFIER.test(ch)) {
      let end = i;
      while (end < to && IDENTIFIER.test(source[end])) end += 1;
      if (depth === 0 && source.slice(i, end) === name) {
        let colon = end;
        while (colon < to && /\s/.test(source[colon])) colon += 1;
        if (source[colon] === ':') {
          let value = colon + 1;
          while (value < to && /\s/.test(source[value])) value += 1;
          return value;
        }
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return null;
}

function readStringLiteral(source, at) {
  const quote = source[at];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  const raw = source.slice(at + 1, endOfString(source, at) - 1);
  if (quote === '`' && raw.includes('${')) return null;
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, escape) => {
    if (escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (escape === 'n') return '\n';
    if (escape === 't') return '\t';
    return escape;
  });
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
 * and cannot establish whether a negotiated ACP catalog contains `plan`.
 * Both agent modes and policy presets can expose it through the Mode control.
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

export function toolsCell(tools) {
  if (!tools || tools.support === 'unsupported' || tools.delivery === 'unsupported') return NO;
  return `${supported(tools.support)} (\`${tools.delivery}\`)`;
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
  translationsPath = UI_TRANSLATIONS,
} = {}) {
  const agents = await import(`file://${agentsModulePath}`);
  const cliRuntime = await import(`file://${cliRuntimeModulePath}`);
  const ids = [...agents.AGENT_IDS];
  const stability = collectStability({ providersDir, bundlePath, agentIds: ids });
  const displayNames = collectDisplayNames({ providersDir, bundlePath, translationsPath, agentIds: ids });

  const name = (id) => displayNames[id];
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
    ['Agent', 'Resume by agent session ID', 'Fork a conversation', 'Fork from a message', 'Roll back', 'Browse resume candidates'],
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
      const descriptor = agents.getAgentSessionModeDescriptor(id);
      return [
        `**${name(id)}**`,
        supported(core(id).runtimeInput?.inFlightSteerSupported),
        sessionModesCell(descriptor),
        descriptor.source === 'acp' ? 'Runtime-dependent' : supported(advanced.supportsPlanMode),
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
        toolsCell(t),
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
[Server feature flags](/extras/feature-flags) for the latter.

## Agents at a glance

${overview}

Where the managed-install column names a package, Happier can install the agent
for you from the machine's detail screen. Where it says the vendor's own
installer, run that first — see the agent's own page for the exact command.

**Custom ACP** is not a bundled agent. It is how you point Happier at any agent
that speaks the Agent Client Protocol, so its row describes the adapter rather
than a particular vendor. See [Custom ACP](/agents/custom-acp).

Several subcommands accept aliases, so the name you already have in your fingers
usually works: ${aliased.join('; ')}.

## Sessions

Resume, browse, fork and roll back are the four things people most often assume
work everywhere. They do not.

${sessions}

"Resume by agent session ID" means Happier can pass a saved agent-owned ID back
to that agent. It does not establish that the interactive terminal and ACP use
the same session IDs. "Fork" means the agent's own runtime can branch a
conversation; where it cannot, Happier's replay fork still works, because that
is Happier's own mechanism rather than the agent's. See
[Session forking](/sessions/session-forking).

The last column means Happier offers a browser for the agent's resume
candidates. FX and Kimi use the shared ACP \`session/list\` source; agents with
dedicated session integrations use their own established sources. An ACP-listed
result only starts a Happier-controlled resume, and the live handshake still
decides whether the installed agent can list sessions. Listing does not
establish terminal/ACP identity, live takeover, writer safety, transcript
following, transcript import, or terminal attachment. See
[Continuing a session](/sessions/continuing-a-session) for the distinct session
continuation paths.

## Running a turn

${runtime}

Steering is what lets you add a correction to a turn already in flight instead
of interrupting it. Where an agent cannot steer, Happier interrupts and resends,
which is slower and loses less than it sounds — see [Steering](/sessions/steering).

**Session modes are not permission modes.** Where the list comes *from the
agent*, Happier shows whichever modes that build advertises for the session, so
the choices can differ between versions and the Mode control is hidden when the
runtime offers none. "Runtime-dependent" under "Dedicated plan control" means
Plan is available only when the session advertises a \`plan\` mode or policy
preset. Codex, for instance, reaches \`plan\` through the Mode control. A dash
means Happier declares no plan-specific affordance for that agent.

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

Agents whose background checks are manual only are not re-probed on a timer.
Whether a manual refresh can resolve a status depends on the agent's configured
status check; an agent-managed row may remain **Unknown** even when Happier can
open its login flow. See [Agent authentication](/agents/provider-authentication).

## Related

- [Coding agents](/agents) — one page per agent, with setup and known limits.
- [Model and engine selection](/agents/model-and-engine-selection)
- [Server feature flags](/extras/feature-flags)
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  const markdown = await renderAgentReferenceMarkdown();
  writeFileSync(OUTPUT_PATH, markdown, 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
