import type {
  BotTemplateDraftV1,
  BotTemplateContentV1,
  BotTemplateSkillV1,
} from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type {
  BotTemplateDraftResultV1,
  BotTemplatePreviewResultV1,
} from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { BotTemplateUpdateDiffResultV1Schema, compareThreeWayTextV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';

const text = (value: string) => encodeBase64(new TextEncoder().encode(value));
const skill = (
  key: string,
  description: string,
  body: string,
): BotTemplateSkillV1 => ({
  key,
  title: key,
  bundleSchemaId: 'skills.skill_md_v1',
  entries: [
    {
      path: 'SKILL.md',
      contentKind: 'utf8',
      contentBase64: text(
        `---\nname: ${key}\ndescription: ${description}\n---\n${body}`,
      ),
    },
  ],
});

/** The Release captain of the round-2 lab, so live frames are judged on the lab's content. */
export const SPECIMEN_TEMPLATE_CONTENT: BotTemplateContentV1 = {
  v: 1,
  identity: {
    name: 'Release captain',
    description:
      'Drafts release notes, checks packages for prerelease versions and prepares GitHub releases for a repository. It asks before it tags, publishes or pushes.',
    madeFromName: 'Release captain',
  },
  instructions: {
    markdown:
      'You prepare releases for the repository you’re given. Before drafting, run prerelease-check. Group merged pull requests into Features, Fixes and Sharing, in plain words.\n\nNever publish, tag or push without asking first.',
  },
  memoryRules: [
    { key: 'ask', text: 'Ask before tagging, publishing or pushing anything.' },
    {
      key: 'group',
      text: 'Release notes group changes as Features, Fixes and Sharing.',
    },
    {
      key: 'deps',
      text: 'Skip dependency bumps in notes unless they change behaviour.',
    },
    {
      key: 'handles',
      text: 'Name contributors by their handle, never by email.',
    },
  ],
  skills: [
    skill(
      'prerelease-check',
      'Check bumped packages for prerelease versions',
      'Read every bumped package.json and stop when a version carries a prerelease tag.',
    ),
    skill(
      'release-notes',
      'Group merged pull requests into release notes',
      'List merged pull requests since the last tag and group them as Features, Fixes and Sharing.',
    ),
    skill(
      'github-release-draft',
      'Draft the GitHub release from the notes',
      'Create a draft GitHub release with the notes. Never publish it.',
    ),
  ],
  needs: {
    software: [
      {
        key: 'gh',
        name: 'GitHub CLI',
        requirement: 'required',
        purpose: 'opens pull requests and drafts releases',
        skipConsequence: 'it can’t draft releases',
        recipe: {
          pluginId: 'happier.github',
          recipeId: 'gh-cli',
          revision: '1',
        },
      },
      {
        key: 'release-it',
        name: 'release-it',
        requirement: 'optional',
        purpose: 'bumps and tags versions',
        skipConsequence: 'it drafts releases and you publish them',
        recipe: {
          pluginId: 'happier.node',
          recipeId: 'release-it',
          revision: '1',
        },
      },
    ],
    connectedAccounts: [
      {
        key: 'github',
        name: 'GitHub',
        requirement: 'required',
        purpose: 'reads pull requests in your repositories',
        skipConsequence: 'it can’t read pull requests',
        serviceId: 'github',
      },
      {
        key: 'sentry',
        name: 'Sentry',
        requirement: 'optional',
        purpose: 'links crash reports',
        skipConsequence: 'notes don’t link crash reports',
        serviceId: 'sentry',
      },
    ],
    mcpServers: [
      {
        key: 'linear',
        name: 'Linear',
        requirement: 'optional',
        purpose: 'opens the release task',
        skipConsequence: 'no release task in Linear',
        definition: {
          name: 'linear',
          transport: 'http',
          env: {},
          inputs: [],
          remote: {
            url: {
              baseUrl: { kind: 'literal', value: 'https://mcp.linear.app/mcp' },
              query: [],
            },
            headers: {},
          },
        },
      },
    ],
  },
  suggestedAgent: { agentId: 'claude', modelId: 'opus-5-5' },
  firstTask: 'Draft the release notes for happier since the last tag.',
};

export const SPECIMEN_SOURCE_SESSION = {
  serverId: 'specimen',
  sessionId: 'specimen-release-captain',
} as const;

export const SPECIMEN_TEMPLATE_DRAFT: BotTemplateDraftV1 = {
  v: 1,
  state: 'draft',
  sourceSessionRef: SPECIMEN_SOURCE_SESSION,
  releaseArtifactId: '00000000-0000-4000-8000-0000000000b2',
  content: { ...SPECIMEN_TEMPLATE_CONTENT, memoryRules: [], skills: [] },
  candidates: {
    memoryRules: [
      ...SPECIMEN_TEMPLATE_CONTENT.memoryRules.map((rule) => ({
        ...rule,
        selected: true,
        personal: false,
      })),
      {
        key: 'leeroy-tz',
        text: 'Leeroy works from Lausanne and prefers releases before noon.',
        selected: false,
        personal: true,
      },
      {
        key: 'leeroy-npm',
        text: 'Leeroy’s npm account is the publisher of record.',
        selected: false,
        personal: true,
      },
      {
        key: 'leeroy-review',
        text: 'Leeroy reviews release notes on his phone.',
        selected: false,
        personal: true,
      },
    ],
    skills: [
      { ...SPECIMEN_TEMPLATE_CONTENT.skills[0]!, selection: 'as_is' },
      {
        ...SPECIMEN_TEMPLATE_CONTENT.skills[1]!,
        selection: 'general_copy',
        generalCopy: {
          title: 'release-notes',
          entries: SPECIMEN_TEMPLATE_CONTENT.skills[1]!.entries,
        },
      },
      { ...SPECIMEN_TEMPLATE_CONTENT.skills[2]!, selection: 'as_is' },
      {
        ...skill(
          'happier-packages',
          'Names the happier packages',
          'The happier monorepo publishes @happier-dev/protocol and @happier-dev/cli.',
        ),
        selection: 'private',
      },
    ],
  },
};

export const SPECIMEN_DRAFT_RESULT: BotTemplateDraftResultV1 = {
  draftArtifactId: '00000000-0000-4000-8000-0000000000b1',
  revision: {
    headerVersion: 1,
    bodyVersion: 1,
  } as BotTemplateDraftResultV1['revision'],
  sourceSessionRef: SPECIMEN_SOURCE_SESSION,
  summary: {
    identity: SPECIMEN_TEMPLATE_CONTENT.identity,
    includes: {
      memoryRules: 4,
      skills: 3,
      software: 2,
      connectedAccounts: 2,
      mcpServers: 1,
    },
    leftOut: { memoryRules: 3, skills: 1 },
  },
};

export const SPECIMEN_PREVIEW: BotTemplatePreviewResultV1 = {
  source: {
    kind: 'artifact',
    serverId: 'specimen',
    artifactId: '00000000-0000-4000-8000-0000000000b2',
  },
  release: {
    v: 1,
    version: '1.2.0',
    releasedAtMs: 0,
    changelog: 'Adds the prerelease check.',
    content: SPECIMEN_TEMPLATE_CONTENT,
  },
  presentation: { ownerDisplayName: 'Leeroy Brun', shared: true },
};

const instructionsBase = SPECIMEN_TEMPLATE_CONTENT.instructions.markdown;
const instructionMine = instructionsBase.replace('Features, Fixes and Sharing', 'Features, Fixes and Acknowledgments');
const instructionAuthor = instructionsBase.replace('Features, Fixes and Sharing', 'Features, Fixes and Breaking changes')
  + '\n\nCheck the migration guide for every breaking change.';
const notesBase = new TextDecoder().decode(decodeBase64(SPECIMEN_TEMPLATE_CONTENT.skills[1]!.entries[0]!.contentBase64));
const notesMine = notesBase.replaceAll('Sharing', 'Acknowledgments');
const notesAuthor = notesBase.replaceAll('Sharing', 'Breaking changes');

/** A skill's image both people replaced: binary, so it is chosen whole and shown side by side. */
const banner = (contentBase64: string) => ({ path: 'assets/release-banner.png', contentKind: 'binary' as const, contentBase64 });
const BANNER_BASE = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAABQCAIAAACoK28rAAAAsElEQVR42u3SQQ0AAAgDsfnEAv6/4GNpUgWXy+xBjUiAocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6HB0BgaDA2GBkODoTE0GBoMDYYGQ2NoMDQYGgwNhsbQYGgwNBgaDI2hwdBgaDA0hgZDg6HB0GBoDA2GBkODocHQGBoMDYYGQ4OhMTQYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgMDR0eUGgJzKgqKNkAAAAASUVORK5CYII=';
const BANNER_MINE = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAABQCAIAAACoK28rAAAAsElEQVR42u3SAQ0AAAjDsMvDEo6RgY+nSRUsy+1AjUiAocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6HB0BgaDA2GBkODoTE0GBoMDYYGQ2NoMDQYGgwNhsbQYGgwNBgaDI2hwdBgaDA0hgZDg6HB0GBoDA2GBkODocHQGBoMDYYGQ4OhMTQYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgMDR0e0ZWKRXttH3YAAAAASUVORK5CYII=';
const BANNER_AUTHOR = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAABQCAIAAACoK28rAAAAsElEQVR42u3SAQ0AAAjDsCtCGpqQio+nSRUsy9xCjUiAocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6HB0BgaDA2GBkODoTE0GBoMDYYGQ2NoMDQYGgwNhsbQYGgwNBgaDI2hwdBgaDA0hgZDg6HB0GBoDA2GBkODocHQGBoMDYYGQ4OhMTQYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgMDR0efp6ZZbz7cIMAAAAASUVORK5CYII=';
/** Published two hours before the specimen loads, so the author's note reads as a real release. */
const RELEASED_AT_MS = Date.now() - 2 * 60 * 60 * 1000;

/** Same production review, with deliberately overlapping local/author edits; no mutation port. */
export const SPECIMEN_UPDATE_REVIEW = BotTemplateUpdateDiffResultV1Schema.parse({
  sessionRef: SPECIMEN_SOURCE_SESSION,
  metadataRevision: 3,
  instance: { v: 1, source: SPECIMEN_PREVIEW.source, acceptedVersion: '1.2.0',
    acceptedBase: { serverId: 'specimen', artifactId: '00000000-0000-4000-8000-0000000000b3' },
    skillIds: { 'release-notes': 'specimen-notes', 'release-card': 'specimen-card' }, mcpServerIds: {}, follow: true },
  offer: 'available',
  acceptedSuggestions: { firstTask: SPECIMEN_TEMPLATE_CONTENT.firstTask,
    suggestedAgent: SPECIMEN_TEMPLATE_CONTENT.suggestedAgent },
  upstream: { source: SPECIMEN_PREVIEW.source, revision: { headerVersion: 2, bodyVersion: 2 }, presentation: SPECIMEN_PREVIEW.presentation,
    release: { ...SPECIMEN_PREVIEW.release, version: '1.3.0', releasedAtMs: RELEASED_AT_MS,
      changelog: 'Adds breaking-change notes and migration checks. Your local acknowledgments remain yours to keep.',
      content: { ...SPECIMEN_TEMPLATE_CONTENT, instructions: { markdown: instructionAuthor },
        skills: SPECIMEN_TEMPLATE_CONTENT.skills.map(skill => skill.key === 'release-notes'
          ? { ...skill, entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: text(notesAuthor) }] } : skill) } } },
  instructions: { ref: { serverId: 'specimen', artifactId: 'specimen-instructions' }, title: 'Release instructions',
    revision: { headerVersion: 1, bodyVersion: 4 }, comparison: compareThreeWayTextV1(instructionsBase, instructionMine, instructionAuthor) },
  skills: [{ key: 'release-notes', title: 'release-notes', status: 'existing', canTake: true, skillId: 'specimen-notes', revision: '1',
    files: [{ path: 'SKILL.md', changed: true,
      base: { path: 'SKILL.md', contentKind: 'utf8', contentBase64: text(notesBase) },
      mine: { path: 'SKILL.md', contentKind: 'utf8', contentBase64: text(notesMine) },
      theirs: { path: 'SKILL.md', contentKind: 'utf8', contentBase64: text(notesAuthor) },
      comparison: compareThreeWayTextV1(notesBase, notesMine, notesAuthor) }] },
  { key: 'release-card', title: 'release-card', status: 'existing', canTake: true, skillId: 'specimen-card', revision: '1',
    files: [{ path: 'assets/release-banner.png', changed: true,
      base: banner(BANNER_BASE), mine: banner(BANNER_MINE), theirs: banner(BANNER_AUTHOR) }] }],
  needs: { software: [], connectedAccounts: [], mcpServers: [] },
});
