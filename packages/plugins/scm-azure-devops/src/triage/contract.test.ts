import {
  MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACTS_V1,
  TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
  TriageSourceDescriptorV1Schema,
  TriageSourceFailureV1Schema,
  TriageSourceInstanceConfigurationV1Schema,
  TriageSourceScanObservationV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  AZURE_DEVOPS_TRIAGE_DESCRIPTOR,
  AZURE_DEVOPS_TRIAGE_KIND_ID,
  AZURE_DEVOPS_TRIAGE_PURPOSE,
} from './descriptor.js';
import {
  buildAzureLocalInstanceKey,
  decodeAzureSourceConfiguration,
  encodeAzureSourceConfiguration,
} from './configuration.js';
import { buildAzureCollisionScope, encodeBase64Url } from './identity.js';
import { projectAzureSourceFailure } from './failureProjection.js';
import { parseAzureEntryLocalRef } from './localRef.js';
import { projectAzurePresentObservation } from './observation.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import type { AzureDevOpsFailure, AzureDevOpsOrigin, AzurePullRequestEntry } from './types.js';

function origin(raw = 'https://dev.azure.com/acme'): AzureDevOpsOrigin {
  const result = normalizeAzureDevOpsBaseUrl(raw);
  if (!result.ok) throw new Error(`fixture base is not normalizable: ${raw}`);
  return result.origin;
}

const REPOSITORY_ID = 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
/** The published single-line grammar, read from its owner rather than restated. */
const SINGLE_LINE = new RegExp(TRIAGE_SINGLE_LINE_STRING_PATTERN_V1, 'u');

function collisionScope(base: AzureDevOpsOrigin = origin()): string {
  const scope = buildAzureCollisionScope({ origin: base, repositoryId: REPOSITORY_ID });
  if (scope === null) throw new Error('fixture repository id is not a GUID');
  return scope;
}

function entry(overrides: Partial<AzurePullRequestEntry> = {}): AzurePullRequestEntry {
  const base = origin();
  return {
    kindId: 'pull-request',
    collisionScope: collisionScope(base),
    entryId: '17',
    locator: {
      forgeHostId: base.forgeHostId,
      deploymentBaseUrl: base.baseUrl,
      repositoryKey: 'acme/Payments/checkout',
      organizationOrCollection: 'acme',
      projectId: '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d',
      projectName: 'Payments',
      repositoryId: REPOSITORY_ID,
      repositoryName: 'checkout',
      webUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
    },
    title: 'Consolidate the duplicated normalizer',
    state: 'active',
    presentation: 'active',
    nativeLabel: 'Active',
    isDraft: false,
    authorId: 'a0d31c2e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    authorDisplayName: 'Ada',
    createdAt: '2026-08-01T10:00:00Z',
    closedAt: null,
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    headCommitId: 'b3f1c0a9d2e4',
    baseCommitId: 'a1b2c3d4e5f6',
    mergeStatus: 'succeeded',
    involvement: 'reviewRequested',
    facts: [],
    projectionTruncated: false,
    ...overrides,
  };
}

describe('Azure DevOps Triage descriptor', () => {
  it('declares the pull-request-only kind vocabulary through the published schema', () => {
    const parsed = TriageSourceDescriptorV1Schema.parse(AZURE_DEVOPS_TRIAGE_DESCRIPTOR);
    expect(parsed.purpose).toBe(AZURE_DEVOPS_TRIAGE_PURPOSE);
    expect(parsed.kinds.map((kind) => kind.id)).toEqual([AZURE_DEVOPS_TRIAGE_KIND_ID]);
    expect(parsed.kinds[0]?.workflowSubject).toBe('pullRequest');
  });
});

