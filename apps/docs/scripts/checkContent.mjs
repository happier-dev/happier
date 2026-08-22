/**
 * Content guardrails that run before the Next build.
 *
 * Both checks exist because of defects that shipped and stayed shipped for
 * months, invisible to every other check in the repository:
 *
 *   1. Every `./name` link written inside a section's `index.mdx` was a hard
 *      404. `baseUrl` is `''`, so a section index lives at `/features` with no
 *      trailing slash and the browser resolves `./git` against `/`. Fumadocs'
 *      `createRelativeLink` would normally rewrite it, but only when
 *      `getPageByHref` finds the target — and that lookup is keyed by file path
 *      *with* the `.mdx` extension, which none of the site's relative links
 *      carried. So it silently no-opped on exactly the pages where it mattered.
 *      Leaf pages were unaffected, the sidebar reached every page, and the
 *      build stayed green. Forty of the forty links on the Features landing
 *      page were dead.
 *
 *   2. Sixteen pages sent readers to "Settings → AI provider settings", a menu
 *      item that existed for one day in February 2026 before being renamed. The
 *      docs cannot see `en.ts`, so nothing connected the rename to the pages
 *      describing it. Same shape as "Take over + Sync", "Server settings",
 *      "Resume ID", and the Git toggle labels.
 *
 * The rule both encode: a documented navigation path is a claim about a string
 * that exists somewhere else, and claims need checking.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTENT_ROOT = resolve(HERE, '..', 'content', 'docs');
const DEFAULT_TRANSLATIONS = resolve(HERE, '..', '..', 'ui', 'sources', 'text', 'translations', 'en.ts');
const DEFAULT_AGENT_DEFINITIONS = resolve(
  HERE, '..', '..', '..', 'packages', 'agents', 'src', 'generated', 'bundledAgentDefinitions.ts',
);

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
// `<Card href="…" />` on the section landing pages. These are the most-clicked
// links on the site and the markdown-link pattern does not see them.
const JSX_HREF = /href="([^"]+)"/g;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/gm;

/**
 * Blank the contents of fenced code blocks *in place*, keeping one output line
 * per input line. Deleting the blocks outright shifts every line number after
 * the first fence, which makes the reported location wrong on exactly the long
 * pages where a reader most needs it to be right.
 */
