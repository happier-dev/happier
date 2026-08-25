// @vitest-environment jsdom

import { act } from 'react';

import type {
  PluginInvocationContext,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type {
  PluginAccountCollectionDefinition,
  PluginAccountCollectionForDefinition,
} from '@happier-dev/plugin-sdk/collections';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginTestkit,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, usePluginHostApi } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiContextEnrichmentV1 } from '@happier-dev/plugin-sdk/ui';
import {
  formatQualifiedPluginActionId,
  PluginProjectedActionV2Schema,
  type DaemonPluginStructuredMessageActionExecuteRequest,
  type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';
import { composeCurrentUiContextSnapshotFromNavigation } from './currentUiContextModel';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  githubSearchResponse,
} from '../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { encodeGithubTriageConfiguration } from '../../../../../../packages/plugins/scm-github/src/triage/configuration';
import {
  GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from '../../../../../../packages/plugins/scm-github/src/triage/contribution';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import {
  createStubGithubTransport,
  GITHUB_TEST_ACCOUNT,
} from '../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { scanGithubTriageSource } from '../../../../../../packages/plugins/scm-github/src/triage/operations';
import {
  activate as activateTriage,
  manifest as triageManifest,
} from '../../../../../../packages/plugins/triage/src/index';
import {
  listTriageEntries,
  type TriageAdmittedSourceV1,
} from '../../../../../../packages/plugins/triage/src/actions/listEntries';
import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
} from '../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol';
import {
  CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
  CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../../../../../../packages/plugins/triage/src/corpus/collections/ids';
import { toCorpusStoredValue } from '../../../../../../packages/plugins/triage/src/corpus/collections/rowCodec';
import type { CorpusSourceInstanceRowV1 } from '../../../../../../packages/plugins/triage/src/corpus/collections/rows';
import { createTestkitCorpusCollections } from '../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support';
import { createTriageListWindowStore } from '../../../../../../packages/plugins/triage/src/projection/listWindowStore';
import { projectTriageCurrentUiContextV1 } from '../../../../../../packages/plugins/triage/src/ui/currentContext';
import { useTriageCurrentUiContextPublication } from '../../../../../../packages/plugins/triage/src/ui/shell/root';
import { TRIAGE_SURFACE_INITIAL_STATE_V1 } from '../../../../../../packages/plugins/triage/src/ui/state/surface';

const machineRpcBoundary = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcBoundary,
}));

const MACHINE_ID = 'machine-triage-proof';
const SERVER_ID = 'server-triage-proof';
const TRIAGE_PLUGIN_ID = 'happier.triage';
const TRIAGE_ACTION_ID = `${TRIAGE_PLUGIN_ID}/${TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1}`;
const TRIAGE_DISCOVERY_ACTION_ID = formatQualifiedPluginActionId({
  pluginId: TRIAGE_PLUGIN_ID,
  localId: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
});
const SOURCE = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
});
const SOURCE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_REF = Object.freeze({
  source: SOURCE,
  kindId: 'pull-request',
  collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
  entryId: '1284',
});