describe('Azure DevOps source configuration token', () => {
  it('round-trips exactly the normalized configured base and nothing else', () => {
    const token = encodeAzureSourceConfiguration(origin());
    expect(TriageSourceInstanceConfigurationV1Schema.parse(token)).toEqual(token);
    const decoded = decodeAzureSourceConfiguration(token);
    expect(decoded?.baseUrl).toBe('https://dev.azure.com/acme');
    expect(JSON.parse(token.token)).toEqual({ v: 1, baseUrl: 'https://dev.azure.com/acme' });
  });

  it('rejects a token carrying a credential, an unknown field, or a non-https base', () => {
    for (const raw of [
      '{"v":1,"baseUrl":"https://user:pat@dev.azure.com/acme"}',
      '{"v":1,"baseUrl":"https://dev.azure.com/acme","token":"secret"}',
      '{"v":1,"baseUrl":"http://dev.azure.com/acme"}',
      '{"v":2,"baseUrl":"https://dev.azure.com/acme"}',
      'not-json',
    ]) {
      expect(decodeAzureSourceConfiguration({ v: 1, token: raw })).toBeNull();
    }
  });

  it('keys the instance by the normalized base rather than by the account', () => {
    expect(buildAzureLocalInstanceKey(origin())).toBe('https://dev.azure.com/acme');
    expect(buildAzureLocalInstanceKey(origin('https://DEV.Azure.com:443/acme')))
      .toBe('https://dev.azure.com/acme');
    // A Server collection path is case-significant and must not collapse.
    expect(buildAzureLocalInstanceKey(origin('https://tfs.example.com/tfs/DefaultCollection')))
      .toBe('https://tfs.example.com/tfs/DefaultCollection');
  });
});

describe('Azure DevOps local entry references', () => {
  it('accepts only a ref whose collision scope was derived from this exact configured base', () => {
    const observation = projectAzurePresentObservation({ entry: entry(), involvement: ['author'] });
    const parsed = parseAzureEntryLocalRef(observation.localRef, origin());
    expect(parsed).toEqual({ repositoryId: REPOSITORY_ID, pullRequestId: 17 });
    expect(parseAzureEntryLocalRef(observation.localRef, origin('https://dev.azure.com/other')))
      .toBeNull();
  });

  it('rejects an undeclared kind, a non-GUID repository, and a non-positive entry id', () => {
    const valid = projectAzurePresentObservation({
      entry: entry(),
      involvement: ['author'],
    }).localRef;
    expect(parseAzureEntryLocalRef({ ...valid, kindId: 'issue' }, origin())).toBeNull();
    expect(parseAzureEntryLocalRef(
      { ...valid, collisionScope: `azure-devops:${collisionScope().split(':')[1]}:checkout` },
      origin(),
    )).toBeNull();
    expect(parseAzureEntryLocalRef({ ...valid, entryId: '0' }, origin())).toBeNull();
    expect(parseAzureEntryLocalRef({ ...valid, entryId: '17abc' }, origin())).toBeNull();
  });
});

describe('Azure DevOps collision scope bound', () => {
  // A Server collection base is far longer than a `dev.azure.com` one and base64url inflates
  // it by a third, so the composed scope really can exceed its published ceiling.
  const ON_PREM_BASE =
    'https://azuredevops.emea.corporate-services.contoso-manufacturing.example.com'
    + '/tfs/PlatformEngineeringCollection';

  it('emits a scope within the published ceiling for an ordinary configured base', () => {
    const scope = collisionScope();
    expect(new TextEncoder().encode(scope).byteLength)
      .toBeLessThanOrEqual(MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1);
  });

  it('omits a row whose scope cannot fit rather than rejecting the page it arrived on', () => {
    const base = origin(ON_PREM_BASE);
    const composed = `azure-devops:${encodeBase64Url(base.baseUrl)}:${REPOSITORY_ID}`;
    // RED basis: the composed scope really is over the ceiling for this real Server base.
    expect(new TextEncoder().encode(composed).byteLength)
      .toBeGreaterThan(MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1);
    // The target rejects an over-bound result ATOMICALLY, so emitting it would discard every
    // sibling row on the same scan page. The row is omitted and counted here instead.
    expect(buildAzureCollisionScope({ origin: base, repositoryId: REPOSITORY_ID })).toBeNull();
  });
});

