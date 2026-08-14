#!/usr/bin/env node
// @ts-check

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const DEFAULT_CHANGELOG_PATH = resolve(REPO_ROOT, 'apps/ui/CHANGELOG.md');

export const RELEASE_NOTES_BUNDLE_KIND = 'happier.release-notes.projection.v2';

/**
 * Public text limits for channels that do not accept the complete Markdown
 * section. GitHub and the rolling release retain the source Markdown verbatim.
 */
export const APPROVED_PROJECTION_MAX_LENGTHS = Object.freeze({
  expo: 1_024,
  appStore: 4_000,
  playStore: 500,
  storyDeck: 280,
});

const APPROVED_PROJECTION_MARKER = '<!-- happier-release-note-projections:v1';
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const PROJECT_RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRequiredValue(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function trimSectionMarkdown(markdown) {
  return markdown.replace(/^\n+|\n+$/g, '');
}

/**
 * Find exactly one public project-release section. Historic Version headings
 * still delimit the current section during the one-way changelog migration;
 * they are not selectable owners. Level-two headings within a section remain
 * part of the approved Markdown source.
 */
export function parseReleaseNoteSection(changelog, releaseId) {
  const normalizedReleaseId = normalizeRequiredValue(releaseId, '--release-id');
  const lines = String(changelog ?? '').replace(/\r\n?/g, '\n').split('\n');
  const headerPattern = new RegExp(`^## Release ${escapeRegExp(normalizedReleaseId)} - (\\d{4}-\\d{2}-\\d{2})$`);
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(headerPattern);
    if (match) {
      matches.push({ index, date: match[1] });
    }
  }

  if (matches.length === 0) {
    throw new Error(`No exact changelog section found for release ${normalizedReleaseId}`);
  }
  if (matches.length > 1) {
    throw new Error(`Changelog release ${normalizedReleaseId} must appear exactly once; found ${matches.length}`);
  }

  const [{ index: startIndex, date }] = matches;
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && /^## (?:Release|Version) .+ - \d{4}-\d{2}-\d{2}$/.test(line),
  );
  const markdown = trimSectionMarkdown(lines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex).join('\n'));

  return { releaseId: normalizedReleaseId, date, markdown };
}