function configuredGithubSourceRow(): CorpusSourceInstanceRowV1 {
  const token = encodeGithubTriageConfiguration({
    v: 1,
    scope: {
      kind: 'repository',
      repositoryKey: `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase(),
    },
  });
  if (token === null) throw new Error('GitHub test configuration must encode');
  return {
    instanceTag: `a${'0'.repeat(42)}`,
    sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
    lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
    configuredAtMs: 1,
    configured: {
      v: 1,
      instance: { source: SOURCE, sourceInstanceId: SOURCE_INSTANCE_ID },
      binding: {
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        account: GITHUB_TEST_ACCOUNT,
      },
      localInstanceKey: 'github.com',
      configuration: { v: 1, token },
      locator: { v: 1, displayLabel: `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}` },
    },
  };
}

function accountStorageServices(
  collections: ReturnType<typeof createTestkitCorpusCollections>['collections'],
): Pick<PluginInvocationContext['services'], 'storage' | 'targetedContributions'> {
  const targetedContributions: TargetedContributionsService = Object.freeze({
    observeForSelf<TContribution>() {
      return Object.freeze({
        dispose() {},
        async readCurrent() {
          return Object.freeze({
            generation: 'empty-current-targeted-view',
            contributions: Object.freeze([]) as readonly TContribution[],
          });
        },
      });
    },
  });
  return {
    storage: {
      // Triage consumes Collections only; Account KV remains outside this boundary fixture.
      account: {
        collection<TDefinition extends PluginAccountCollectionDefinition>(
          definition: TDefinition,
        ): PluginAccountCollectionForDefinition<TDefinition> {
          const collection = definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
            ? collections.sourceInstances
            : definition.id === 'session-links'
              ? collections.sessionLinks
              : collections.userMarks;
          // This fixture is the genuine typed account-Collection host boundary.
          return collection as unknown as PluginAccountCollectionForDefinition<TDefinition>;
        },
      } as unknown as NonNullable<PluginInvocationContext['services']['storage']['account']>,
      // The Triage list handler does not consume ephemeral or daemon storage scopes.
    } as unknown as PluginInvocationContext['services']['storage'],
    targetedContributions,
  };
}

async function createTriageVertical(): Promise<Readonly<{
  triage: PluginTestkit;
  collections: ReturnType<typeof createTestkitCorpusCollections>;
}>> {
  const collections = createTestkitCorpusCollections();
  const triage = await createPluginTestkit({
    manifest: triageManifest,
    module: { activate: activateTriage },
    services: accountStorageServices(collections.collections),
  });
  return Object.freeze({ triage, collections });
}

function createTriageVoiceProjection() {
  const executionOrigin: PluginMachineExecutionOriginV1 = {
    serverIdentityId: 'srv_triage_proof',
    materializationRef: {
      pluginId: TRIAGE_PLUGIN_ID,
      machineId: MACHINE_ID,
      materializationId: 'triage-proof-materialization',
    },
  };
  const declaration = (triageManifest.contributes.actions ?? []).find(
    (action) => action.id === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  );
  if (declaration === undefined) throw new Error('Triage list Action is not declared');
  const projectedAction = PluginProjectedActionV2Schema.parse({
    id: declaration.id,
    pluginId: TRIAGE_PLUGIN_ID,
    title: declaration.title,
    description: declaration.description,
    scopes: declaration.scopes,
    surfaces: declaration.surfaces,
    execution: declaration.execution,
    inputSchema: declaration.inputSchema,
    outputSchema: declaration.resultSchema,
    dangerLevel: declaration.dangerLevel,
    available: true,
    serverIdentityId: executionOrigin.serverIdentityId,
    materializationRef: executionOrigin.materializationRef,
  });
  const projection = normalizePluginUiProjection({
    v: 2,
    generation: 7,
    installedPackagesById: {},
    agentsById: {},
    backendsById: {},
    actionsById: {
      [TRIAGE_ACTION_ID]: projectedAction,
    },
    toolsById: {},
    commandsById: {},
    resourcesById: {},
    settingsById: {},
    familiesById: {},
    diagnostics: [],
  });
  return unionPluginUiProjections([{
    machineId: MACHINE_ID,
    serverId: SERVER_ID,
    projection,
    phase: 'current',
    interactionEnabled: true,
  }], new Map([[TRIAGE_PLUGIN_ID, executionOrigin]])).pluginUiProjection;
}

/**
 * These are source-corridor tests, not end-to-end composition proof. The first
 * exercises GitHub observation -> Triage projection/publication; the second
 * exercises projected Voice Action -> unified dispatcher. Loaded proof still
 * has to traverse the real AppShell provider, attempt port, and current command.
 */
describe('Triage/GitHub projection and Voice Action source corridors', () => {
  it('projects a GitHub list observation through the mounted Triage publisher without detail text', async () => {
    const collections = createTestkitCorpusCollections();
    collections.control.sourceInstances.seed(toCorpusStoredValue(configuredGithubSourceRow()));
    const githubTransport = createStubGithubTransport({
      respond: (request) => request.url.startsWith('https://api.github.com/search/issues')
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }),
          }
        : undefined,
    });
    const scanHandle = Object.freeze({ role: 'scan' });
    const admittedSource = {
      contributor: {
        pluginId: SOURCE.pluginId,
        contributionId: SOURCE.localId,
        immutableGenerationId: 'github-current',
      },
      protocol: {
        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
        version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
      },
      descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
      operations: { listInstances: {}, scan: scanHandle, get: {} },
      surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1;
    const windowStore = createTriageListWindowStore({
      readEntries: async (input) => await listTriageEntries(input, {
        sourceInstances: collections.collections.sourceInstances,
        readAdmittedSources: async () => [admittedSource],
        executeScan: async (_operation, scanInput) => await scanGithubTriageSource(
          scanInput,
          githubTransport.context,
        ),
        nowMs: () => 1_700_000_000_000,
      }),
      nowMs: () => 1_700_000_000_000,
    });
    await windowStore.refresh('view');
    const window = windowStore.getSnapshot().window;
    if (window === undefined) throw new Error('Expected the mounted Triage window');
    const enrichment = projectTriageCurrentUiContextV1({
      surface: {
        ...TRIAGE_SURFACE_INITIAL_STATE_V1,
        selection: {
          sectionId: 'open',
          entryRef: ENTRY_REF,
          sourceInstanceId: SOURCE_INSTANCE_ID,
        },
      },
      visibleRows: window.rows,
    });
    const publicationSurface = defineUiSurface(() => {
      useTriageCurrentUiContextPublication(usePluginHostApi(), enrichment);
      return null;
    });
    const mounted: PluginUiTestkit[] = [];
    let published: PluginUiContextEnrichmentV1 | null = null;
    try {
      await act(async () => {
        mounted.push(await createPluginUiTestkit({
          identity: {
            pluginId: TRIAGE_PLUGIN_ID,
            pluginVersion: '0.0.0',
            viewId: 'triage-list',
            generation: 'triage-github-current-context-proof',
          },
          surface: publicationSurface,
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter(),
          handlers: {
            publishCurrentUiContext: ({ enrichment }) => {
              published = enrichment;
            },
          },
        }));
      });

      const port = createCurrentUiContextVoiceToolPort({
        reader: {
          readCurrentUiContext: () => published === null
            ? null
            : composeCurrentUiContextSnapshotFromNavigation(
                { area: 'app', screen: 'triage' },
                {
                  ...(published.entity === undefined ? {} : { entity: published.entity }),
                  ...(published.detail === undefined ? {} : { detail: published.detail }),
                  commands: (published.commands ?? []).map((command, index) => ({
                    id: `triage-proof-command-${index}`,
                    title: command.title,
                    ...(command.description === undefined ? {} : { description: command.description }),
                  })),
                },
              ),
          resolveCurrentUiCommand: () => null,
          subscribe: () => () => undefined,
        },
        readProjection: () => null,
        readNavigationBinding: () => null,
      });
      const snapshot = port.readCurrentUiContext();

      expect(snapshot?.entity).toEqual({
        kind: 'pull-request',
        label: 'Stream terminal frames without a full re-render',
        reference: ENTRY_REF,
      });
      expect(snapshot?.entity).not.toHaveProperty('summary');
      expect(JSON.stringify(snapshot)).not.toContain('Reworks the frame pump');
      expect(JSON.stringify(snapshot)).not.toContain('comments');
    } finally {
      await mounted[0]?.dispose();
      windowStore.dispose();
    }
  });

  it('projects the registered Triage list Action into the dynamic Voice catalog and delegates through the unified dispatcher', async () => {
    const vertical = await createTriageVertical();
    const projection = createTriageVoiceProjection();
    if (projection === null) throw new Error('Expected the Triage action projection');
    let handlerCalls = 0;
    let handlerError: unknown = null;
    machineRpcBoundary.mockReset();
    machineRpcBoundary.mockImplementation(async (request: Readonly<{
      payload: DaemonPluginStructuredMessageActionExecuteRequest;
    }>) => {
      handlerCalls += 1;
      try {
        if (request.payload.input === undefined) throw new Error('Expected the projected Triage input');
        return {
          ok: true,
          result: await vertical.triage.invokeAction(
            TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
            request.payload.input,
            { surface: 'voice' },
          ),
        };
      } catch (error) {
        handlerError = error;
        throw error;
      }
    });
    try {
      const port = createCurrentUiContextVoiceToolPort({
        reader: {
          readCurrentUiContext: () => null,
          resolveCurrentUiCommand: () => null,
          subscribe: () => () => undefined,
        },
        readProjection: () => projection,
        readNavigationBinding: () => null,
      });

      expect(port.listCurrentContributedActionDefinitions?.().map((action) => action.id))
        .toContain(TRIAGE_DISCOVERY_ACTION_ID);
      const outcome = await port.invokeAction?.({
        action: {
          pluginId: TRIAGE_PLUGIN_ID,
          localId: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
        },
        input: {
          v: 1,
          sources: { kind: 'allConfigured' },
          limit: 10,
          order: 'newest',
        },
      });
      expect(handlerError).toBeNull();
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          v: 1,
          configuredSources: [],
          window: { rows: [] },
        },
      });
      expect(handlerCalls).toBe(1);
    } finally {
      await vertical.triage.dispose();
    }
  });
});
