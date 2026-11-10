import { afterAll, describe, expect, it } from 'vitest';
import {
  AgentDispatchStructuredInputV1Schema,
  ComposerAttachmentInputV1Schema,
  HappierStructuredInputV1Schema,
  ResolvedComposerAttachmentDispatchV1Schema,
  type ComposerAttachmentInputV1,
} from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectSessionInputReferencesV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriageConfiguredSourceInstanceV1Schema,
  TriageGetInputV1Schema,
  TriageGetResultV1Schema,
  TriageSourceDescriptorV1Schema,
  TriageSourceEntrySnapshotV1Schema,
  type TriageEntryRefV1,
  type TriageGetInputV1,
  type TriageSourceEntrySnapshotV1,
} from '@happier-dev/triage-protocol/v1';

import { createTriageEntryAttachmentRuntime } from '../../../../../../packages/plugins/triage/src/composer/attachmentRuntime';
import {
  deriveTriageComposerEntryAttachmentKey,
  TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1,
} from '../../../../../../packages/plugins/triage/src/composer/attachmentValue';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../../../../../packages/plugins/triage/src/corpus/collections/ids';
import { toCorpusStoredValue } from '../../../../../../packages/plugins/triage/src/corpus/collections/rowCodec';
import type { CorpusSourceInstanceRowV1 } from '../../../../../../packages/plugins/triage/src/corpus/collections/rows';
import { createTestkitCorpusCollections } from '../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support';
import { GITHUB_SEARCH_ISSUE_ITEM, GITHUB_SEARCH_PULL_REQUEST_ITEM } from '../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { GITHUB_PLUGIN_ID } from '../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import sentryIssueDetail from '../../../../../../packages/plugins/sentry/src/fixtures/issueDetail.json' with { type: 'json' };
import { deriveSentryCollisionScope } from '../../../../../../packages/plugins/sentry/src/instances/sentryCollisionScope';
import { SENTRY_CONTRIBUTION_ID, SENTRY_PLUGIN_ID } from '../../../../../../packages/plugins/sentry/src/sentryContracts';
import posthogIssueDetail from '../../../../../../packages/plugins/posthog/src/api/__fixtures__/queryIssueDetail.json' with { type: 'json' };
import { POSTHOG_PLUGIN_ID, POSTHOG_SOURCE_CONTRIBUTION_ID } from '../../../../../../packages/plugins/posthog/src/posthogContracts';
import { normalizePosthogApiOrigin } from '../../../../../../packages/plugins/posthog/src/connect/origin';
import { buildPosthogCollisionScope } from '../../../../../../packages/plugins/posthog/src/source/identity';
import { prepareSessionInputForProviderDispatch, type SessionInputDispatchServices } from './prepareSessionInputForProviderDispatch';

// Constructed targeted-Action results, not tenant captures or native-decoder proof.
// Titles/counts come from the incumbent synthetic provider fixtures below. Tier-A
// facts follow source/observation.ts (Sentry), source/map/observation.ts (PostHog),
// and triage/mapping/protocol.ts (GitHub). Additional identities are synthetic
// siblings with the same realistic projection, not duplicate attachment keys.
const fixtureBasis = {
  github: 'packages/plugins/scm-github/src/triage/__fixtures__/githubResponses.ts (synthetic REST/OpenAPI 2026-03-10)',
  sentry: 'packages/plugins/sentry/src/fixtures/issueDetail.json (schema-derived synthetic issue)',
  posthog: 'packages/plugins/posthog/src/api/__fixtures__/queryIssueDetail.json (schema-derived OpenAPI 2026-08-14)',
};

type Specimen = Readonly<{
  name: string;
  source: TriageEntryRefV1['source'];
  kindId: string;
  workflowSubject: 'pullRequest' | 'issue' | 'errorIssue';
  collisionScope: string;
  entryId: (index: number) => string;
  snapshot: TriageSourceEntrySnapshotV1;
}>;

function posthogScope(): string {
  const origin = normalizePosthogApiOrigin('https://eu.posthog.com');
  if (!origin.ok) throw new Error('Invalid fixture origin');
  const scope = buildPosthogCollisionScope(origin.origin, '11111111-1111-4111-8111-111111111111');
  if (!scope.ok) throw new Error('Invalid fixture environment');
  return scope.value;
}

