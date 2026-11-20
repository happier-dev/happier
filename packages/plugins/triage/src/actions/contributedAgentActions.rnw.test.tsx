// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import {
  definePlugin,
  type PluginAccountApi,
  type PluginServices,
} from '@happier-dev/plugin-sdk';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  TRIAGE_DEFAULT_FIX_ACTION_ID_V1,
  TriageAgentActionsContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST, TRIAGE_PLUGIN } from '../manifest.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import {
  resolveTriageConfiguredActionForExecutionV1,
  type TriageActionResolutionHostV1,
} from '../sessions/actionResolution.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { readTriageActionsProjectionV1 } from '../ui/actions/actionsCommand.js';
import {
  TriageEntryActionControls,
  type TriageEntryActionRequestV1,
} from '../ui/header/entryActionControls.js';
import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageReadActionsResultV1Schema,
} from './actionsCatalogProtocol.js';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 } from './configuredActionRunProtocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACTION_ID = 'example.tracker/triage-issue';
const REPOSITORY = {
  kind: 'github',
  deployment: 'https://github.com',
  repository: 'example/repository',
};
/** The agent's own run of a configured record; a repository handoff stops at the composer it cannot open headless. */
const runAsAgent = {
  v: 1,
  handoff: {
    task: 'investigate',
    configuredActionId: ACTION_ID,
    context: { kind: 'repository', repository: REPOSITORY },
    evidence: [{
      kind: 'releaseNotes',
      repository: REPOSITORY,
      selector: { kind: 'proposed', tagName: 'v1', targetCommitish: 'main' },
      contextText: 'The selected release evidence.',
    }],
    sessionChoice: { kind: 'new' },
    agentChoice: { kind: 'configured' },
    delivery: 'compose',
  },
};
const LABEL = 'Triage this issue';

/** A separately authored plugin: public SDK and the published Triage protocol only, no Triage internals. */
const TRACKER = definePlugin({
  id: 'example.tracker',
  version: '0.0.0',
  contributesTo: {
    'happier.triage': {
      'agent-actions': {
        'triage-issue': TriageAgentActionsContributionProtocolV1.contribute({
          descriptor: {
            label: LABEL,
            appliesTo: ['issue'],
            workspaceMode: 'repository',
            launchMode: 'review',
            instruction:
              'Reproduce this issue, label it, and propose the smallest fix.',
          },
          // A declaration only: the target invokes nothing on the contributor.
          operations: {},
        }),
      },
    },
  },
});

const disposables: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const disposable of disposables.splice(0).reverse())
    await disposable.dispose();
});

async function installTracker() {
  const kv = createTestkitAccountKv();
  const contributor = await createPluginTestkit({
    manifest: TRACKER.manifest,
    module: TRACKER,
  });
  // Account storage is the network/database boundary; catalog policy and CAS stay real.
  const storage = { account: { kv: kv.kv } } as unknown as StorageService;
  let triage!: PluginTestkit;
  // The host's admitted-contribution service is the genuine boundary. The SDK testkit admits the real declaration
  // and drops it once the contributor is gone; this adapter adds only the descriptor the testkit omits.
  const targetedContributions = {
    observeForSelf: (
      point: Parameters<PluginTestkit['readTargetedContributionFixture']>[0],
    ) => ({
      readCurrent: async () => {
        const snapshot = triage.readTargetedContributionFixture(point);
        return {
          ...snapshot,
          contributions: snapshot.contributions.map((entry) => ({
            ...entry,
            descriptor:
              TRACKER.manifest.contributes?.targetedPluginContributions?.find(
                (declaration) =>
                  declaration.id === entry.contributor.contributionId,
              )?.descriptor,
          })),
        };
      },
      dispose: () => {},
    }),
  } as unknown as PluginServices['targetedContributions'];
  triage = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: {
      ...TRIAGE_PLUGIN,
      // Every registered handler, including Actions one Action calls through the host, sees that same boundary.
      activateAccount(api: PluginAccountApi) {
        TRIAGE_PLUGIN.activateAccount({
          ...api,
          actions: {
            register(id, handler, options) {
              api.actions.register(
                id,
                // Preserve the executable parsers attached by definePlugin
                // while substituting only the admitted contribution service.
                new Proxy(handler, {
                  apply(registered, _receiver, [input, context]: Parameters<typeof handler>) {
                    return registered(input, {
                      ...context,
                      services: { ...context.services, targetedContributions },
                    });
                  },
                }),
                options,
              );
            },
          },
        });
      },
    },
    targetedContributionContributors: [contributor],
    services: { storage },
  });
  disposables.push(triage);
  // An agent's calls: the same registered Account Actions, invoked on the agent surface.
  const agent: TriageActionResolutionHostV1 = {
    executeAction: (action, input) =>
      triage.invokeAction(
        typeof action === 'string' ? action : action.localId,
        input,
        { surface: 'agent' },
      ),
  };
  const readCatalog = async () =>
    TriageReadActionsResultV1Schema.parse(
      await agent.executeAction(TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, {
        v: 1,
      }),
    );
  return { kv, contributor, agent, readCatalog };
}