export function maskFencedBlocks(source) {
  let inFence = false;
  return source.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

export function listMdxFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.mdx')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** The route fumadocs serves a content file at, given `baseUrl: ''`. */
export function routeForFile(root, file) {
  let slug = relative(root, file).replace(/\\/g, '/').replace(/\.mdx$/, '');
  if (slug.endsWith('/index')) slug = slug.slice(0, -'/index'.length);
  if (slug === 'index') slug = '';
  return slug ? `/${slug}` : '/';
}

/**
 * github-slugger, to the extent headings here need it: lowercase, drop
 * everything that is not a word character, whitespace or hyphen, then swap
 * spaces for hyphens *without collapsing runs*. The non-collapsing part
 * matters — `realtime + "machine online"` really does produce a double hyphen,
 * and a checker that collapses will report three false failures.
 */
export function slugifyHeading(text) {
  return text
    .replace(/[`*_]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/ /g, '-');
}

function headingAnchors(source) {
  const body = maskFencedBlocks(source).join('\n');
  const anchors = new Set();
  for (const match of body.matchAll(HEADING)) anchors.add(slugifyHeading(match[2]));
  return anchors;
}

/**
 * Every internal link must be root-absolute, prefix-free, and resolve to a real
 * page — and to a real heading when it carries a fragment.
 *
 * Relative forms are rejected rather than resolved. They are why check (1)
 * exists, and one canonical form means a page can be linked identically from
 * anywhere. `/docs/…` is rejected too: it only works via a permanent redirect,
 * so every such link costs a 308 and hides the real route from the reader.
 */
export function checkInternalLinks({ contentRoot = DEFAULT_CONTENT_ROOT } = {}) {
  const files = listMdxFiles(contentRoot);
  const routes = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    routes.set(routeForFile(contentRoot, file), headingAnchors(source));
  }

  const problems = [];
  for (const file of files) {
    const where = relative(contentRoot, file).replace(/\\/g, '/');
    const lines = maskFencedBlocks(readFileSync(file, 'utf8'));
    for (let i = 0; i < lines.length; i += 1) {
      const targets = [
        ...[...lines[i].matchAll(MARKDOWN_LINK)].map((m) => m[2]),
        ...[...lines[i].matchAll(JSX_HREF)].map((m) => m[1]),
      ];
      for (const target of targets) {
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const at = `${where}:${i + 1}`;
        if (/^(\.\.?\/)/.test(target)) {
          problems.push({ at, target, reason: 'relative link — use the root-absolute form (/section/page)' });
          continue;
        }
        if (target.startsWith('/docs/')) {
          problems.push({ at, target, reason: 'legacy /docs prefix — costs a 308 redirect; drop it' });
          continue;
        }
        if (!target.startsWith('/')) {
          problems.push({ at, target, reason: 'not an absolute path' });
          continue;
        }
        const [pathPart, fragment] = target.split('#');
        const route = pathPart.replace(/\/+$/, '') || '/';
        if (!routes.has(route)) {
          problems.push({ at, target, reason: 'no page at this route' });
          continue;
        }
        if (fragment && !routes.get(route).has(fragment)) {
          problems.push({ at, target, reason: `no heading "#${fragment}" on that page` });
        }
      }
    }
  }
  return problems;
}

/**
 * A documented navigation path names strings the app actually renders.
 *
 * Chains are read out of the markup span that contains them — `**Settings →
 * Features → Source control operations**` or the backtick equivalent — rather
 * than out of raw prose. Two reasons. The span boundary is an unambiguous end
 * marker, so `**Settings → Add your phone** on desktop/web when:` yields one
 * segment instead of swallowing the rest of the sentence. And it makes the
 * house style enforceable: a navigation path is a UI label and should be marked
 * up as one, which is also how a reader tells it apart from ordinary prose.
 *
 * Both arrow spellings are accepted. The site overwhelmingly uses `→`, but the
 * two dozen ASCII `->` chains were invisible to this check until now — and one
 * of them was naming a settings row by the wrong label.
 *
 * Scoped to chains rooted at `Settings`. Everything else written with the same
 * arrow notation — an ElevenLabs API-key permission (`Voices → Read`), a form
 * field and its option (`Applies to → One machine`), a SwiftBar menu
 * (`Components → Git cache`) — is a claim about a different UI that this check
 * has no way to adjudicate, and guessing there produces noise that trains
 * people to ignore the failure.
 *
 * Known limitation, stated rather than hidden: a label written outside an arrow
 * chain is not checked. This catches renames of navigation paths, which is
 * where the damage has historically been, not every label mention on the site.
 */
export function checkUiLabels({
  contentRoot = DEFAULT_CONTENT_ROOT,
  translationsFile = DEFAULT_TRANSLATIONS,
  agentDefinitionsFile = DEFAULT_AGENT_DEFINITIONS,
  allow = UI_LABEL_ALLOWLIST,
} = {}) {
  let translations;
  try {
    translations = readFileSync(translationsFile, 'utf8');
  } catch {
    // The client workspace is not always checked out beside the docs (docs-only
    // deploys, for one). Skipping is correct: a missing sibling is not evidence
    // that a label is wrong, and failing here would block a legitimate build.
    return [];
  }
  // Line-scoped on purpose. A whole-file tokenizer de-syncs on the first
  // apostrophe inside a value ("don't") and silently loses most of the file —
  // which reads as "this label does not exist" for thousands of real strings.
  const shipped = new Set();
  // Every quoted string on the line, not just one anchored at its end.
  //
  // Anchoring to end-of-line looks reasonable — most entries are one per line —
  // but it silently drops every label in a multi-property object written inline,
  // e.g. `mobileLayout: { title: 'Mobile session layout', footer: '...' }`. The
  // shipped label is then reported as missing from the app, which is the worst
  // failure mode for this check: it accuses correct documentation of being wrong,
  // and a check that cries wolf gets ignored. Keys in this file are unquoted
  // identifiers, so every quoted run is a value.
  //
  // Still line-scoped. A whole-file tokenizer de-syncs on the first apostrophe
  // inside a value ("don't") and loses most of the file from there on.
  const VALUE = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`${]*)`/g;
  for (const line of translations.split('\n')) {
    for (const match of line.matchAll(VALUE)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value) shipped.add(value.replace(/\\'/g, "'").replace(/\\"/g, '"'));
    }
  }

  // Agent names live in several places and en.ts is only one of them, so the
  // manifest's display names are folded in as well. `Settings -> Agents -> Grok`
  // is a real path whose last segment en.ts has never contained.
  //
  // They are added to the same vocabulary rather than used as a stricter rule
  // for agent rows. A stricter rule was tried and was actively harmful: the
  // manifest says "Kilo CLI" while the Settings screen renders "Kilo", so
  // enforcing the manifest rewrote eleven correct pages into incorrect ones.
  // There is no single authority for this segment, and a check that guesses one
  // produces confident, wrong documentation.
  const agentNames = new Set();
  try {
    const definitions = readFileSync(agentDefinitionsFile, 'utf8');
    for (const match of definitions.matchAll(/"displayName":\s*"([^"]+)"/g)) {
      shipped.add(match[1]);
      agentNames.add(match[1]);
    }
  } catch {
    // Same reasoning as the translations file above: a missing sibling workspace
    // is not evidence that a label is wrong.
  }
  // `settingsAgents.…plugins.<id>: { title: "…" }` — the Settings surface itself,
  // which is the vocabulary a reader following a settings path actually sees.
  const pluginsBlock = /plugins:\s*\{([\s\S]*?)\n\s{8}\}/.exec(translations);
  if (pluginsBlock) {
    for (const match of pluginsBlock[1].matchAll(/title:\s*"([^"]+)"/g)) {
      shipped.add(match[1]);
      agentNames.add(match[1]);
    }
  }

  const problems = [];
  for (const file of listMdxFiles(contentRoot)) {
    const where = relative(contentRoot, file).replace(/\\/g, '/');
    const lines = maskFencedBlocks(readFileSync(file, 'utf8'));
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Another product's settings menu is not a claim about Happier's UI.
      if (FOREIGN_UI.test(line)) continue;
      for (const span of line.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`/g)) {
        const inner = span[1] ?? span[2];
        if (!/→|->/.test(inner)) continue;
        const segments = inner.split(/\s*(?:→|->)\s*/);
        if (segments[0].replace(/[*`_]/g, '').trim() !== 'Settings') continue;
        for (let s = 1; s < segments.length; s += 1) {
          const segment = segments[s].replace(/[*`_]/g, '').trim();
          if (!segment || segment.length > 48) continue;
          if (allow.has(segment) || shipped.has(segment)) continue;
          problems.push({
            at: `${where}:${i + 1}`,
            label: segment,
            reason: 'no such string in apps/ui/sources/text/translations/en.ts',
          });
        }
      }
    }
  }
  return problems;
}

