import { describe, expect, it } from 'vitest';

import {
  decodeAzureConnectionData,
  decodeAzureProjectRow,
  decodeAzurePullRequestRow,
  decodeAzureRepositoryRow,
  decodeAzureRowPage,
  truncateUtf8,
} from './decode.js';
import { MAX_AZURE_ROW_FACTS, MAX_AZURE_TEXT_UTF8_BYTES, mapAzurePullRequestEntry } from './mapping.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import type {
  AzureDevOpsOrigin,
  AzureProjectRow,
  AzurePullRequestRow,
  AzureRepositoryRow,
} from './types.js';
import authoredPage from './fixtures/pullRequests.authored.page1.json';
import connectionData from './fixtures/connectionData.json';
import malformedRowPage from './fixtures/pullRequests.malformedRow.json';
import projectsPage1 from './fixtures/projects.page1.json';
import repositoriesFixture from './fixtures/repositories.json';
import reviewerPage from './fixtures/pullRequests.reviewer.page1.json';

const VIEWER_ID = 'd6245f20-2af8-44f4-9451-8107cb2767db';
const OTHER_ID = '19d9411e-9a1a-4b06-9f6c-7bd1b2b7cbc4';
const GATEWAY_REPOSITORY_ID = '5febef5a-833d-4e14-b9c0-14cb638f91e6';

function origin(): AzureDevOpsOrigin {
  const result = normalizeAzureDevOpsBaseUrl('https://dev.azure.com/AcmeOrg');
  if (!result.ok) throw new Error('fixture origin must normalize');
  return result.origin;
}

function project(): AzureProjectRow {
  const decoded = decodeAzureProjectRow(projectsPage1.value[0]);
  if (decoded === null) throw new Error('fixture project must decode');
  return decoded;
}

function gatewayRepository(): AzureRepositoryRow {
  const page = decodeAzureRowPage(repositoriesFixture, decodeAzureRepositoryRow);
  const repository = page?.rows.find((row) => row.id === GATEWAY_REPOSITORY_ID);
  if (!repository) throw new Error('fixture repository must decode');
  return repository;
}

function rowAt(page: unknown, index: number): AzurePullRequestRow {
  const decoded = decodeAzureRowPage(page, decodeAzurePullRequestRow);
  const row = decoded?.rows[index];
  if (!row) throw new Error(`fixture pull request ${index} must decode`);
  return row;
}

describe('truncateUtf8', () => {
  it('shortens on a code-point boundary rather than splitting a character', () => {
    const result = truncateUtf8('🚀🚀🚀', 5);
    expect(result.truncated).toBe(true);
    expect(result.value).toBe('🚀');
  });

  it('leaves a value inside the bound untouched', () => {
    expect(truncateUtf8('short', 64)).toEqual({ value: 'short', truncated: false });
  });
});

describe('provider row decoding', () => {
  it('decodes the recorded project, repository and connection-data shapes', () => {
    expect(project()).toEqual({
      id: '3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42',
      name: 'Payments',
      state: 'wellFormed',
    });
    expect(gatewayRepository().name).toBe('gateway');
    expect(decodeAzureConnectionData(connectionData)).toEqual({
      authenticatedUserId: VIEWER_ID,
      authenticatedUserDisplayName: 'Alex Rivera',
      deploymentType: 'hosted',
      instanceId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    });
  });

  it('keeps the valid rows beside a malformed one and reports the raw cardinality', () => {
    const page = decodeAzureRowPage(malformedRowPage, decodeAzurePullRequestRow);
    expect(page?.rawCardinality).toBe(3);
    expect(page?.undecodable).toBe(1);
    expect(page?.rows.map((row) => row.pullRequestId)).toEqual([51, 53]);
  });

  it('rejects an envelope without a value array rather than reporting an empty page', () => {
    expect(decodeAzureRowPage({ count: 0 }, decodeAzurePullRequestRow)).toBeNull();
    expect(decodeAzureRowPage([], decodeAzurePullRequestRow)).toBeNull();
  });

  it('drops a row whose repository id is not a GUID instead of keying it by name', () => {
    expect(decodeAzurePullRequestRow({
      pullRequestId: 7,
      repository: { id: 'gateway', name: 'gateway' },
      status: 'active',
      title: 'Named repository',
    })).toBeNull();
  });

  it('reads the reviewer vote, the tags, and the stored completion options as facts', () => {
    const draftRow = rowAt(authoredPage, 1);
    expect(draftRow.isDraft).toBe(true);
    expect(draftRow.autoCompleteSetBy?.id).toBe(VIEWER_ID);
    expect(draftRow.hasStoredCompletionOptions).toBe(true);
    expect(rowAt(authoredPage, 0).labels).toEqual(['infrastructure']);
    expect(rowAt(reviewerPage, 1).reviewers.map((reviewer) => reviewer.vote)).toEqual([10, -5]);
  });

  it('returns null for a relative provider URL instead of a resolvable-looking string', () => {
    const decoded = decodeAzureRepositoryRow({
      id: GATEWAY_REPOSITORY_ID,
      name: 'gateway',
      project: { id: '3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42', name: 'Payments' },
      webUrl: '/AcmeOrg/Payments/_git/gateway',
    });
    expect(decoded?.webUrl).toBeNull();
  });
});

