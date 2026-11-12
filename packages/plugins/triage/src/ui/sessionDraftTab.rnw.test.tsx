// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it } from 'vitest';
// Reuse the UI testkit's async boundary without importing host runtime into this plugin test.
import { createDeferred } from '../../../../../apps/ui/sources/dev/testkit/hooks/createDeferred.js';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type {
  PluginUiAccountCollectionForDefinition,
  PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import type { PluginUiEphemeralInputSettlementV1 } from '@happier-dev/protocol/plugins/ui';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createTriageEphemeralSharedScopeOriginFixture } from './window/ephemeralSharedScope.test-support.js';
import { stageTriageTaskDraft } from './taskDraftHandoff.js';
import { renderSurface as renderListSurface } from './surface.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { listTriageEntries } from '../actions/listEntries.js';
import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListEntriesInputV1Schema,
} from '../actions/listEntriesProtocol.js';
import { listTriagePinnedEntries } from '../actions/userMarks.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListPinnedEntriesInputV1Schema,
} from '../actions/userMarksProtocol.js';
import { readTriageSavedViewsForSurface } from '../actions/savedViews.js';
import {
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
  TriageReadSavedViewsInputV1Schema,
} from '../actions/savedViewsProtocol.js';
import { readTriageActionsForSurface } from '../actions/actionsCatalog.js';
import {
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageReadActionsInputV1Schema,
} from '../actions/actionsCatalogProtocol.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from '../settings/savedViews.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The New task draft's first line (lab `tasks-create`). */
const DRAFT_PURPOSE =
  'Where does it belong? It’s created there and stays there.';

/** One configured source whose Issue kind can be created (the place a draft is created in). */
function createCapableSource(source: ReturnType<typeof createTriageSourceV1Fixture>): PluginUiTargetedContributionsV1 {
  const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
  const sourceRef = source.configuredInstance.instance.source;
  const contributor = { pluginId: sourceRef.pluginId, contributionId: sourceRef.localId, occurrenceId: 'source-one',
    sourceCustody: { kind: 'development' as const, registeredRootId: 'task-source' } };
  return {
    target: { pluginId: 'happier.triage', occurrenceId: 'triage-one', sourceCustody: { kind: 'development', registeredRootId: 'triage-source' } },
    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
      contributor, protocol,
      descriptor: TriageSourceDescriptorV1Schema.parse({ ...source.descriptor,
        kinds: [{ id: 'issue', task: true, workflowSubject: 'issue', displayName: 'Issue', taskCapabilities: { createFields: ['title', 'body'] } }] }),
      operations: ['create', 'get'].map(role => ({ point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
        contributor, role, action: { pluginId: sourceRef.pluginId, localId: role } })), surfaces: [],
    }] }] }],
  };
}

