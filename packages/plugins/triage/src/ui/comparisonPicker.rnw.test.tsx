// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginClientTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginClientTestkit, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
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
import { createTestkitSourceSessionRelations, readTestkitSourceSessionLinks } from '../sessions/testkit/entrySessionTestkit.test-support.js';
import { TriageReadEntryDetailInputV1Schema, TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../actions/entryDetailProtocol.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import type { EphemeralInputSettlement } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiContextEnrichmentV1 } from '@happier-dev/plugin-sdk/ui';
import { PLUGIN_MANIFEST } from '../manifest.js';
import * as mountedUiArtifact from '../actions/mountedUi.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema, TriageMountedUiResultV1Schema } from '../actions/mountedUiProtocol.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const clients: PluginClientTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await act(() => fixture.dispose());
  for (const client of clients.splice(0)) await client.dispose();
});

async function mountPicker(options: Readonly<{ getAvailable?: boolean; wrongIdentity?: boolean; skipSelect?: boolean; paged?: boolean; onGet?: () => void; closeOnSettle?: boolean }> = {}) {
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
  const reads = { scans: 0, details: 0 };
  const sharedScope = createTriageEphemeralSharedScopeFixture();
  let published: PluginUiContextEnrichmentV1 | null = null;
  let closeAuthor = () => {};
  function AuthorLifetime({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = React.useState(true);
    React.useLayoutEffect(() => { closeAuthor = () => setOpen(false); }, []);
    return open ? children : null;
  }
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'comparison-picker', mountNonce: 'comparison-picker-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: context => {
        const rendered = renderSurface(context) as React.ReactElement<{ children: React.ReactNode }>;
        return React.cloneElement(rendered, {}, <AuthorLifetime>{rendered.props.children}</AuthorLifetime>);
      },
      surfaceContext: createSurfaceContextFixture({ targetedContributions: {
        target: { pluginId: 'happier.triage', occurrenceId: 'triage-current', sourceCustody: { kind: 'development', registeredRootId: 'triage' } },
        points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol,
          contributions: [{ contributor, protocol, descriptor: native.descriptor,
            operations: options.getAvailable === false ? [] : [operation], surfaces: [] }] }] }],
      } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: sharedScope }),
      launchInput: { inputType: { pluginId: 'happier.triage', localId: 'pull-request-comparison' }, semantic: 'scmPullRequestComparison' },
      handlers: {
        publishCurrentUiContext: ({ enrichment }) => { published = enrichment; },
        executeAction: async ({ action: requested, input }) => {
          if (requested === 'sessions/read-source-links-v1') return await readTestkitSourceSessionLinks(input, { collections, contributions: admitted });
          if (requested === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) return await listTriageEntries(TriageListEntriesInputV1Schema.parse(input), {
            sourceInstances: collections.sourceInstances, readAdmittedSources: async () => admitted,
            executeScan: async (_operation, input) => {
              reads.scans += 1;
              if (!options.paged) return native.scanResult;
              if (native.scanResult.kind === 'failed') throw new Error('Expected scan observations');
              const observation = native.scanResult.observations.find(item => item.kind === 'present');
              if (!observation) throw new Error('Expected present observation');
              return input.page.kind === 'initial'
                ? { kind: 'page', observations: Array.from({ length: input.page.limit }, (_, index) => ({
                    ...observation, localRef: { ...observation.localRef, entryId: `first-${index}` },
                  })), evidence: { kind: 'partial', reason: 'more-pages' }, continuation: { v: 1, token: 'next-page' } }
                : { kind: 'complete', observations: [{ ...observation,
                    localRef: { ...observation.localRef, entryId: 'later' },
                    snapshot: { ...observation.snapshot, title: 'Later pull request' },
                  }], evidence: { kind: 'walkFinished' } };
            }, nowMs: () => Date.now(),
          });
          if (requested === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) { reads.details += 1; return await readTriageEntryDetail(TriageReadEntryDetailInputV1Schema.parse(input), {
            sourceRelations: createTestkitSourceSessionRelations({ collections, contributions: admitted }), readSessionSummary: async () => null,
          }); }
          expect(requested).toEqual(action);
          getInputs.push(TriageGetInputV1Schema.parse(input));
          options.onGet?.();
          const result = native.getResult;
          if (result.kind !== 'present') throw new Error('Expected present source fixture');
          return TriageGetResultV1Schema.parse({ ...result, comparisonSource: comparison,
            localRef: options.wrongIdentity ? { ...result.localRef, entryId: 'someone-else' } : result.localRef });
        },
        settleEphemeralInput: async ({ settlement, signal }) => {
          settlements.push(settlement);
          // Closing the modal unmounts its author subtree while the host acknowledges the finite write.
          if (options.closeOnSettle) {
            flushSync(() => closeAuthor());
            // The native host rejects a withdrawn request before returning its acknowledgement.
            signal.throwIfAborted();
          }
        },
      },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
  if (!options.skipSelect) await act(async () => { await fixture.press(await fixture.getByRole('button', { name: native.detailInput.observation.snapshot.title })); });
  const readMountId = () => {
    const detail = published?.detail;
    const address = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail.mountedAction : undefined;
    return address && typeof address === 'object' && !Array.isArray(address) ? address.mountId : undefined;
  };
  const invokeInput = async (input: unknown, signal = new AbortController().signal) => {
    const declaration = PLUGIN_MANIFEST.contributes.actions.find(item => item.id === TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1);
    if (declaration?.execution.target !== 'client') throw new Error('Missing mounted Action');
    const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
      target: { ...declaration.execution.client, platform: 'web' }, activate: mountedUiArtifact.activate });
    clients.push(client);
    const handler = client.registration('actions', declaration.id);
    if (!handler) throw new Error('Missing mounted Action registration');
    let result;
    await act(async () => { result = await handler(TriageMountedUiInputV1Schema.parse(input), {
      plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
      invocationSurface: 'agent', signal,
      ui: fixture.context.hostApi, ephemeralSharedScope: sharedScope,
    }); });
    return TriageMountedUiResultV1Schema.parse(result);
  };
  const invoke = (operation: unknown, signal?: AbortSignal) => invokeInput({ mountId: readMountId(), operation }, signal);
  const invokeCommand = (title: string, operation?: unknown) => {
    const command = published?.commands?.find(item => item.title === title)?.command;
    expect(command?.kind).toBe('executeAction');
    if (command?.kind !== 'executeAction') throw new Error('Missing advertised Action');
    expect(command.action).toBe(TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1);
    return invokeInput(command.input ?? { mountId: readMountId(), operation });
  };
  return { fixture, settlements, getInputs, native, comparison, invoke, invokeCommand, reads,
    readCommands: () => published?.commands ?? [] };
}