/**
 * Lines walking the reader through a third party's settings — GitHub OAuth app
 * registration, an IdP console — describe a UI this repository does not own.
 */
const FOREIGN_UI = /\b(GitHub|GitLab|Google|Apple|Okta|Auth0|Keycloak|Azure|Cloudflare|Tailscale|Expo|OpenAI|Anthropic)\b/;

/**
 * Segments that are correct prose but are not themselves rendered strings —
 * settings-group headings the app composes, and generic trailing words. Keep
 * this list short: every entry is a claim nothing checks, so an addition should
 * be a considered decision rather than a way to silence a real failure.
 */
export const UI_LABEL_ALLOWLIST = new Set([
  'Settings',
  'Features',
  'the feature you want',
  'and',
]);


const FEATURE_ENV_SCHEMA = resolve(
  HERE, '..', '..', 'server', 'sources', 'app', 'features', 'catalog', 'featureEnvSchema.ts',
);

/**
 * Every `HAPPIER_FEATURE_*` variable the server reads must be documented
 * somewhere on the site.
 *
 * A self-hoster cannot discover these by using the product — an undocumented
 * gate is simply a capability they will never know they can control. Twenty-two
 * of the sixty-seven were undocumented when this check was written, including
 * the ones gating session folders, handoff, the embedded terminal and account
 * pools.
 *
 * Coverage, not placement: the check does not care which page documents a
 * variable, only that one does. Where the sibling server workspace is absent,
 * it skips rather than fails.
 */
