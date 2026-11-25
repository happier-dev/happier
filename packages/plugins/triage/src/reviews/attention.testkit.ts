import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import {
  TriageGetInputV1Schema, TriageGetResultV1Schema,
  TriageReadAttentionInputV1Schema, TriageReadAttentionResultV1Schema, TriageScanInputV1Schema, TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { TRIAGE_ACCOUNT_ACTIONS } from '../accountDefinition.js';
import { PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { createReviewSourceContributionV1 } from './contribution.js';

/** Exercise the registered source through its admitted targeted-operation boundary. */
export async function createRegisteredReviewSourceTestkit(actions: PluginServices['actions']): Promise<PluginTestkit> {
  let kit: PluginTestkit;
  // Keep the real declaration and handlers without loading unrelated collection schemas.
  const source = definePlugin({ id: 'happier.triage', version: '0.0.0',
    contributionPoints: PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS,
    contributesTo: { 'happier.triage': { sources: { reviews: createReviewSourceContributionV1() } } },
    actions: { ...Object.fromEntries(
      Object.entries(TRIAGE_ACCOUNT_ACTIONS).filter(([id]) => id.startsWith('internal/reviews/')),
    ), 'test-read': { title: 'Read admitted Review attention', surfaces: ['cli'], dangerLevel: 'safe',
      inputSchema: TriageReadAttentionInputV1Schema, resultSchema: TriageReadAttentionResultV1Schema,
      run: async (input, context) => context.services.actions.executeAdmittedTargetedOperation(
        kit.issueAdmittedTargetedOperation({ point: TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
          contributor: { testkit: kit, contributionId: 'reviews' }, role: 'readAttention' }), input),
    }, 'test-scan': { title: 'Scan admitted Reviews', surfaces: ['cli'], dangerLevel: 'safe',
      inputSchema: TriageScanInputV1Schema, resultSchema: TriageScanResultV1Schema,
      run: async (input, context) => context.services.actions.executeAdmittedTargetedOperation(
        kit.issueAdmittedTargetedOperation({ point: TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
          contributor: { testkit: kit, contributionId: 'reviews' }, role: 'scan' }), input),
    }, 'test-get': { title: 'Get an admitted Review', surfaces: ['cli'], dangerLevel: 'safe',
      inputSchema: TriageGetInputV1Schema, resultSchema: TriageGetResultV1Schema,
      run: async (input, context) => context.services.actions.executeAdmittedTargetedOperation(
        kit.issueAdmittedTargetedOperation({ point: TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
          contributor: { testkit: kit, contributionId: 'reviews' }, role: 'get' }), input),
    } },
  });
  kit = await createPluginTestkit({ manifest: source.manifest, module: source, services: { actions } });
  return kit;
}