const githubSource = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
const specimens: readonly Specimen[] = [
  {
    name: 'github-pr', source: githubSource, kindId: 'pull-request', workflowSubject: 'pullRequest',
    collisionScope: 'github:4210', entryId: index => String(1284 + index),
    snapshot: TriageSourceEntrySnapshotV1Schema.parse({
      v: 1, title: GITHUB_SEARCH_PULL_REQUEST_ITEM.title, scopeLabel: 'octo-org/example-app',
      state: { presentation: 'active', nativeLabel: 'Open' }, facts: [
        { id: 'github/checks', importance: 'primary', value: { kind: 'status', value: '2 failing', tone: 'danger' } },
        { id: 'github/review-decision', importance: 'primary', value: { kind: 'status', value: 'Changes requested', tone: 'warning' } },
        { id: 'github/changed-files', importance: 'secondary', value: { kind: 'number', value: 7, format: 'plain' } },
      ],
    }),
  },
  {
    name: 'github-issue', source: githubSource, kindId: 'issue', workflowSubject: 'issue',
    collisionScope: 'github:8815', entryId: index => String(7 + index),
    snapshot: TriageSourceEntrySnapshotV1Schema.parse({
      v: 1, title: GITHUB_SEARCH_ISSUE_ITEM.title, scopeLabel: 'octo-org/example-tools',
      state: { presentation: 'active', nativeLabel: 'Open' }, facts: [],
    }),
  },
  {
    name: 'sentry-issue', source: { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONTRIBUTION_ID },
    kindId: 'error-issue', workflowSubject: 'errorIssue',
    collisionScope: deriveSentryCollisionScope({ deploymentOrigin: 'https://us.sentry.io', organizationId: '7701' }),
    entryId: index => String(Number(sentryIssueDetail.body.id) + index),
    snapshot: TriageSourceEntrySnapshotV1Schema.parse({
      v: 1, title: sentryIssueDetail.body.title, scopeLabel: sentryIssueDetail.body.project.slug,
      state: { presentation: 'active', nativeLabel: sentryIssueDetail.body.status }, facts: [
        { id: 'sentry/count', importance: 'primary', value: { kind: 'number', value: Number(sentryIssueDetail.body.count), format: 'compact' } },
        { id: 'sentry/users', importance: 'secondary', value: { kind: 'number', value: sentryIssueDetail.body.userCount, format: 'compact' } },
        { id: 'sentry/last-seen', importance: 'primary', value: { kind: 'timestamp', atMs: Date.parse(sentryIssueDetail.body.lastSeen), format: 'relative' } },
      ],
    }),
  },
  {
    name: 'posthog-issue', source: { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_SOURCE_CONTRIBUTION_ID },
    kindId: 'error-issue', workflowSubject: 'errorIssue', collisionScope: posthogScope(),
    entryId: index => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    snapshot: TriageSourceEntrySnapshotV1Schema.parse({
      v: 1, title: posthogIssueDetail.description, scopeLabel: 'Production storefront',
      state: { presentation: 'active', nativeLabel: posthogIssueDetail.status }, facts: [
        { id: 'posthog/occurrences', label: 'Occurrences in window', importance: 'primary', value: { kind: 'number', value: posthogIssueDetail.aggregations.occurrences, format: 'compact' } },
        { id: 'posthog/users', label: 'Users', importance: 'secondary', value: { kind: 'number', value: posthogIssueDetail.aggregations.users, format: 'compact', approximate: true } },
        { id: 'posthog/function', label: 'Function', importance: 'primary', value: { kind: 'text', value: posthogIssueDetail.function } },
        { id: 'posthog/last-seen', label: 'Last seen', importance: 'primary', value: { kind: 'timestamp', atMs: Date.parse(posthogIssueDetail.last_seen), format: 'relative' } },
      ],
    }),
  },
];

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(createCanonicalJsonSigningInput(value)).byteLength;
const chars = (value: string) => Array.from(value).length;
const measurements: unknown[] = [];