export function checkFeatureEnvCoverage({
  contentRoot = DEFAULT_CONTENT_ROOT,
  featureEnvSchemaPath = FEATURE_ENV_SCHEMA,
} = {}) {
  let schema;
  try {
    schema = readFileSync(featureEnvSchemaPath, 'utf8');
  } catch {
    return [];
  }
  const declared = [...new Set([...schema.matchAll(/'(HAPPIER_[A-Z0-9_]+)'/g)].map((m) => m[1]))];
  const published = listMdxFiles(contentRoot)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  return declared
    .filter((name) => !published.includes(name))
    .sort()
    .map((name) => ({
      at: 'deployment/env.mdx',
      label: name,
      reason: 'server feature variable is not documented anywhere on the site',
    }));
}


const CLI_COMMAND_REGISTRY = resolve(HERE, '..', '..', 'cli', 'src', 'cli', 'commandRegistry.ts');

/**
 * Every command the CLI dispatches must be documented somewhere.
 *
 * `happier doctor`, `happier service` and `happier status` — the three commands
 * the setup story rests on — had zero, zero and one mention across the whole
 * site when this check was written, while `hstack doctor`, a contributor-only
 * tool, was documented on eight pages. Nothing connected adding a command to
 * telling anyone it exists.
 *
 * Some commands are deliberately not user-facing; those go in
 * `UNDOCUMENTED_CLI_COMMANDS` with a reason rather than being silently skipped.
 */
export const UNDOCUMENTED_CLI_COMMANDS = new Map([
  ['automations', 'plural alias of `automation`'],
  ['profiles', 'plural alias of `profile`'],
  ['sessions', 'plural alias of `session`'],
  ['bridge', 'internal alias of `mcp` used by MCP hosts'],
  ['capabilities', 'machine-readable capability probe, consumed by clients rather than people'],
]);

export function checkCliCommandCoverage({
  contentRoot = DEFAULT_CONTENT_ROOT,
  registryPath = CLI_COMMAND_REGISTRY,
  allow = UNDOCUMENTED_CLI_COMMANDS,
} = {}) {
  let registry;
  try {
    registry = readFileSync(registryPath, 'utf8');
  } catch {
    return [];
  }
  const commands = [...new Set([...registry.matchAll(/^ {2}([a-z][a-zA-Z-]*):\s*handle/gm)].map((m) => m[1]))];
  const published = listMdxFiles(contentRoot)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  return commands
    .filter((command) => !allow.has(command))
    .filter((command) => !published.includes(`happier ${command}`))
    .sort()
    .map((command) => ({
      at: 'clients/cli.mdx',
      label: `happier ${command}`,
      reason: 'CLI command is not documented anywhere on the site',
    }));
}


/**
 * Every page on disk must be reachable from its section's `meta.json`, and
 * every nav entry must point at something real.
 *
 * This exists because of a bug I shipped: after the features section was
 * regrouped, the generators still wrote to their pre-move `OUTPUT_PATH`, so
 * regenerating recreated pages at the *old* locations. Those duplicates were
 * valid MDX, resolved fine, and were invisible to every other check — they were
 * simply not in any sidebar. A page nobody can navigate to is a page that rots.
 */