describe('mapAzurePullRequestEntry', () => {
  const base = { origin: origin(), project: project(), repository: gatewayRepository() };

  it('maps an authored pull request to author involvement with GUID-scoped identity', () => {
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: rowAt(authoredPage, 0),
      lane: 'authored',
      viewerId: VIEWER_ID,
    });

    expect(entry?.kindId).toBe('pull-request');
    expect(entry?.entryId).toBe('22');
    expect(entry?.collisionScope).toContain(`:${GATEWAY_REPOSITORY_ID}`);
    expect(entry?.collisionScope).not.toContain('Payments');
    expect(entry?.involvement).toBe('author');
    expect(entry?.locator.repositoryKey).toBe('AcmeOrg/Payments/gateway');
    expect(entry?.presentation).toBe('active');
    expect(entry?.nativeLabel).toBe('Active');
    expect(entry?.headCommitId).toBe('b60280bc6e62e2f880f1b63c1e24987664d3bda3');
    expect(entry?.baseCommitId).toBe('f8e5f8b3a1c0d4e7b26a19f0c53d7188a4e6c2b9');
  });

  it('maps the reviewer lane with a zero vote to reviewRequested', () => {
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: rowAt(reviewerPage, 0),
      lane: 'reviewer',
      viewerId: VIEWER_ID,
    });
    expect(entry?.involvement).toBe('reviewRequested');
  });

  it('derives participation only from the viewer own non-zero vote and keeps the native fact', () => {
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: rowAt(reviewerPage, 1),
      lane: 'reviewer',
      viewerId: VIEWER_ID,
    });
    expect(entry?.involvement).toBe('participating');
    expect(entry?.facts).toContainEqual({
      kind: 'reviewerVote',
      reviewerId: VIEWER_ID,
      vote: 10,
      nativeLabel: 'Approved',
    });
  });

  it('does not turn another reviewer non-zero vote into viewer participation', () => {
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: rowAt(reviewerPage, 1),
      lane: 'reviewer',
      viewerId: OTHER_ID,
    });
    expect(entry?.involvement).toBe('participating');

    const unrelated = mapAzurePullRequestEntry({
      ...base,
      row: rowAt(reviewerPage, 0),
      lane: 'reviewer',
      viewerId: OTHER_ID,
    });
    expect(unrelated?.involvement).toBe('reviewRequested');
  });

  it('discloses draft and auto-complete as row facts', () => {
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: rowAt(authoredPage, 1),
      lane: 'authored',
      viewerId: VIEWER_ID,
    });
    expect(entry?.isDraft).toBe(true);
    expect(entry?.facts).toContainEqual({ kind: 'draft' });
    expect(entry?.facts).toContainEqual({ kind: 'autoCompleteEnabled', enabledById: VIEWER_ID });
  });

  it.each([
    ['active', 'active', 'Active'],
    ['completed', 'closed', 'Completed'],
    ['abandoned', 'closed', 'Abandoned'],
  ] as const)('maps native %s to %s presentation', (status, presentation, nativeLabel) => {
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: { ...rowAt(authoredPage, 0), status },
      lane: 'authored',
      viewerId: VIEWER_ID,
    });
    expect(entry?.presentation).toBe(presentation);
    expect(entry?.nativeLabel).toBe(nativeLabel);
  });

  it('keeps an oversize valid entry visible, bounded, and flagged as truncated', () => {
    const row = rowAt(authoredPage, 0);
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: {
        ...row,
        title: 'x'.repeat(20_000),
        labels: Array.from({ length: 300 }, (_unused, index) => `label-${index}`),
      },
      lane: 'authored',
      viewerId: VIEWER_ID,
    });

    expect(entry).not.toBeNull();
    expect(entry?.entryId).toBe('22');
    expect(new TextEncoder().encode(entry?.title ?? '').length).toBeLessThanOrEqual(MAX_AZURE_TEXT_UTF8_BYTES);
    expect(entry?.facts.length).toBeLessThanOrEqual(MAX_AZURE_ROW_FACTS);
    expect(entry?.projectionTruncated).toBe(true);
  });

  it('refuses a row that names a different repository than the one being walked', () => {
    const row = rowAt(authoredPage, 0);
    const entry = mapAzurePullRequestEntry({
      ...base,
      row: { ...row, repositoryId: 'a0d3f2b1-6c88-4d2e-b3f9-1e5c7a904b6d' },
      lane: 'authored',
      viewerId: VIEWER_ID,
    });
    expect(entry).toBeNull();
  });
});