function stripMarkdownLine(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/(^|[^\w])([*_])([^*_]+)\2(?=$|[^\w])/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfulPublicMarkdown(markdown) {
  const visibleText = String(markdown ?? '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(stripMarkdownLine)
    .filter(Boolean)
    .join(' ');
  return /[\p{L}\p{N}]/u.test(visibleText);
}

function requireExactObject(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const expected = [...expectedKeys].sort((a, b) => a.localeCompare(b));
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function requireAllowedObject(value, requiredKeys, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !allowedKeys.includes(key));
  if (unknown) {
    throw new Error(`${label} contains unsupported projection: ${unknown}`);
  }
  const missing = requiredKeys.find((key) => !Object.hasOwn(value, key));
  if (missing) {
    throw new Error(`${label} requires ${missing}`);
  }
}

function validateApprovedProjection(value, label, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters`);
  }
  return value;
}

/**
 * The bounded channel text is intentionally authored in the same changelog
 * section as the canonical public narrative. The comment is stripped before
 * Markdown publication so it cannot become a second public text source.
 */
function parseApprovedProjections(markdown) {
  const normalized = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const markerPattern = new RegExp(`^${escapeRegExp(APPROVED_PROJECTION_MARKER)}\\n([\\s\\S]*?)\\n-->\\n*`);
  const match = normalized.match(markerPattern);
  if (!match) {
    throw new Error('Missing approved bounded projections at the start of the exact changelog section');
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new Error('Approved bounded projections must contain valid JSON');
  }

  requireAllowedObject(
    parsed,
    ['expo'],
    ['expo', 'appStore', 'playStore', 'storyDeck'],
    'Approved bounded projections',
  );
  requireExactObject(parsed.expo, ['message'], 'expo projection');
  if (parsed.appStore !== undefined) requireExactObject(parsed.appStore, ['whatsNew'], 'appStore projection');
  if (parsed.playStore !== undefined) requireExactObject(parsed.playStore, ['whatsNew'], 'playStore projection');
  if (parsed.storyDeck !== undefined) requireExactObject(parsed.storyDeck, ['summary'], 'storyDeck projection');

  const publicMarkdown = trimSectionMarkdown(normalized.slice(match[0].length));
  if (!hasMeaningfulPublicMarkdown(publicMarkdown)) {
    throw new Error('Exact changelog section must contain meaningful public Markdown after approved bounded projections');
  }

  return {
    markdown: publicMarkdown,
    projections: {
      expo: { message: validateApprovedProjection(parsed.expo.message, 'expo.message', APPROVED_PROJECTION_MAX_LENGTHS.expo) },
      ...(parsed.appStore === undefined ? {} : {
        appStore: { whatsNew: validateApprovedProjection(parsed.appStore.whatsNew, 'appStore.whatsNew', APPROVED_PROJECTION_MAX_LENGTHS.appStore) },
      }),
      ...(parsed.playStore === undefined ? {} : {
        playStore: { whatsNew: validateApprovedProjection(parsed.playStore.whatsNew, 'playStore.whatsNew', APPROVED_PROJECTION_MAX_LENGTHS.playStore) },
      }),
      ...(parsed.storyDeck === undefined ? {} : {
        storyDeck: { summary: validateApprovedProjection(parsed.storyDeck.summary, 'storyDeck.summary', APPROVED_PROJECTION_MAX_LENGTHS.storyDeck) },
      }),
    },
  };
}

function normalizeReleaseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('release input is required');
  }
  const releaseId = normalizeRequiredValue(input.releaseId, '--release-id');
  if (!PROJECT_RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error('releaseId must contain only lowercase letters, digits, dots, underscores, or hyphens');
  }
  const sourceSha = String(input.sourceSha ?? '').trim();
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error('sourceSha must be a full lowercase Git SHA');
  }
  const componentVersions = input.componentVersions;
  if (!componentVersions || typeof componentVersions !== 'object' || Array.isArray(componentVersions)) {
    throw new Error('componentVersions must be an object');
  }
  const normalizedComponents = Object.fromEntries(
    Object.entries(componentVersions)
      .map(([id, version]) => [String(id).trim(), normalizeRequiredValue(version, 'component version')])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (Object.keys(normalizedComponents).length === 0) {
    throw new Error('componentVersions must not be empty');
  }
  for (const id of Object.keys(normalizedComponents)) {
    if (!COMPONENT_ID_PATTERN.test(id)) {
      throw new Error(`Invalid component version id: ${id}`);
    }
  }
  return { releaseId, sourceSha, componentVersions: normalizedComponents };
}

export function buildReleaseNotesBundle(changelog, input) {
  const release = normalizeReleaseInput(input);
  const section = parseReleaseNoteSection(changelog, release.releaseId);
  const approved = parseApprovedProjections(section.markdown);

  return {
    schemaVersion: 2,
    kind: RELEASE_NOTES_BUNDLE_KIND,
    release: {
      id: release.releaseId,
      sourceSha: release.sourceSha,
      components: release.componentVersions,
    },
    changelog: {
      date: section.date,
    },
    projections: {
      github: { markdown: approved.markdown },
      rollingRelease: { markdown: approved.markdown },
      ...approved.projections,
    },
  };
}

export function renderReleaseNotesBundle(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function readFlagValue(argv, index, flag) {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

export function parseProjectionArgs(argv) {
  const values = new Map();
  const componentVersions = new Map();
  const supportedFlags = new Set(['release-id', 'source-sha', 'component-version', 'changelog', 'out', 'repo-root', 'github-output']);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf('=');
    const flagName = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!supportedFlags.has(flagName)) {
      throw new Error(`Unsupported flag: --${flagName}`);
    }
    if (flagName !== 'component-version' && values.has(flagName)) {
      throw new Error(`Duplicate flag: --${flagName}`);
    }

    const value = equalsIndex === -1
      ? readFlagValue(argv, index, `--${flagName}`)
      : arg.slice(equalsIndex + 1);
    if (!value) {
      throw new Error(`--${flagName} requires a value`);
    }
    if (flagName === 'component-version') {
      const equals = value.indexOf('=');
      const id = value.slice(0, equals).trim();
      const version = value.slice(equals + 1).trim();
      if (equals === -1 || !COMPONENT_ID_PATTERN.test(id) || !version) {
        throw new Error('--component-version requires <component>=<version>');
      }
      if (componentVersions.has(id)) {
        throw new Error(`Duplicate component version: ${id}`);
      }
      componentVersions.set(id, version);
    } else {
      values.set(flagName, value);
    }
    if (equalsIndex === -1) {
      index += 1;
    }
  }

  return {
    releaseId: values.get('release-id'),
    sourceSha: values.get('source-sha'),
    componentVersions: Object.fromEntries(componentVersions),
    changelogPath: values.get('changelog') ? resolve(values.get('changelog')) : DEFAULT_CHANGELOG_PATH,
    outPath: values.get('out') ? resolve(values.get('out')) : null,
    repoRoot: values.get('repo-root') ? resolve(values.get('repo-root')) : null,
    githubOutput: values.get('github-output') ? resolve(values.get('github-output')) : null,
  };
}

async function readRepositoryComponentVersions(repoRoot) {
  const ids = ['ui', 'cli', 'stack', 'server'];
  return Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const parsed = JSON.parse(await readFile(resolve(repoRoot, 'apps', id, 'package.json'), 'utf8'));
    return [id, normalizeRequiredValue(parsed.version, `${id} package version`)];
  })));
}

function githubMultiline(name, value) {
  const delimiter = `HAPPIER_RELEASE_NOTES_${createHash('sha256').update(`${name}\0${value}`).digest('hex').slice(0, 20)}`;
  if (String(value).split('\n').includes(delimiter)) throw new Error(`GitHub output delimiter collision for ${name}`);
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const { releaseId, sourceSha, componentVersions, changelogPath, outPath, repoRoot, githubOutput } = parseProjectionArgs(argv);
  if (repoRoot && Object.keys(componentVersions).length > 0) throw new Error('--repo-root cannot be combined with --component-version');
  const release = normalizeReleaseInput({
    releaseId,
    sourceSha,
    componentVersions: repoRoot ? await readRepositoryComponentVersions(repoRoot) : componentVersions,
  });
  const changelog = await readFile(changelogPath, 'utf8');
  const bundle = buildReleaseNotesBundle(changelog, release);
  const rendered = renderReleaseNotesBundle(bundle);

  if (githubOutput) {
    await appendFile(githubOutput,
      githubMultiline('github_markdown', bundle.projections.github.markdown)
      + githubMultiline('expo_message', bundle.projections.expo.message),
      'utf8');
  }

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rendered, 'utf8');
    return bundle;
  }

  if (!githubOutput) process.stdout.write(rendered);
  return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