export function checkNavCoverage({ contentRoot = DEFAULT_CONTENT_ROOT } = {}) {
  const problems = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const metaPath = join(dir, 'meta.json');
    const pages = entries.filter((e) => e.isFile() && e.name.endsWith('.mdx')).map((e) => e.name.slice(0, -4));
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const where = relative(contentRoot, dir).replace(/\\/g, '/') || '.';

    let listed = null;
    try {
      listed = JSON.parse(readFileSync(metaPath, 'utf8')).pages ?? [];
    } catch {
      if (pages.length) problems.push({ at: `${where}/meta.json`, label: where, reason: 'directory has pages but no meta.json' });
    }
    if (listed) {
      for (const orphan of pages.filter((p) => !listed.includes(p))) {
        problems.push({ at: `${where}/${orphan}.mdx`, label: orphan, reason: 'page is not listed in meta.json, so nothing links to it' });
      }
      for (const phantom of listed.filter((p) => !pages.includes(p) && !dirs.includes(p))) {
        problems.push({ at: `${where}/meta.json`, label: phantom, reason: 'meta.json lists a page that does not exist' });
      }
    }
    for (const sub of dirs) walk(join(dir, sub));
  };
  walk(contentRoot);
  return problems;
}


/**
 * Every agent the app ships should have a page.
 *
 * Five did not: Antigravity, Cursor Agent, oh-my-pi, CodeRabbit and DeepSec
 * were all selectable in Settings with nothing written about them. Nobody
 * noticed because a missing page breaks no link — it is invisible to every
 * other check here.
 *
 * The page name usually follows the agent id, but not always, so genuine
 * exceptions are listed rather than guessed at.
 */
const AGENT_PAGE_ALIASES = new Map([
  ['auggie', 'augment'],   // the page is named for Augment, the vendor
  ['ohMyPi', 'oh-my-pi'],  // kebab-case, matching the project's own name
]);

export function checkAgentPageCoverage({
  contentRoot = DEFAULT_CONTENT_ROOT,
  agentDefinitionsFile = DEFAULT_AGENT_DEFINITIONS,
} = {}) {
  let definitions;
  try {
    definitions = readFileSync(agentDefinitionsFile, 'utf8');
  } catch {
    return [];  // sibling workspace not checked out; not evidence of a gap
  }
  const ids = [...definitions.matchAll(/^\s{2}"([A-Za-z0-9_]+)": Object\.freeze/gm)].map((m) => m[1]);
  if (ids.length === 0) return [];

  const providersDir = join(contentRoot, 'providers');
  let pages;
  try {
    pages = new Set(
      readdirSync(providersDir).filter((f) => f.endsWith('.mdx')).map((f) => f.replace(/\.mdx$/, '')),
    );
  } catch {
    return [];
  }

  const problems = [];
  for (const id of ids) {
    const expected = AGENT_PAGE_ALIASES.get(id) ?? id.toLowerCase();
    if (pages.has(expected)) continue;
    problems.push({
      at: `providers/${expected}.mdx`,
      label: id,
      reason: `agent "${id}" ships in the app but has no page — add one, or map it in AGENT_PAGE_ALIASES`,
    });
  }
  return problems;
}

/**
 * A cross-reference written as a code span is not a link.
 *
 * Twenty-five of them shipped in the form `` `/docs/hstack/setup` ``: not
 * clickable, and carrying a `/docs` prefix that has not been the site's route
 * shape since `baseUrl` became `''`. `checkInternalLinks` rejects that prefix,
 * but only inside a real link — the code-span form slipped straight past it,
 * which is exactly why it survived so long.
 *
 * A trailing file extension is exempt: `/docs/tool-normalization.md` is a path
 * in the repository, not a route on this site, and the prose around those says
 * so.
 */