async function renderIssueControls(
  read: ReturnType<typeof readTriageActionsProjectionV1>,
) {
  const requests: TriageEntryActionRequestV1[] = [];
  const fixture = await createPluginUiTestkit({
    identity: {
      instanceId: 'contributed-agent-action',
      mountNonce: `mount-${disposables.length}`,
    },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: 'issue-7', kindId: 'issue' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={read.value.actions}
        workflowSubject="issue"
        viewerIsAuthor
        reviewPreparation="unsupported"
        onAction={(request) => {
          requests.push(request);
        }}
      />
    )),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
  });
  disposables.push(fixture);
  return { fixture, requests };
}

describe('a plugin-contributed agent action', () => {
  it('joins the catalog, renders on the shared AgentActionButton for an issue, launches through the shared flow, and leaves with its plugin', async () => {
    const { kv, contributor, agent, readCatalog } = await installTracker();

    // An agent lists it through the existing catalog Action, exactly as the UI does.
    const listed = await readCatalog();
    expect(
      listed.actions.find((action) => action.actionId === ACTION_ID),
    ).toMatchObject({
      label: LABEL,
      enabled: true,
      appliesTo: ['issue'],
      workspaceMode: 'repository',
      target: { kind: 'agent', delivery: 'compose' },
    });

    // The person turns Fix off in Settings (the existing administer Action), so the contributed record becomes the
    // issue's primary. That write stores the catalog, but not the contributed record nobody touched.
    expect(
      await agent.executeAction(TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, {
        v: 1,
        kind: 'delete',
        actionId: TRIAGE_DEFAULT_FIX_ACTION_ID_V1,
        expectedRevision: listed.revision,
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      JSON.stringify(kv.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)),
    ).not.toContain(ACTION_ID);

    // The shared AgentActionButton draws it for an issue, and pressing it hands the shared launch this record.
    const { fixture, requests } = await renderIssueControls(
      readTriageActionsProjectionV1(await readCatalog()),
    );
    await expect(
      fixture.getByRole('button', { name: `${LABEL} options` }),
    ).resolves.toBeDefined();
    await act(async () => {
      await fixture.press(await fixture.getByRole('button', { name: LABEL }));
    });
    expect(requests.map((request) => request.action.actionId)).toEqual([
      ACTION_ID,
    ]);

    // The launch resolves the pressed record at the shared configured-run owner, called as an agent would.
    expect(
      await resolveTriageConfiguredActionForExecutionV1(
        agent,
        ACTION_ID,
        'issue',
      ),
    ).toMatchObject({ status: 'resolved', action: { actionId: ACTION_ID } });
    expect(
      await agent.executeAction(TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, runAsAgent),
    ).toMatchObject({ v: 1, handoff: { kind: 'unavailable', reason: 'composerUnavailable' } });

    // Disabling the plugin withdraws its contribution: the untouched record is no longer offered anywhere.
    await contributor.dispose();
    expect(
      (await readCatalog()).actions.map((action) => action.actionId),
    ).not.toContain(ACTION_ID);
    expect(
      await resolveTriageConfiguredActionForExecutionV1(
        agent,
        ACTION_ID,
        'issue',
      ),
    ).toEqual({ status: 'unavailable', reason: 'unknownAction' });
    expect(
      await agent.executeAction(TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, runAsAgent),
    ).toMatchObject({ v: 1, handoff: { kind: 'unavailable', reason: 'configuredActionUnavailable' } });
    const after = await renderIssueControls(
      readTriageActionsProjectionV1(await readCatalog()),
    );
    await expect(
      after.fixture.queryByRole('button', { name: LABEL }),
    ).resolves.toBeUndefined();
  });
});
