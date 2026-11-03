// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageGetInputV1Schema, TriageGetResultV1Schema, TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/triage-protocol/v1';
import { renderSurface } from './comparisonPicker.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { listTriageEntries, type TriageAdmittedSourceV1 } from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema, TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 } from '../actions/listEntriesProtocol.js';
import { readTriageEntryDetail } from '../actions/readEntryDetail.js';
import { createTestkitSourceSessionRelations } from '../sessions/testkit/entrySessionTestkit.test-support.js';
import { TriageReadEntryDetailInputV1Schema, TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../actions/entryDetailProtocol.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import type { EphemeralInputSettlement } from '@happier-dev/plugin-sdk/ui';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await act(() => fixture.dispose()); });

async function mountPicker(options: Readonly<{ getAvailable?: boolean; wrongIdentity?: boolean }> = {}) {
  const native = createTriageSourceV1Fixture();
  const source = native.configuredInstance.instance.source;
  const { collections, control } = createTestkitCorpusCollections();
  control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: `a${'0'.repeat(42)}`,
    sourceQualifiedId: `${source.pluginId}/${source.localId}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
    configuredAtMs: 1, configured: native.configuredInstance }));
  const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
  const contributor = { pluginId: source.pluginId, contributionId: source.localId, occurrenceId: 'source-current',
    sourceCustody: { kind: 'development' as const, registeredRootId: 'example-source' } };
  const action = { pluginId: source.pluginId, localId: 'get-entry' };
  const operation = { point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol }, contributor, role: 'get', action };
  // The host admission snapshot is the system boundary; internal list/detail/schema logic remains real.
  const admitted = [{ contributor: { pluginId: source.pluginId, contributionId: source.localId,
    immutableGenerationId: 'source-current' }, protocol, descriptor: native.descriptor,
    operations: { listInstances: {}, scan: {}, get: {} }, surfaces: {} }] as unknown as readonly TriageAdmittedSourceV1[];
  const comparison = { kind: 'pullRequest' as const, locator: { providerId: 'example-forge', repository: 'example/repository', number: 17,
    sourceAction: { action: { pluginId: source.pluginId, localId: 'read-comparison' }, input: { routingToken: 'opaque' } } } };
  const settlements: EphemeralInputSettlement[] = [];
  const getInputs: unknown[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'comparison-picker', mountNonce: 'comparison-picker-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({ targetedContributions: {
        target: { pluginId: 'happier.triage', occurrenceId: 'triage-current', sourceCustody: { kind: 'development', registeredRootId: 'triage' } },
        points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol,
          contributions: [{ contributor, protocol, descriptor: native.descriptor,
            operations: options.getAvailable === false ? [] : [operation], surfaces: [] }] }] }],
      } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
      launchInput: { inputType: { pluginId: 'happier.triage', localId: 'pull-request-comparison' }, semantic: 'scmPullRequestComparison' },
      handlers: {
        executeAction: async ({ action: requested, input }) => {
          if (requested === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) return await listTriageEntries(TriageListEntriesInputV1Schema.parse(input), {
            sourceInstances: collections.sourceInstances, readAdmittedSources: async () => admitted,
            executeScan: async () => native.scanResult, nowMs: () => Date.now(),
          });
          if (requested === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) return await readTriageEntryDetail(TriageReadEntryDetailInputV1Schema.parse(input), {
            sourceRelations: createTestkitSourceSessionRelations({ collections, contributions: admitted }), readSessionSummary: async () => null,
          });
          expect(requested).toEqual(action);
          getInputs.push(TriageGetInputV1Schema.parse(input));
          const result = native.getResult;
          if (result.kind !== 'present') throw new Error('Expected present source fixture');
          return TriageGetResultV1Schema.parse({ ...result, comparisonSource: comparison,
            localRef: options.wrongIdentity ? { ...result.localRef, entryId: 'someone-else' } : result.localRef });
        },
        settleEphemeralInput: ({ settlement }) => { settlements.push(settlement); },
      },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: native.detailInput.observation.snapshot.title })); });
  return { fixture, settlements, getInputs, native, comparison };
}

describe('mounted Triage comparison picker', () => {
  it('settles exact PR source evidence into its opener without Session navigation', async () => {
    const { fixture, settlements, getInputs, native, comparison } = await mountPicker();
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Choose comparison' })); });
    expect(getInputs).toEqual([native.getInput]);
    expect(settlements).toEqual([{ kind: 'completed', input: comparison }]);
  });
  it('keeps the opener unchanged when a source returns another entry', async () => {
    const { fixture, settlements } = await mountPicker({ wrongIdentity: true });
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Choose comparison' })); });
    expect(settlements).toEqual([]);
    expect(await fixture.getByText('This source cannot open a comparison for this pull request.')).toBeDefined();
  });
  it('offers no executable choice when the source get operation is unavailable', async () => {
    const { fixture, settlements, getInputs } = await mountPicker({ getAvailable: false });
    const choice = await fixture.findByRole('button', { name: 'Choose comparison' });
    expect(choice.state?.disabled).toBe(true);
    expect(settlements).toEqual([]);
    expect(getInputs).toEqual([]);
  });
});
