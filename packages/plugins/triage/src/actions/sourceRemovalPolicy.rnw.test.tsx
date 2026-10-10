// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources';
import {
  normalizeActionsSettingsV1, setActionApprovalOverride, isApprovalRequiredByActionsSettings,
  createPluginActionInvocation, createPluginActionPresentUserGate,
  formatQualifiedPluginActionId, pluginActionRequiresPresentUserIntent,
} from '@happier-dev/protocol';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TriageSourceAdministrationActionInputV1Schema, TriageSourceInstanceDraftV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SESSION_LINKS_COLLECTION_ID } from '../corpus/collections/ids.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTriageAdministerSourceInstanceActionHandler } from './administerSourceInstanceAction.js';
import { createTriageReadConfiguredSourceInstancesActionHandler } from './readConfiguredSourceInstances.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = { pluginId: 'example.tracker', localId: 'tracker' };
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const action = PLUGIN_MANIFEST.contributes.actions.find((entry) => entry.id === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId);
if (!action) throw new Error('Source administration Action must be declared');
const descriptor = action;
const qualifiedId = formatQualifiedPluginActionId(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1);
const defaults = normalizeActionsSettingsV1({ v: 1, actions: {} });
const allowed = setActionApprovalOverride({ settings: defaults, actionId: qualifiedId, surface: 'ui', approvalRequired: false });
const reset = setActionApprovalOverride({ settings: allowed, actionId: qualifiedId, surface: 'ui', approvalRequired: null });
const draft = TriageSourceInstanceDraftV1Schema.parse({
  v: 1, binding: { purpose: 'tracker-account', account: {
    service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1',
  } },
  localInstanceKey: 'acme/api', keyStability: 'stable', configuration: { v: 1, token: 'opaque' },
  locator: { v: 1, displayLabel: 'acme/api' },
});
const surface = createTriageSourceSettingsSurface({
  pluginId: SOURCE.pluginId, listInstancesLocalActionId: 'list-instances',
  connectedAccountServiceLocalId: 'accounts', sourceDisplayName: 'Example tracker',
});
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const page of mounted.splice(0)) await page.dispose(); });

