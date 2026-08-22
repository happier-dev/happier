/**
 * Renders the complete server feature environment reference from the schema.
 *
 * `FEATURE_ENV_KEYS` in `apps/server/sources/app/features/catalog/featureEnvSchema.ts`
 * is an explicit frozen map — the server reads nothing else — and 65 of its
 * entries appeared on no published page. The gaps were not evenly spread: the
 * server-routed tunnel caps (28 variables), local service public previews (15)
 * and plugin webhook quotas (8) were entirely undocumented, which are exactly
 * the knobs a self-hoster needs when a tunnel or preview starts refusing work.
 *
 * The feature-flag page covers the `__ENABLED` switches that correspond to a
 * catalog flag, because those are a user-visible capability. This page covers
 * every key, including the ~97 tuning knobs that gate no feature and therefore
 * have no catalog entry to hang off.
 *
 * Grouping and ordering follow the source file rather than being re-sorted, so
 * a reader comparing the two sees the same shape, and the explanatory comments
 * the server authors wrote are carried through instead of paraphrased.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SCHEMA = join(REPO, 'apps', 'server', 'sources', 'app', 'features', 'catalog', 'featureEnvSchema.ts');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'self-hosting', 'feature-env.mdx');

/**
 * Read the map in source order, keeping blank-line groups and their comments.
 *
 * A key and its value are frequently split across two lines when the name is
 * long, so entries are matched over the joined body rather than line by line —
 * a per-line match silently drops every wrapped entry, which is 30-odd of them.
 */
export function parseFeatureEnvSchema(source) {
  const body = source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
  const groups = [];
  let current = { comment: '', entries: [] };
  let pendingComment = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (current.entries.length) groups.push(current);
      current = { comment: '', entries: [] };
      pendingComment = [];
      continue;
    }
    if (line.startsWith('//')) {
      pendingComment.push(line.replace(/^\/\/\s?/, ''));
      continue;
    }
    if (pendingComment.length && !current.entries.length) {
      current.comment = pendingComment.join(' ');
      pendingComment = [];
    }
    current.pending = (current.pending ?? '') + ' ' + line;
    const match = /([A-Za-z0-9_]+)\s*:\s*'([A-Z0-9_]+)'/.exec(current.pending);
    if (match) {
      current.entries.push({ property: match[1], key: match[2] });
      current.pending = '';
    }
  }
  if (current.entries.length) groups.push(current);
  return groups;
}

/**
 * Name a group by the longest prefix its variables share.
 *
 * Taking the first underscore segment collapses `BUG_REPORTS` to "Bug" and —
 * worse — gives the mTLS and OAuth groups the same "Auth" heading, so the two
 * sections land on one anchor and half the links into them break. The shared
 * prefix keeps them distinct and reads correctly for mixed groups too:
 * live-stream direct-peer and server-routed variables share
 * `MACHINES_LIVE_STREAM`.
 */