describe('Azure DevOps failure projection', () => {
  function failure(overrides: Partial<AzureDevOpsFailure> = {}): AzureDevOpsFailure {
    return {
      class: 'server',
      status: 503,
      detail: 'Azure DevOps returned HTTP 503.',
      typeKey: null,
      retryNotBeforeMs: null,
      rateLimit: null,
      ...overrides,
    };
  }

  it('carries an absolute retry deadline only when the provider supplied one', () => {
    const throttled = projectAzureSourceFailure(failure({
      class: 'rateLimit',
      status: 429,
      retryNotBeforeMs: 1_760_000_000_000,
    }));
    expect(TriageSourceFailureV1Schema.parse(throttled)).toEqual(throttled);
    expect(throttled.class).toBe('rateLimit');
    expect(throttled.retryNotBeforeMs).toBe(1_760_000_000_000);
    expect(projectAzureSourceFailure(failure({ class: 'rateLimit', status: 429 })).retryNotBeforeMs)
      .toBeUndefined();
  });

  it('never claims absence or permission for Azure\'s ambiguous 404', () => {
    const projected = projectAzureSourceFailure(failure({
      class: 'notFoundOrForbidden',
      status: 404,
    }));
    expect(projected.class).toBe('unknown');
    expect(projected.code).toBe('azure-devops/not-found-or-forbidden');
  });

  it('maps the sign-in interception to authentication rather than a malformed response', () => {
    expect(projectAzureSourceFailure(failure({ class: 'unauthorized', status: 203 })).class)
      .toBe('authentication');
    expect(projectAzureSourceFailure(failure({ class: 'forbidden', status: 403 })).class)
      .toBe('permission');
    expect(projectAzureSourceFailure(failure({ class: 'server' })).class).toBe('transient');
    expect(projectAzureSourceFailure(failure({ class: 'transport' })).class).toBe('transient');
    expect(projectAzureSourceFailure(failure({ class: 'malformedResponse' })).class)
      .toBe('unsupportedContract');
  });

  it('never echoes provider material beyond the bounded non-secret detail', () => {
    const projected = projectAzureSourceFailure(failure({ detail: 'x'.repeat(4_000) }));
    expect(TriageSourceFailureV1Schema.parse(projected)).toEqual(projected);
    expect(new TextEncoder().encode(projected.detail ?? '').length).toBeLessThanOrEqual(1_024);
  });
});