export function checkRouteCodeSpans({ contentRoot = DEFAULT_CONTENT_ROOT } = {}) {
  const problems = [];
  for (const file of listMdxFiles(contentRoot)) {
    const where = relative(contentRoot, file).replace(/\\/g, '/');
    const lines = maskFencedBlocks(readFileSync(file, 'utf8'));
    for (let i = 0; i < lines.length; i += 1) {
      for (const match of lines[i].matchAll(/`(\/docs\/[^`\s]*)`/g)) {
        if (/\.[a-z]{2,4}$/.test(match[1])) continue;
        problems.push({
          at: `${where}:${i + 1}`,
          label: match[1],
          reason: 'cross-reference written as a code span — make it a link, and drop the /docs prefix',
        });
      }
    }
  }
  return problems;
}

/**
 * A section's `index.mdx` must lead somewhere for every page in its section.
 *
 * `checkNavCoverage` proves the sidebar reaches every page. This proves the
 * *hub* does — and they are not the same claim. `apps/index.mdx` shipped
 * titled "Clients", describing four surfaces, linking two of its own twelve
 * pages and naming the same MCP page twice with different descriptions; the
 * sidebar was complete the whole time, so nothing failed. `self-hosting`
 * hid every authentication page — GitHub, OIDC, mTLS, custom providers — from
 * the one page a self-hoster starts on.
 *
 * A directory entry is satisfied by a link to the sub-hub or to anything under
 * it, since either gets the reader in.
 */
export function checkHubCoverage({ contentRoot = DEFAULT_CONTENT_ROOT } = {}) {
  const problems = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const indexPath = join(dir, 'index.mdx');
    const where = relative(contentRoot, dir).replace(/\\/g, '/') || '.';
    let listed = null;
    try {
      listed = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).pages ?? [];
    } catch {
      listed = null;
    }
    if (listed && entries.some((e) => e.isFile() && e.name === 'index.mdx')) {
      const source = maskFencedBlocks(readFileSync(indexPath, 'utf8')).join('\n');
      const linked = new Set([
        ...[...source.matchAll(MARKDOWN_LINK)].map((m) => m[2]),
        ...[...source.matchAll(JSX_HREF)].map((m) => m[1]),
      ].map((href) => href.split('#')[0].replace(/\/+$/, '')));
      const prefix = where === '.' ? '' : `/${where}`;
      for (const page of listed) {
        if (page === 'index') continue;
        const route = `${prefix}/${page}`;
        const reached = dirs.includes(page)
          ? [...linked].some((href) => href === route || href.startsWith(`${route}/`))
          : linked.has(route);
        if (!reached) {
          problems.push({
            at: `${where}/index.mdx`,
            label: route,
            reason: 'section landing page does not link this page — a reader who starts at the hub never finds it',
          });
        }
      }
    }
    for (const sub of dirs) walk(join(dir, sub));
  };
  walk(contentRoot);
  return problems;
}

export async function runContentChecks(options = {}) {
  const { checkGeneratedPages } = await import('./generateReference.mjs');
  return {
    links: checkInternalLinks(options),
    labels: [
      ...checkUiLabels(options),
      ...checkFeatureEnvCoverage(options),
      ...checkCliCommandCoverage(options),
      ...checkNavCoverage(options),
      ...checkRouteCodeSpans(options),
      ...checkHubCoverage(options),
      ...checkAgentPageCoverage(options),
    ],
    generated: await checkGeneratedPages(options),
  };
}

export function formatProblems({ links, labels, generated = [] }) {
  const out = [];
  if (links.length) {
    out.push(`\n${links.length} broken internal link${links.length === 1 ? '' : 's'}:`);
    for (const p of links) out.push(`  ${p.at}  ${p.target}\n      ${p.reason}`);
  }
  if (labels.length) {
    out.push(`\n${labels.length} documented UI label${labels.length === 1 ? '' : 's'} not found in the app:`);
    for (const p of labels) out.push(`  ${p.at}  "${p.label}"\n      ${p.reason}`);
  }
  if (generated.length) {
    out.push(`\n${generated.length} generated page${generated.length === 1 ? '' : 's'} out of date:`);
    for (const p of generated) out.push(`  ${p.at}\n      ${p.reason}`);
  }
  return out.join('\n');
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const results = await runContentChecks();
  const failures = results.links.length + results.labels.length + results.generated.length;
  if (failures > 0) {
    console.error(formatProblems(results));
    console.error(`\ncontent checks failed: ${failures} problem${failures === 1 ? '' : 's'}\n`);
    process.exit(1);
  }
  console.log('content checks passed: links resolve, documented UI labels exist');
}