export function groupTitle(entries) {
  const stems = entries.map((e) => e.key.replace(/^HAPPIER_(FEATURE_)?/, '').split('__')[0].split('_'));
  const prefix = [];
  for (let i = 0; i < stems[0].length; i += 1) {
    const segment = stems[0][i];
    if (!stems.every((s) => s[i] === segment)) break;
    prefix.push(segment);
  }
  const chosen = prefix.length ? prefix : stems[0];
  while (chosen.length > 1 && chosen[chosen.length - 1] === 'MAX') chosen.pop();
  const words = chosen.join(' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The schema's comments cite the internal design document by section number.
 * Those are real, but they point at something a self-hoster cannot open, so the
 * prose is kept and the citations dropped.
 */
export function cleanComment(comment) {
  return comment
    .replace(/\s*\(§[^)]*\)/g, '')
    .replace(/\s*§[\d.]+(\/§[\d.]+)*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Split a source group by top-level area, preserving order.
 *
 * The schema keeps one blank-line group holding both the session switches and
 * all 28 machines-tunnel variables. Named by its shared prefix that section
 * reads "Sessions handoff", so the tunnel caps — the most-asked-about knobs on
 * this page — sit under a heading that does not mention machines. Splitting on
 * the first segment puts them under Machines where they are looked for, and the
 * source comment stays with the first part.
 */
export function splitByArea(group) {
  const parts = [];
  for (const entry of group.entries) {
    const area = entry.key.replace(/^HAPPIER_(FEATURE_)?/, '').split('_')[0];
    const last = parts[parts.length - 1];
    if (last && last.area === area) last.entries.push(entry);
    else parts.push({ area, entries: [entry] });
  }
  return parts.map((part, index) => ({
    entries: part.entries,
    comment: index === 0 ? group.comment : '',
  }));
}

/** Two sections sharing a heading share an anchor, and links into one of them break. */
export function ensureUniqueTitles(sections) {
  const seen = new Map();
  return sections.map((section) => {
    let title = section.title;
    if (seen.has(title)) {
      const stem = section.entries[0].key.replace(/^HAPPIER_(FEATURE_)?/, '').split('__')[0];
      title = stem.toLowerCase().replace(/_/g, ' ');
      title = title.charAt(0).toUpperCase() + title.slice(1);
      let n = 2;
      while (seen.has(title)) title = `${section.title} ${n++}`;
    }
    seen.set(title, true);
    return { ...section, title };
  });
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

export async function renderFeatureEnvReferenceMarkdown({ schemaPath = SCHEMA } = {}) {
  const groups = parseFeatureEnvSchema(readFileSync(schemaPath, 'utf8'));
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  const switches = groups.reduce((n, g) => n + g.entries.filter((e) => e.key.endsWith('__ENABLED')).length, 0);

  const sections = ensureUniqueTitles(
    groups.flatMap(splitByArea).map((group) => ({
      title: groupTitle(group.entries),
      comment: group.comment,
      entries: group.entries,
    })),
  )
    .map((section) => {
      const rows = section.entries.map((e) => [
        `\`${e.key}\``,
        e.key.endsWith('__ENABLED') ? 'Switch' : 'Setting',
      ]);
      const note = section.comment ? `\n${cleanComment(section.comment)}\n` : '';
      return `### ${section.title}\n${note}\n${table(['Variable', 'Kind'], rows)}`;
    })
    .join('\n\n');

  return `---
title: Feature environment variables
description: Every HAPPIER_FEATURE_* variable the server reads, generated from the server's feature environment schema.
---

This is the complete list of environment variables the server reads to decide
what it advertises and how much of it a client may use. There are **${total}**, of
which **${switches}** are on/off switches and the rest are limits, timeouts,
policies and header names.

Two kinds of variable are mixed together here on purpose, because the server
treats them the same way:

- **Switches** (\`…__ENABLED\`) turn a capability on or off. When the capability
  also appears in the client feature catalog, it is listed with its flag id on
  [Feature flags](/extras/feature-flags) — start there if you are trying to
  hide or reveal something users can see.
- **Settings** tune a capability that is already on: byte ceilings, rate limits,
  idle timeouts, accepted encodings, certificate header names. Most have no
  catalog flag at all, so this page is the only place they are listed.

<Callout type="info">
  Setting a variable for a capability whose switch is off does nothing. Check
  the switch in the same group first — a tunnel cap that seems to be ignored is
  usually a tunnel feature that was never enabled.
</Callout>

This page is the complete index, so it lists names rather than values.
[Environment variables](/self-hosting/env) carries the defaults, ranges and
worked examples for the ones self-hosters tune most often.

## Variables

Grouped and ordered as the server's schema declares them.

${sections}

## Related

- [Feature flags](/extras/feature-flags) — the capabilities these gate, and which ones users can see.
- [Environment variables](/self-hosting/env) — the rest of the server's configuration.
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderFeatureEnvReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