describe('Azure DevOps present-observation projection', () => {
  it('parses through the closed scan observation schema with routing and identity intact', () => {
    const observation = projectAzurePresentObservation({
      entry: entry(),
      involvement: ['reviewRequested'],
    });
    expect(TriageSourceScanObservationV1Schema.parse(observation)).toEqual(observation);
    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.localRef).toEqual({
      kindId: 'pull-request',
      collisionScope: collisionScope(),
      entryId: '17',
    });
    // §2.10: the routing token is the repository key, verbatim, and nothing else.
    expect(observation.locator.routingToken).toBe('acme/Payments/checkout');
    expect(observation.locator.webUrl)
      .toBe('https://dev.azure.com/acme/Payments/_git/checkout/pullrequest/17');
    expect(observation.snapshot.scopeLabel).toBe('acme/Payments/checkout');
    expect(observation.snapshot.reviewRevision).toEqual({
      baseSha: 'a1b2c3d4e5f6',
      headSha: 'b3f1c0a9d2e4',
      nativeRevision: 'b3f1c0a9d2e4',
    });
    expect(observation.viewer.involvement).toEqual(['reviewRequested']);
    expect(observation.nativeRevision).toBe('b3f1c0a9d2e4');
    expect(JSON.stringify(observation)).not.toContain('sourceAttention');
  });

  it('keeps an unmapped provider status present and unknown instead of asserting active', () => {
    const observation = projectAzurePresentObservation({
      entry: entry({ state: 'notSet', presentation: 'active', nativeLabel: 'Not set' }),
      involvement: [],
    });
    if (observation.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.snapshot.state).toEqual({ presentation: 'unknown', nativeLabel: 'Not set' });
    expect(observation.viewer.involvement).toEqual([]);
  });

  it('maps abandoned and completed to closed while retaining the provider word', () => {
    for (const [state, nativeLabel] of [['completed', 'Completed'], ['abandoned', 'Abandoned']] as const) {
      const observation = projectAzurePresentObservation({
        entry: entry({ state, presentation: 'closed', nativeLabel }),
        involvement: ['author'],
      });
      if (observation.kind !== 'present') throw new Error('expected a present observation');
      expect(observation.snapshot.state).toEqual({ presentation: 'closed', nativeLabel });
    }
  });

  it('projects a titleless oversize entry as a bounded, uniquely keyed, truncated row', () => {
    const facts = [
      { kind: 'mergeStatus', value: 'conflicts', nativeLabel: 'Conflicts' },
      { kind: 'draft' },
      { kind: 'autoCompleteEnabled', enabledById: 'a0d31c2e-4f50-4a6b-8c7d-9e0f1a2b3c4d' },
      ...Array.from({ length: 12 }, () => ({ kind: 'label', value: 'release' })),
    ] as AzurePullRequestEntry['facts'];
    const observation = projectAzurePresentObservation({
      entry: entry({ title: '', facts, projectionTruncated: true }),
      involvement: ['author'],
    });
    expect(TriageSourceScanObservationV1Schema.parse(observation)).toEqual(observation);
    if (observation.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.snapshot.title.length).toBeGreaterThan(0);
    expect(observation.snapshot.projectionTruncated).toBe(true);
    expect(observation.snapshot.facts.length).toBeLessThanOrEqual(MAX_TRIAGE_ROW_FACTS_V1);
    const ids = observation.snapshot.facts.map((fact) => fact.id);
    expect(new Set(ids).size).toBe(ids.length);
    // §6.3.1 rule 3: stored auto-complete is disclosed at read time.
    expect(ids).toContain('azure-devops/auto-complete');
  });

  it('normalizes provider control characters so one row cannot reject the whole page', () => {
    // `CONTRACT.md` §2.1: every V1 string is single-line, and the target rejects a
    // control-bearing result **atomically**. One Azure title carrying a newline would therefore
    // discard every other row in the same scan page, so the source normalizes before projecting.
    const observation = projectAzurePresentObservation({
      entry: entry({
        title: 'Fix the parser\r\n\tand the printer',
        headCommitId: 'b3f1c0a9d2e4',
        facts: [{ kind: 'label', value: 'needs\0rebase' }],
      }),
      involvement: ['author'],
    });

    expect(TriageSourceScanObservationV1Schema.parse(observation)).toEqual(observation);
    if (observation.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.snapshot.title).toMatch(SINGLE_LINE);
    expect(observation.snapshot.title).toContain('Fix the parser');
    expect(observation.snapshot.title).toContain('and the printer');
    expect(observation.nativeRevision).toBe('b3f1c0a9d2e4');
    const label = observation.snapshot.facts.find((fact) => fact.id.startsWith('azure-devops/tag/'));
    expect(label?.value).toEqual({ kind: 'text', value: 'needs rebase' });
  });

  it('omits an over-bound web URL instead of truncating it to a wrong destination', () => {
    // §2.1: a location is machine-meaningful, so a source that cannot fit one omits it. The row
    // itself still has to survive — an oversize repository path is not a reason to lose the entry.
    const longName = 'r'.repeat(512);
    const base = entry().locator;
    const observation = projectAzurePresentObservation({
      entry: entry({
        locator: {
          ...base,
          repositoryName: longName,
          repositoryKey: `acme/Payments/${longName}`,
          webUrl: `https://dev.azure.com/acme/Payments/_git/${longName}`,
        },
      }),
      involvement: ['author'],
    });

    expect(TriageSourceScanObservationV1Schema.parse(observation)).toEqual(observation);
    if (observation.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.locator.webUrl).toBeUndefined();
    // A routing token is parsed by this source alone, so a truncated one is a wrong route
    // rather than a shortened label: it is omitted, while the display strings are shortened.
    expect(observation.locator.routingToken).toBeUndefined();
    expect(observation.snapshot.projectionTruncated).toBe(true);
    expect(observation.snapshot.scopeLabel.length).toBeGreaterThan(0);
    expect(observation.localRef.entryId).toBe('17');
  });

  it('omits a web URL rather than synthesizing one from a missing repository URL', () => {
    const observation = projectAzurePresentObservation({
      entry: entry({ locator: { ...entry().locator, webUrl: null } }),
      involvement: ['author'],
    });
    if (observation.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.locator.webUrl).toBeUndefined();
    expect(observation.locator.routingToken).toBe('acme/Payments/checkout');
  });
});