describe('mounted Triage comparison picker', () => {
  it('acknowledges an agent choice after the host closes its picker', async () => {
    const { settlements, comparison, native, invoke } = await mountPicker({ skipSelect: true, closeOnSettle: true });
    expect(await invoke({ kind: 'attachEntry', entryRef: native.detailInput.observation.entryRef }))
      .toEqual({ status: 'applied' });
    expect(settlements).toEqual([{ kind: 'completed', input: comparison }]);
  });
  it('keeps the opener unchanged on cancellation and permits a later choice', async () => {
    const controller = new AbortController();
    let firstRead = true;
    const { fixture, native, settlements, comparison, invoke } = await mountPicker({ skipSelect: true, onGet: () => {
      if (firstRead) { firstRead = false; controller.abort(); }
    } });
    const operation = { kind: 'attachEntry', entryRef: native.detailInput.observation.entryRef };
    expect(await invoke(operation, controller.signal)).toEqual({ status: 'unavailable' });
    expect(settlements).toEqual([]);
    expect((await fixture.getByRole('button', { name: 'Choose comparison' })).state?.disabled ?? false).toBe(false);
    expect(await invoke(operation)).toEqual({ status: 'applied' });
    expect(settlements).toEqual([{ kind: 'completed', input: comparison }]);
  });
  it.each(['person', 'agent'] as const)('appends the shared corpus continuation through the %s path', async path => {
    const { fixture, invoke, invokeCommand, readCommands } = await mountPicker({ paged: true, skipSelect: true });
    if (path === 'person') {
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Load more' })); });
    } else {
      expect(await invokeCommand('Load more')).toEqual({ status: 'applied' });
    }
    expect(await invoke({ kind: 'setPickerQuery', query: 'Later pull request' })).toEqual({ status: 'applied' });
    expect(await fixture.getByRole('button', { name: 'Later pull request' })).toBeDefined();
    expect(readCommands().some(command => command.title === 'Load more')).toBe(false);
    expect(await invoke({ kind: 'loadMore', section: 'entries' })).toEqual({ status: 'unavailable' });
  });
  it('advertises executable search and refresh controls alongside its current rows', async () => {
    const { fixture, invokeCommand, reads, readCommands, native } = await mountPicker({ skipSelect: true });
    expect(readCommands().map(command => command.title)).toEqual(expect.arrayContaining(['Search pull requests', 'Refresh']));
    const before = { ...reads };
    expect(await invokeCommand('Search pull requests', { kind: 'setPickerQuery', query: 'no matching pull request' }))
      .toEqual({ status: 'applied' });
    expect(reads).toEqual(before);
    expect(await fixture.queryByRole('button', { name: native.detailInput.observation.snapshot.title })).toBeUndefined();
    expect(await invokeCommand('Search pull requests', { kind: 'setPickerQuery', query: '' })).toEqual({ status: 'applied' });
    expect(await invokeCommand('Refresh')).toEqual({ status: 'applied' });
    expect(reads.scans).toBeGreaterThan(before.scans);
  });
  it('chooses through the registered mounted Action and keeps search local to the shared corpus', async () => {
    const { settlements, native, comparison, invoke, reads } = await mountPicker({ skipSelect: true });
    const entryRef = native.detailInput.observation.entryRef;
    const before = { ...reads };
    expect(await invoke({ kind: 'setPickerQuery', query: 'no matching pull request' })).toEqual({ status: 'applied' });
    expect(await invoke({ kind: 'attachEntry', entryRef })).toEqual({ status: 'unavailable' });
    expect(reads).toEqual(before);
    expect(settlements).toEqual([]);
    expect(await invoke({ kind: 'setPickerQuery', query: '' })).toEqual({ status: 'applied' });
    expect(await invoke({ kind: 'attachEntry', entryRef })).toEqual({ status: 'applied' });
    expect(settlements).toEqual([{ kind: 'completed', input: comparison }]);
  });
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