// Live 2026-11-11 20:20Z (Account B) and 20:37Z (Account A): a message's Create task opened the draft in the Session
// details pane, but ending the draft, by Cancel or by a successful Create, left that pane on the Tasks lens, whose
// row and task openings write a page location this tab does not have ("cannot update its shareable location"). A
// details instance opened for a draft is that draft: when it ends either way, the mount is settled so its pane owner
// returns the pane to what it showed before, and nothing that writes a location is drawn in the meantime.
it.each([
  { ending: 'Cancel', press: 'Cancel', creates: 0 },
  { ending: 'a successful Create', press: 'Create task', creates: 1 },
])(
  'settles the Session details mount when its draft ends by $ending, leaving no location writer behind',
  async ({ press, creates }) => {
    const shared = createTriageEphemeralSharedScopeOriginFixture();
    const pageScope = shared.forExecutionOrigin('page');
    const staged = stageTriageTaskDraft(pageScope, {
      title: 'Fix reconnect handling',
    });
    if (staged === null) throw new Error('The draft could not be staged');
    const { collections, control } = createTestkitCorpusCollections();
    const source = createTriageSourceV1Fixture();
    control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: `a${'0'.repeat(42)}`,
      sourceQualifiedId: `${source.configuredInstance.instance.source.pluginId}/${source.configuredInstance.instance.source.localId}`,
      lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured: source.configuredInstance }));
    const accountKv = createTestkitAccountKv();
    const dataClient: PluginUiDataClient = {
      collection<TDefinition extends PluginAccountCollectionDefinition>(
        definition: TDefinition,
      ) {
        const collection =
          definition.id === 'source-instances'
            ? collections.sourceInstances
            : definition.id === 'session-links'
              ? collections.sessionLinks
              : definition.id === 'user-marks'
                ? collections.userMarks
                : null;
        if (collection === null)
          throw new Error(`Undeclared test Collection: ${definition.id}`);
        return collection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
      },
      async watchAccountData() {
        return { dispose() {} };
      },
      accountKv: accountKv.kv,
      openCollectionQuery: async () => {
        throw new Error('This mount opens no UI query');
      },
    };
    const navigation = createDeferred<void>();
    const opened: unknown[] = [];
    const settlements: PluginUiEphemeralInputSettlementV1[] = [];
    const locationWrites: string[] = [];
    let createWrites = 0;
    let listReads = 0;
    let page!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
    await act(async () => {
      page = await createPluginUiTestkit({
        identity: { instanceId: 'session-draft-tab', mountNonce: 'tab' },
        authorPlugin: {
          id: PLUGIN_MANIFEST.id,
          version: PLUGIN_MANIFEST.version,
        },
        surface: (context) =>
          React.cloneElement(
            renderListSurface(context) as unknown as React.ReactElement<{
              dataClient?: PluginUiDataClient;
            }>,
            { dataClient },
          ),
        launchInput: staged.input,
        surfaceContext: createSurfaceContextFixture({ targetedContributions: createCapableSource(source) }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({
          ephemeralSharedScope: pageScope,
          overlays: true,
        }),
        handlers: {
          openSurface: async request => { opened.push(request); await navigation.promise; },
          settleEphemeralInput: async ({ settlement }) => {
            settlements.push(settlement);
          },
          // A Session details tab has no page location: a write after the draft ends is the refused route write.
          replacePageLocation: ({ subPath }) => {
            locationWrites.push(subPath);
            throw new Error('This tab has no page location');
          },
          publishCurrentUiContext: () => {},
          executeAction: async ({ action, input }) => {
            if (action === 'tasks/create-v1' || action === 'create') {
              createWrites += 1;
              return {
                kind: 'applied',
                observation: source.getResult,
              };
            }
            if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
              listReads += 1;
              return await listTriageEntries(
                TriageListEntriesInputV1Schema.parse(input),
                {
                  sourceInstances: collections.sourceInstances,
                  readAdmittedSources: async () => [],
                  executeScan: async () => {
                    throw new Error('No source has been configured');
                  },
                },
              );
            }
            if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1)
              return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(input),
                { collections, nowMs: () => Date.now() },
              );
            if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1)
              return await readTriageSavedViewsForSurface(
                TriageReadSavedViewsInputV1Schema.parse(input),
                {
                  catalog: accountKv.catalog(
                    TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1,
                  ),
                  mintViewId: () => 'unused',
                },
              );
            if (action === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1)
              return await readTriageActionsForSurface(
                TriageReadActionsInputV1Schema.parse(input),
                {
                  catalog: accountKv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                },
              );
            throw new Error(`Unexpected Action ${String(action)}`);
          },
        },
      });
    });
    try {
      await expect(page.getByText(DRAFT_PURPOSE)).resolves.toEqual({
        content: DRAFT_PURPOSE,
      });
      expect(settlements).toEqual([]);
      if (creates > 0) {
        await act(async () => { await page.press(await page.findByRole('button', { name: 'Issue' })); });
        await page.findByRole('button', { name: press });
      }
      const readsWhileDrafting = listReads;
      const writesWhileDrafting = [...locationWrites];

      await act(async () => {
        await page.press(await page.getByRole('button', { name: press }));
      });

      expect(createWrites).toBe(creates);
      expect(opened).toHaveLength(creates);
      if (creates) {
        expect(opened[0]).toMatchObject({ input: { entryRef: { source: source.configuredInstance.instance.source, ...source.getResult.localRef } } });
        expect(settlements).toEqual([]);
        await act(async () => { navigation.resolve(); });
      }
      expect(settlements).toEqual([{ kind: 'cancelled' }]);
      await expect(page.queryByText(DRAFT_PURPOSE)).resolves.toBeUndefined();
      // Nothing took the draft's place while the pane owner closes the tab: no list read, no location write.
      expect(listReads).toBe(readsWhileDrafting);
      expect(locationWrites).toEqual(writesWhileDrafting);
      await act(async () => {
        await page.updateSurface(await page.context.hostApi.context());
      });
      expect(settlements).toHaveLength(1);
      expect(locationWrites).toEqual(writesWhileDrafting);
    } finally {
      await act(async () => {
        await page.dispose();
      });
    }
  },
);
