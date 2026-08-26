import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import { GITHUB_PLUGIN_ID } from './observations/githubProviderContracts.js';

export const GITHUB_AUTOMATION_EVENT_LOCAL_IDS = Object.freeze({
  issueOpened: 'automation/issue-opened-v1',
  pullRequestMerged: 'automation/pull-request-merged-v1',
  pullRequestOpened: 'automation/pull-request-opened-v1',
  push: 'automation/repository-pushed-v1',
} as const);

export type GithubAutomationEventKindV1 = keyof typeof GITHUB_AUTOMATION_EVENT_LOCAL_IDS;
export type GithubAutomationEventLocalIdV1 = (typeof GITHUB_AUTOMATION_EVENT_LOCAL_IDS)[GithubAutomationEventKindV1];

export type GithubAutomationEventRefV1 = Readonly<{
  pluginId: typeof GITHUB_PLUGIN_ID;
  localId: GithubAutomationEventLocalIdV1;
}>;

export type GithubAutomationEventRepositoryV1 = Readonly<{
  repositoryId: string;
  nameWithOwner: string;
}>;

export type GithubAutomationEventPayloadV1 =
  | Readonly<{
      repository: GithubAutomationEventRepositoryV1;
      ref: string;
      before: string;
      after: string;
    }>
  | Readonly<{
      repository: GithubAutomationEventRepositoryV1;
      issue: Readonly<{ id: string; number: number; title: string }>;
    }>
  | Readonly<{
      repository: GithubAutomationEventRepositoryV1;
      pullRequest: Readonly<{ id: string; number: number; title: string }>;
    }>
  | Readonly<{
      repository: GithubAutomationEventRepositoryV1;
      pullRequest: Readonly<{ id: string; number: number; mergeCommitSha: string }>;
    }>;

export type GithubAutomationEventFactsV1 =
  | Readonly<{
      kind: 'push';
      repository: GithubAutomationEventRepositoryV1;
      ref: string;
      before: string;
      after: string;
    }>
  | Readonly<{
      kind: 'issueOpened';
      repository: GithubAutomationEventRepositoryV1;
      issue: Readonly<{ id: string; number: number; title: string }>;
    }>
  | Readonly<{
      kind: 'pullRequestOpened';
      repository: GithubAutomationEventRepositoryV1;
      pullRequest: Readonly<{ id: string; number: number; title: string }>;
    }>
  | Readonly<{
      kind: 'pullRequestMerged';
      repository: GithubAutomationEventRepositoryV1;
      pullRequest: Readonly<{ id: string; number: number; mergeCommitSha: string }>;
    }>;

const REPOSITORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repositoryId: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
    nameWithOwner: { type: 'string', minLength: 3, maxLength: 512 },
  },
  required: ['repositoryId', 'nameWithOwner'],
} satisfies PluginJsonSchema;

const ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
    number: { type: 'integer', minimum: 1 },
    title: { type: 'string', maxLength: 1024 },
  },
  required: ['id', 'number', 'title'],
} satisfies PluginJsonSchema;

const PULL_REQUEST_OPENED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
    number: { type: 'integer', minimum: 1 },
    title: { type: 'string', maxLength: 1024 },
  },
  required: ['id', 'number', 'title'],
} satisfies PluginJsonSchema;

const PULL_REQUEST_MERGED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
    number: { type: 'integer', minimum: 1 },
    mergeCommitSha: { type: 'string', minLength: 1, maxLength: 512 },
  },
  required: ['id', 'number', 'mergeCommitSha'],
} satisfies PluginJsonSchema;

function payloadSchema(
  properties: Readonly<Record<string, PluginJsonSchema>>,
  required: readonly string[],
): PluginJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { repository: REPOSITORY_SCHEMA, ...properties },
    required: ['repository', ...required],
  };
}

export const GITHUB_AUTOMATION_EVENT_CATALOG = Object.freeze([
  Object.freeze({
    kind: 'issueOpened' as const,
    localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened,
    title: 'GitHub issue opened',
    description: 'A new issue was opened in a GitHub repository.',
    payloadSchema: payloadSchema({ issue: ISSUE_SCHEMA }, ['issue']),
  }),
  Object.freeze({
    kind: 'pullRequestMerged' as const,
    localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestMerged,
    title: 'GitHub pull request merged',
    description: 'A pull request was merged in a GitHub repository.',
    payloadSchema: payloadSchema({ pullRequest: PULL_REQUEST_MERGED_SCHEMA }, ['pullRequest']),
  }),
  Object.freeze({
    kind: 'pullRequestOpened' as const,
    localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened,
    title: 'GitHub pull request opened',
    description: 'A new pull request was opened in a GitHub repository.',
    payloadSchema: payloadSchema({ pullRequest: PULL_REQUEST_OPENED_SCHEMA }, ['pullRequest']),
  }),
  Object.freeze({
    kind: 'push' as const,
    localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.push,
    title: 'GitHub repository pushed',
    description: 'Commits were pushed to a GitHub repository ref.',
    payloadSchema: payloadSchema({
      ref: { type: 'string', minLength: 1, maxLength: 512 },
      before: { type: 'string', minLength: 1, maxLength: 512 },
      after: { type: 'string', minLength: 1, maxLength: 512 },
    }, ['ref', 'before', 'after']),
  }),
]);

const GITHUB_AUTOMATION_EVENT_LOCAL_ID_SET = new Set<GithubAutomationEventLocalIdV1>(
  Object.values(GITHUB_AUTOMATION_EVENT_LOCAL_IDS),
);

export function isGithubAutomationEventLocalId(value: string): value is GithubAutomationEventLocalIdV1 {
  return GITHUB_AUTOMATION_EVENT_LOCAL_ID_SET.has(value as GithubAutomationEventLocalIdV1);
}

export function githubAutomationEventRef(kind: GithubAutomationEventKindV1): GithubAutomationEventRefV1 {
  return Object.freeze({
    pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS[kind],
  });
}

export function normalizeGithubAutomationEvent(input: GithubAutomationEventFactsV1): Readonly<{
  eventRef: GithubAutomationEventRefV1;
  payload: GithubAutomationEventPayloadV1;
}> {
  const eventRef = githubAutomationEventRef(input.kind);
  switch (input.kind) {
    case 'push':
      return Object.freeze({
        eventRef,
        payload: Object.freeze({
          repository: input.repository,
          ref: input.ref,
          before: input.before,
          after: input.after,
        }),
      });
    case 'issueOpened':
      return Object.freeze({ eventRef, payload: Object.freeze({ repository: input.repository, issue: input.issue }) });
    case 'pullRequestOpened':
    case 'pullRequestMerged':
      return Object.freeze({
        eventRef,
        payload: Object.freeze({ repository: input.repository, pullRequest: input.pullRequest }),
      });
  }
}