function createDispatchFixture(selected: readonly Specimen[]) {
  const corpus = createTestkitCorpusCollections();
  const sources = [...new Map(selected.map(specimen => [`${specimen.source.pluginId}/${specimen.source.localId}`, specimen.source])).values()];
  const sourceInstances = sources.map((source, index) => {
    const sourceInstanceId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const configured = TriageConfiguredSourceInstanceV1Schema.parse({
      v: 1, instance: { source, sourceInstanceId },
      binding: { purpose: 'triage-source', account: { service: { pluginId: source.pluginId, localId: 'fixture-account' }, accountId: 'synthetic-account' } },
      localInstanceKey: 'synthetic-context-characterization', configuration: { v: 1, token: 'synthetic-context-route' }, locator: { v: 1, displayLabel: 'Context characterization' },
    });
    const row: CorpusSourceInstanceRowV1 = {
      instanceTag: String.fromCharCode(97 + index).repeat(43), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
      lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured,
    };
    corpus.control.sourceInstances.seed(toCorpusStoredValue(row));
    return configured.instance;
  });
  const attachments = selected.map((specimen, index) => {
    const entryRef: TriageEntryRefV1 = { source: specimen.source, kindId: specimen.kindId, collisionScope: specimen.collisionScope, entryId: specimen.entryId(index) };
    const sourceInstance = sourceInstances.find(instance => instance.source.pluginId === specimen.source.pluginId && instance.source.localId === specimen.source.localId);
    if (!sourceInstance) throw new Error('Missing configured fixture source');
    return ComposerAttachmentInputV1Schema.parse({
      v: 1, instanceId: `selected-entry-${index + 1}`, attachment: TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1,
      key: deriveTriageComposerEntryAttachmentKey(entryRef), value: { v: 1, entryRef, sourceInstance },
      presentation: { label: specimen.snapshot.title, typeLabel: 'Triage entry' },
    });
  });
  const getCalls: TriageGetInputV1[] = [];
  const handles = sources.map(source => ({ source }));
  // Account Collection I/O, admitted contribution discovery and targeted Action
  // execution are genuine host boundaries; all internal Triage logic stays real.
  const context = { services: {
    storage: { account: { collection: (definition: { id: string }) => definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
      ? corpus.collections.sourceInstances : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID
        ? corpus.collections.sessionLinks : corpus.collections.userMarks } },
    targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: sources.map((source, index) => ({
      contributor: { pluginId: source.pluginId, contributionId: source.localId },
      descriptor: TriageSourceDescriptorV1Schema.parse({
        v: 1, purpose: 'triage-source', displayName: source.localId,
        kinds: [...new Map(selected.filter(item => item.source.pluginId === source.pluginId && item.source.localId === source.localId)
          .map(item => [item.kindId, { id: item.kindId, workflowSubject: item.workflowSubject, displayName: item.kindId }])).values()],
      }), operations: { get: handles[index] },
    })) }), dispose: () => {} }) },
    actions: { executeAdmittedTargetedOperation: async (handle: unknown, rawInput: unknown) => {
      const input = TriageGetInputV1Schema.parse(rawInput);
      const index = attachments.findIndex(attachment => {
        const value = attachment.value;
        return value && typeof value === 'object' && !Array.isArray(value)
          && 'entryRef' in value && JSON.stringify(value.entryRef) === JSON.stringify({ source: input.instance.instance.source, ...input.localRef });
      });
      if (index < 0) throw new Error('Unexpected exact entry get');
      const specimen = selected[index]!;
      expect(handle).toBe(handles[sources.findIndex(source => source.pluginId === specimen.source.pluginId && source.localId === specimen.source.localId)]);
      getCalls.push(input);
      return TriageGetResultV1Schema.parse({ kind: 'present', localRef: input.localRef,
        locator: { v: 1, displayPath: `${specimen.snapshot.scopeLabel} #${input.localRef.entryId}` },
        snapshot: specimen.snapshot, viewer: { involvement: [] } });
    } },
  } } as unknown as PluginInvocationContext;
  return { attachments, context, getCalls };
}