describe('source Remove through the shared Action admission and durable writer', () => {
  it.each([
    { name: 'default asks once', settings: defaults, approved: true, prompts: 1, lifecycle: 'retired' },
    { name: 'Allowed asks nothing', settings: allowed, approved: true, prompts: 0, lifecycle: 'retired' },
    { name: 'reset restores Ask first', settings: reset, approved: true, prompts: 1, lifecycle: 'retired' },
    { name: 'decline preserves the configured source', settings: defaults, approved: false, prompts: 1, lifecycle: 'active' },
  ])('$name', async ({ settings, approved, prompts, lifecycle }) => {
    const { collections } = createTestkitCorpusCollections();
    // Host-owned admission/catalog handles and Account database transport are
    // boundaries; source ownership, lifecycle, schemas, and policy stay real.
    const admitted = [{
      contributor: { pluginId: SOURCE.pluginId, contributionId: SOURCE.localId, immutableGenerationId: 'generation-1' },
      protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
      descriptor: { v: 1, purpose: 'tracker-account', displayName: 'Example tracker',
        kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
      operations: { listInstances: {}, scan: {}, get: {} }, surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];
    const context = {
      signal: new AbortController().signal, surface: 'plugin',
      caller: { kind: 'plugin', pluginId: SOURCE.pluginId,
        contribution: { id: 'settings', qualifiedId: `${SOURCE.pluginId}/settings` },
        materialization: { pluginId: SOURCE.pluginId, machineId: 'machine-1', materializationId: 'materialization-1' } },
      services: {
        storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => (
          definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances
            : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks : collections.userMarks
        ) } },
        targetedContributions: { observeForSelf: () => ({
          readCurrent: async () => ({ generation: 'generation-1', contributions: admitted }), dispose: () => {},
        }) },
      },
    } as unknown as PluginInvocationContext;
    const administer = createTriageAdministerSourceInstanceActionHandler({ mintSourceInstanceId: () => INSTANCE_ID, nowMs: () => 1_000 });
    const read = createTriageReadConfiguredSourceInstancesActionHandler();
    expect(await administer({ v: 1, kind: 'create', draft }, context)).toEqual({ kind: 'active', sourceInstanceId: INSTANCE_ID });

    const dialogs: string[] = [];
    const gate = createPluginActionPresentUserGate({
      resolve: () => ({ status: 'resolved', action: descriptor, policy: {
        qualifiedId, occurrenceId: 'triage-1', dangerLevel: descriptor.dangerLevel,
        scopes: descriptor.scopes, surfaces: descriptor.surfaces,
        ...(descriptor.confirmation ? { confirmation: descriptor.confirmation } : {}),
        approvalRequiredByActionSettings: isApprovalRequiredByActionsSettings(
          qualifiedId, settings, { surface: 'ui' }, undefined, pluginActionRequiresPresentUserIntent(descriptor, 'ui'),
        ),
        authorization: {
          generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
          resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [],
        },
      } }),
      requestCurrentIntent: async ({ fingerprint }) => {
        dialogs.push('Action policy');
        return approved ? { status: 'approved', fingerprint }
          : { status: 'rejected', code: 'plugin_action_current_intent_rejected' };
      },
    });
    const invocation = createPluginActionInvocation({
      ...TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
      inputSchema: descriptor.inputSchema, resultSchema: descriptor.resultSchema,
      occurrenceSignal: context.signal, isCurrent: () => true,
    });
    const admissions: string[] = [];
    let page!: PluginUiTestkit;
    await act(async () => {
      page = await createPluginUiTestkit({
        identity: { instanceId: 'settings-1', mountNonce: 'mount-1' },
        authorPlugin: { id: SOURCE.pluginId, version: '0.0.0' }, surface,
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: {
          // Dialog presentation is the only UI boundary replaced. A stray local
          // question is observable alongside the actual policy-owned decision.
          confirm: () => { dialogs.push('local question'); return true; },
          executeAction: async ({ action: ref, input, signal }): Promise<JsonValue> => {
            if (ref.pluginId === SOURCE.pluginId) return { kind: 'complete', candidates: [draft], failures: [] };
            if (ref.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId) return await read({ v: 1 }, context);
            if (ref.localId !== descriptor.id) throw new Error('Unexpected Action');
            const result = await invocation.invoke(input, {
              signal,
              preDispatch: async ({ input: normalized }) => {
                const decision = await gate.admit({ input: normalized, surface: 'ui', invocationSurface: 'ui', signal });
                admissions.push(decision.status);
                return decision.status === 'admitted' ? null : {
                  status: 'unavailable', code: decision.status === 'deferred' ? 'plugin_action_current_intent_unavailable' : decision.code,
                  message: 'Source change was not approved',
                };
              },
              handler: async ({ input: normalized }) => await administer(TriageSourceAdministrationActionInputV1Schema.parse(normalized), context),
            });
            if (result.status !== 'executed') throw new Error(result.message);
            return result.value;
          },
        },
      });
    });
    mounted.push(page);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Remove acme/api from PRs & Issues' })); });
    expect(dialogs).toEqual(prompts === 0 ? [] : ['Action policy']);
    expect(admissions).toEqual([approved ? 'admitted' : 'unavailable']);
    expect(await read({ v: 1 }, context)).toMatchObject({ kind: 'read', instances: [
      { lifecycle, configured: { instance: { sourceInstanceId: INSTANCE_ID } } },
    ] });
    expect(await page.getByRole('button', { name: lifecycle === 'retired'
      ? 'Restore acme/api to PRs & Issues' : 'Remove acme/api from PRs & Issues' })).toBeDefined();
  });
});
