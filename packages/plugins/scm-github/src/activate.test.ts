import { describe, expect, it } from 'vitest';
import { ConversationProvidersContributionProtocolV1 } from '@happier-dev/channels-protocol/v1';
import { assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import {
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1,
  PLUGIN_MANIFEST,
} from './manifest.js';
import { GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID } from './observations/githubAutomationEventCheckpoint.js';
import {
  GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
  GITHUB_WEBHOOK_CONTRIBUTION_ID,
} from './observations/githubProviderContracts.js';

const GITHUB_WEBHOOK_ACTION_ID = 'github/accept-webhook';
const GITHUB_CHANNEL_ACTION_IDS = Object.freeze({
  setup: 'github/prepare-repository',
  connectionTest: 'github/inspect-connection',
  endpointResolve: 'github/choose-thread',
  principalResolve: 'github/inspect-principal',
  observationsPoll: 'github/read-comments',
  messageDeliver: 'github/create-comment',
});

const GITHUB_CHANNEL_PROVIDER_OPERATIONS = Object.freeze({
  setup: GITHUB_CHANNEL_ACTION_IDS.setup,
  connectionTest: GITHUB_CHANNEL_ACTION_IDS.connectionTest,
  endpointResolve: GITHUB_CHANNEL_ACTION_IDS.endpointResolve,
  principalResolve: GITHUB_CHANNEL_ACTION_IDS.principalResolve,
  observationsPoll: GITHUB_CHANNEL_ACTION_IDS.observationsPoll,
  messageDeliver: GITHUB_CHANNEL_ACTION_IDS.messageDeliver,
});

const GITHUB_CHANNEL_PROVIDER_ACTIONS = [
  { role: 'setup', localId: GITHUB_CHANNEL_ACTION_IDS.setup },
  { role: 'connectionTest', localId: GITHUB_CHANNEL_ACTION_IDS.connectionTest },
  { role: 'endpointResolve', localId: GITHUB_CHANNEL_ACTION_IDS.endpointResolve },
  { role: 'principalResolve', localId: GITHUB_CHANNEL_ACTION_IDS.principalResolve },
  { role: 'observationsPoll', localId: GITHUB_CHANNEL_ACTION_IDS.observationsPoll },
  { role: 'messageDeliver', localId: GITHUB_CHANNEL_ACTION_IDS.messageDeliver },
] as const;

describe('activate', () => {
  it('serializes one checkpointed-pull provider contribution while retaining webhook reception as generic Webhooks', async () => {
    assertConversationProviderContributionV1(PLUGIN_MANIFEST);
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

    try {
      // Two targeted contributions to two different target plugins: the Channels
      // provider, and the Triage source whose three read Actions this activation also
      // registers. Neither is a second owner of the other's concept.
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions).toEqual(
        expect.arrayContaining([{
          id: 'github-repository',
          target: { pluginId: 'happier.channels', pointId: 'providers' },
          protocol: { id: 'happier.channels/providers', version: 1 },
          operations: GITHUB_CHANNEL_PROVIDER_OPERATIONS,
        }]),
      );
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions
        .map((contribution) => contribution.target.pluginId).sort())
        .toEqual(['happier.channels', 'happier.triage']);
      expect(testkit.registrations()).toEqual(expect.arrayContaining([
        { family: 'actions', localId: GITHUB_WEBHOOK_ACTION_ID },
        ...Object.values(GITHUB_CHANNEL_ACTION_IDS).map((localId) => ({ family: 'actions' as const, localId })),
        { family: 'actions', localId: 'automation/setup-repository-event-v1' },
        { family: 'actions', localId: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID },
        { family: 'actions', localId: GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID },
        // Registered ⇒ declared: the Triage reads reach the host through the same
        // generated activation as every other Action this plugin owns.
        ...Object.values(GITHUB_TRIAGE_ACTION_IDS_V1)
          .map((localId) => ({ family: 'actions' as const, localId })),
        // The four source-native detail reads register through the same
        // activation. A declared-but-unregistered detail Action would mount a
        // detail body whose every panel reports a dispatch failure.
        ...Object.values(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1)
          .map((localId) => ({ family: 'actions' as const, localId })),
      ]));
      expect(PLUGIN_MANIFEST.contributes.webhooks).toEqual([expect.objectContaining({
        handlerAction: { localId: GITHUB_WEBHOOK_ACTION_ID },
      })]);

      const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
      expect(actions.get(GITHUB_WEBHOOK_ACTION_ID)).toEqual(expect.objectContaining({
        inputSchema: expect.objectContaining({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: expect.objectContaining({ v: { const: 1 } }),
          additionalProperties: false,
        }),
        resultSchema: expect.objectContaining({
          $schema: 'http://json-schema.org/draft-07/schema#',
          anyOf: expect.any(Array),
        }),
      }));
      for (const { role, localId } of GITHUB_CHANNEL_PROVIDER_ACTIONS) {
        const declaration = ConversationProvidersContributionProtocolV1.operations[role].declaration;
        expect(actions.get(localId)).toEqual(expect.objectContaining({
          resultSchema: declaration.resultSchema.jsonSchema,
          surfaces: declaration.surfaces,
          dangerLevel: declaration.dangerLevel,
        }));
        if (declaration.input.kind === 'protocolDefined') {
          expect(actions.get(localId)?.inputSchema).toEqual(declaration.input.schema.jsonSchema);
        }
      }
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('webhookReceive');
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('connectionStop');
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('deliveryReconcile');
    } finally {
      await testkit.dispose();
    }
  });

  it('registers the manifest-local hosting provider through the generated contribution adapter', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

    try {
      expect(testkit.registrations()).toContainEqual({ family: 'scmHostingProviders', localId: 'github' });
      expect(testkit.registration('scmHostingProviders', 'github')).toEqual(expect.objectContaining({
        adapter: expect.any(Object),
      }));
      expect(testkit.registration('scmHostingProviders', 'github')).not.toHaveProperty('auth');
    } finally {
      await testkit.dispose();
    }
  });

  it('declares the single checkpointed-pull Event observer with its provider-owned checkpoint collection', async () => {
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual({
      id: 'automation-event-checkpoint-storage',
      capability: 'storage.account',
      reason: 'Persist per-Automation GitHub Event source checkpoints.',
      scope: { enabled: true },
    });
    expect(PLUGIN_MANIFEST.contributes.accountCollections).toEqual([
      expect.objectContaining({ id: GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.backgroundServices).toEqual([{
      id: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
      title: 'GitHub repository Event observer',
    }]);

    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(testkit.registrations()).toContainEqual({
        family: 'backgroundServices',
        localId: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
      });
      expect(testkit.registration('backgroundServices', GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID))
        .toEqual(expect.any(Function));
    } finally {
      await testkit.dispose();
    }
  });

  it('declares exact Channels provider Action roles plus the Automation setup and explicit history-gap baseline Actions', () => {
    const sourceSetupAction = PLUGIN_MANIFEST.contributes.actions.find(
      ({ id }) => id === 'automation/setup-repository-event-v1',
    );
    const channelsSetupAction = PLUGIN_MANIFEST.contributes.actions.find(
      ({ id }) => id === GITHUB_CHANNEL_ACTION_IDS.setup,
    );
    const historyGapResetAction = PLUGIN_MANIFEST.contributes.actions.find(
      ({ id }) => id === GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID,
    );
    // The built-in Automation form dispatches this provider fact producer;
    // the Action itself has no direct plugin UI destination.
    expect(sourceSetupAction?.surfaces).toEqual(['plugin']);
    expect(sourceSetupAction).toMatchObject({
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          credentialRef: {
            type: 'object',
            additionalProperties: false,
          },
          repository: {
            type: 'string',
            minLength: 3,
            maxLength: 512,
          },
        },
        required: ['credentialRef', 'repository'],
      },
      inputHints: {
        fields: [{
          path: 'credentialRef',
          title: 'GitHub account',
          description: 'Select the GitHub Connected Account used to resolve the repository.',
          widget: 'select',
          required: true,
          requireExplicitSelection: true,
          connectedAccountOptions: true,
        }, {
          path: 'repository',
          title: 'Repository',
          description: 'Enter the GitHub repository as owner/repository.',
          placeholder: 'owner/repository',
          widget: 'text',
          required: true,
        }],
      },
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: 'github-connected-account',
      }],
    });
    expect(sourceSetupAction).not.toHaveProperty('placement');
    expect(historyGapResetAction).toMatchObject({
      title: 'Start a new GitHub repository Event baseline',
      surfaces: ['plugin'],
      dangerLevel: 'writesLocal',
      execution: { target: 'daemon' },
      confirmation: {
        title: {
          key: 'github.automation.historyGapReset.confirmation.title',
          fallback: 'Start a new baseline',
        },
        body: {
          key: 'github.automation.historyGapReset.confirmation.body',
          fallback: 'Events in the history gap are not replayed.',
        },
      },
      inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
      resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
      hostAccess: ['github-api', 'github-connected-account', 'automation-event-checkpoint-storage'],
    });
    // The reset input deliberately remains the strict source-identity triple.
    // Its exact Account is declared on the source and resolved by the host at
    // operation binding time, so the Action cannot use an unrelated selection.
    expect(historyGapResetAction).not.toHaveProperty('connectedAccountPurposeBindings');
    expect(historyGapResetAction).not.toHaveProperty('placement');
    // Manifest projection may clone the two action declarations; users depend
    // on the same rendered fields, not a shared in-memory object reference.
    expect(channelsSetupAction?.inputHints).toEqual(sourceSetupAction?.inputHints);
    const actionIds = new Set(PLUGIN_MANIFEST.contributes.actions.map(({ id }) => id));
    expect([...actionIds]).toEqual(expect.arrayContaining([
      ...Object.values(GITHUB_CHANNEL_ACTION_IDS),
    ]));
    expect(actionIds).toContain('automation/setup-repository-event-v1');
    expect(actionIds).toContain(GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID);
    expect(actionIds).toContain(GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID);
    const repositoryEvent = PLUGIN_MANIFEST.contributes.events?.find(
      ({ id }) => id === 'automation/repository-event-v1',
    );
    expect(repositoryEvent).toMatchObject({
      kind: 'event',
      payloadSchema: expect.objectContaining({ oneOf: expect.any(Array) }),
      automation: {
        v: 1,
        eligible: true,
        source: {
          sourceContractVersion: 1,
          supportedObservationTransports: ['checkpointedPull', 'durablePush'],
          setupActionRef: {
            pluginId: PLUGIN_MANIFEST.id,
            localId: 'automation/setup-repository-event-v1',
          },
          historyGapResetActionRef: {
            pluginId: PLUGIN_MANIFEST.id,
            localId: GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID,
          },
          connectedAccountPurposeBindings: [{
            path: 'credentialRef',
            purpose: 'github-connected-account',
          }],
          webhookContributionRef: {
            pluginId: PLUGIN_MANIFEST.id,
            localId: GITHUB_WEBHOOK_CONTRIBUTION_ID,
          },
        },
      },
    });
    expect(repositoryEvent?.payloadSchema).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          additionalProperties: false,
          properties: expect.objectContaining({ kind: { const: 'push' } }),
        }),
        expect.objectContaining({
          additionalProperties: false,
          properties: expect.objectContaining({ kind: { const: 'issueOpened' } }),
        }),
        expect.objectContaining({
          additionalProperties: false,
          properties: expect.objectContaining({ kind: { const: 'pullRequestMerged' } }),
        }),
      ]),
    });
    expect(repositoryEvent?.automation?.source?.webhookContributionRef).toEqual({
      pluginId: PLUGIN_MANIFEST.id,
      localId: GITHUB_WEBHOOK_CONTRIBUTION_ID,
    });
    expect(sourceSetupAction).toMatchObject({
      hostAccess: ['github-api', 'github-connected-account'],
      resultSchema: expect.objectContaining({
        properties: expect.objectContaining({ sourceConfig: expect.any(Object) }),
      }),
    });
    expect(sourceSetupAction?.hostAccess?.filter((id) => id === 'github-connected-account'))
      .toEqual(['github-connected-account']);
    const credentialActions = [
      ...Object.values(GITHUB_CHANNEL_ACTION_IDS),
      'automation/setup-repository-event-v1',
      GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
      GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID,
    ];
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'github-connected-account',
      capability: 'connectedAccounts',
      scope: {
        serviceRefs: ['github-account'],
        operations: ['select', 'use'],
        materializationKinds: ['httpHeaders'],
      },
    }));
    for (const actionId of credentialActions) {
      expect(PLUGIN_MANIFEST.contributes.actions.find(({ id }) => id === actionId)?.hostAccess)
        .toContain('github-connected-account');
    }
  });
});