describe('Triage attachment context through real provider preparation (QB43 characterization)', () => {
  afterAll(() => {
    // Synthetic fixture content only. The caller retains this one machine-readable
    // record as measurements.json; ordinary test runs need no writable artifact path.
    console.info(`TRIAGE_CONTEXT_CHARACTERIZATION ${JSON.stringify({ fixtureBasis, measurements })}`);
  });

  const selections = [...specimens.map(specimen => ({ name: specimen.name, mix: [specimen] })), { name: 'mixed-four-sources', mix: specimens }];
  for (const selection of selections) for (const count of [1, 3, 8]) {
    it(`${selection.name}: prepares all ${count} admitted entries without a fixed context cap`, async () => {
      const selected = Array.from({ length: count }, (_, index) => selection.mix[index % selection.mix.length]!);
      const fixture = createDispatchFixture(selected);
      const structuredInput = HappierStructuredInputV1Schema.parse({ v: 1, composerAttachments: fixture.attachments });
      expect(structuredInput.composerAttachments).toHaveLength(count);
      const runtime = createTriageEntryAttachmentRuntime();
      const resolved: { attachment: ComposerAttachmentInputV1; context?: string }[] = [];
      const services: SessionInputDispatchServices = {
        sessionId: 'context-characterization-session',
        resolveComposerAttachmentForDispatch: async ({ request }) => {
          const result = await runtime.resolveForDispatch!(request, fixture.context);
          expect(result.attachments.map(item => item.instanceId)).toEqual(fixture.attachments.map(item => item.instanceId));
          for (const outcome of result.attachments) {
            expect(outcome.status).toBe('ready');
            if (outcome.status !== 'ready') throw new Error('Fixture did not resolve');
            const attachment = fixture.attachments.find(item => item.instanceId === outcome.instanceId)!;
            resolved.push({ attachment: ResolvedComposerAttachmentDispatchV1Schema.parse({ ...attachment,
              ...(outcome.data === undefined ? {} : { data: outcome.data }),
              ...(outcome.forgeEvidence === undefined ? {} : { forgeEvidence: outcome.forgeEvidence }) }),
              ...(outcome.context === undefined ? {} : { context: outcome.context }) });
          }
          return result;
        },
      };
      const attempt = await prepareSessionInputForProviderDispatch({
        prompt: { text: 'Investigate these selected entries.', localId: 'characterization-input', structuredInput },
        transformedUserText: 'Investigate these selected entries.', providerNativeCommand: false,
        signal: new AbortController().signal, localId: 'characterization-input', services,
      }).then(prepared => ({ kind: 'prepared' as const, prepared }), (error: unknown) => ({ kind: 'refused' as const, error }));

      // A first-only resolver or silently omitted peer must fail even if the
      // surviving fragment looks like a valid individual reference.
      expect(fixture.getCalls.map(input => ({ source: input.instance.instance.source, ...input.localRef })))
        .toEqual(fixture.attachments.map(item => (item.value as { entryRef: unknown }).entryRef));
      expect(resolved.map(item => item.attachment.instanceId)).toEqual(fixture.attachments.map(item => item.instanceId));
      const projection = projectSessionInputReferencesV1({ text: '', references: { composerAttachments: resolved } });
      const measurement = {
        selection: selection.name, count, admittedStructuredInputBytes: jsonBytes(structuredInput),
        admittedAttachmentRecordsBytes: jsonBytes(fixture.attachments),
        entries: resolved.map((entry, index) => ({
          specimen: selected[index]!.name, instanceId: entry.attachment.instanceId,
          key: entry.attachment.key, valueJsonBytes: jsonBytes(entry.attachment.value),
          dataJsonBytes: 'data' in entry.attachment ? jsonBytes(entry.attachment.data) : null,
          context: entry.context, contextBytes: encoder.encode(entry.context ?? '').byteLength, contextChars: chars(entry.context ?? ''),
        })),
        framedReferenceChars: chars(projection.block),
        framedReferenceBytes: encoder.encode(projection.block).byteLength,
      };
      expect(attempt.kind).toBe('prepared');
      if (attempt.kind !== 'prepared') throw attempt.error;
      const dispatch = AgentDispatchStructuredInputV1Schema.parse(attempt.prepared.structuredInput);
      expect(dispatch.resolvedComposerAttachments).toEqual(resolved.map(item => item.attachment));
      expect(dispatch).not.toHaveProperty('composerAttachments');
      expect(attempt.prepared.requiredPrompt).toContain(projection.block);
      const positions = resolved.map(entry => attempt.prepared.requiredPrompt.indexOf(`attachment_instance_id=${JSON.stringify(entry.attachment.instanceId)}`));
      expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!))).toBe(true);
      measurements.push({ ...measurement, outcome: 'prepared', requiredPromptBytes: encoder.encode(attempt.prepared.requiredPrompt).byteLength,
        requiredPromptChars: chars(attempt.prepared.requiredPrompt) });
    });
  }
});
