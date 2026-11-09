import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { describeApprovalActionFields, projectApprovalRequestForPublicRead, resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { createProviderActionExecuteV1 } from '../providers/executeProviderActionV1.js';
import { createAccountProviderActionExecuteV1 } from '../providers/connections/accountProviderActionV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '../providers/connections/connectionRowsV1.js';
import { createPersonalSavedSecretActionExecuteV1 } from '../account/settings/personalSavedSecretActionsV1.js';

describe('approval captured canonical context', () => {
  it.each([
    ['secrets.delete', { secretId: 'saved-secret', expectedUpdatedAt: 7 }],
    ['secrets.delete', { secretId: 'saved-secret', expectedUpdatedAt: 8 }],
    ['providers.connections.create_custom', {
      action: 'createCustom', connectionId: 'provider', savedSecretId: 'saved-secret', enable: true,
      template: { v: 1, name: 'Custom', endpointTemplates: [{ id: 'openai', protocol: 'openai',
        baseUrl: 'https://example.com/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown' } }], catalog: { source: 'manual', manualModelPolicy: 'allowed' } },
    }],
    ['providers.connections.create_custom', {
      action: 'createCustom', connectionId: 'provider', savedSecretId: null, enable: false,
      template: { v: 1, name: 'Custom', endpointTemplates: [{ id: 'openai', protocol: 'openai',
        baseUrl: 'https://example.com/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown' } }], catalog: { source: 'manual', manualModelPolicy: 'allowed' } },
      manualModels: [{ id: 'reviewed-model', name: 'Reviewed model' }],
    }],
    ['providers.defaults.set', { agentTargetKey: 'agent:happier.agent.codex/codex', selection: null }],
    ['providers.defaults.set', { agentTargetKey: 'agent:happier.agent.codex/codex', selection: { v: 1,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'provider', modelId: 'reviewed-model' }, updatedAt: 1 } }],
    ['providers.connections.create_contribution', { action: 'createContribution', connectionId: 'provider',
      contributionKey: 'example.provider/source', displayName: 'Work', savedSecretId: 'saved-secret', enable: true }],
    ['providers.connections.enable_detected', { action: 'enableDetected', connectionId: 'provider', machineId: 'machine',
      candidateId: 'discovery-candidate:v1:candidate', displayName: 'Work', savedSecretId: 'saved-secret' }],
    ['providers.connections.secrets.bind', { action: 'bindSecret', connectionId: 'provider',
      credentialSlotId: 'apiKey', savedSecretId: 'saved-secret', scope: 'account' }],
    ['providers.connections.secrets.bind', { action: 'bindSecret', connectionId: 'provider', machineId: 'machine',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine' }],
    ['providers.models.manual.remove', { action: 'manualRemove', connectionId: 'provider', modelId: 'model', expectedConnectionRevision: 3 }],
    ['providers.models.experimental.confirm', { action: 'confirmExperimental', connectionId: 'provider',
      modelId: 'model', agentTargetKey: 'agent:happier.agent.codex/codex', expectedConnectionRevision: 3, compatibilityFingerprint: 'compatibility:v1:review' }],
    ['providers.models.visibility.set', { action: 'setVisibility', ref: { scope: 'agent', agentTargetKey: 'agent:codex',
      providerConnectionId: 'provider', modelId: 'model' }, hidden: true }],
    ['providers.models.visibility.reset', { action: 'resetVisibility', scope: { kind: 'connection', connectionId: 'provider' } }],
    ['providers.models.manual.add', { action: 'manualAdd', connectionId: 'provider', expectedConnectionRevision: 3, models: [{ id: 'model', name: 'Model' }] }],
    ['providers.models.visibility.bulk', { action: 'bulkVisibility', changes: [{ ref: { scope: 'allAgents',
      providerConnectionId: 'provider', modelId: 'model' }, hidden: true }] }],
  ] as const)('retains %s operands from creation until the effect', async (actionId, rawInput) => {
    const input = getActionSpec(actionId).inputSchema.parse(rawInput);
    let stored: ApprovalRequestV2 | null = null;
    const effects: unknown[] = [];
    const catalogWrites: unknown[] = [];
    const defaultWrites: unknown[] = [];
    let metadataReads = 0;
    const provider = createProviderActionExecuteV1({ assertCurrent() {},
      account: createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
        readCatalog: async () => ({ status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 }),
        readDefinitions: async () => [], writeCatalog: async input => { catalogWrites.push(input); return { status: 'updated' }; },
      }),
      rpc: async () => ({ status: 'error', error: { code: 'provider_endpoint_unavailable', retryable: true } }),
      setDefault: async input => { defaultWrites.push(input); return { status: 'applied' }; },
    });
    const secret = createPersonalSavedSecretActionExecuteV1({
      list: async () => [], create: async () => { throw new Error('No secret creation'); },
      update: async () => { throw new Error('No secret update'); },
      delete: async args => {
        effects.push(args);
        // A concurrent resource change must not refresh the approved CAS operand.
        if (args.expectedUpdatedAt === 8) throw Object.assign(new Error('currentness_conflict'), { code: 'currentness_conflict' });
      },
    });
    const executor = createActionExecutor({
      // Only the Artifact store and native effect are replaced. Admission,
      // preparation, decision, transition and replay use their real owners.
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'context-approval' };
      },
      approvalsGet: async () => structuredClone(stored),
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing stored request');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = structuredClone(next);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      personalSavedSecretActionExecute: args => secret(args.actionId, args.input),
      providerActionExecute: async (request, context) => {
        if (request.actionId === 'providers.connections.describe') {
          metadataReads++;
          return provider(request, context);
        }
        effects.push(request.input);
        return provider(request, context);
      },
    });
    const context = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', machineId: 'machine', actionRequestId: 'context-request',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }),
    } as const;
    expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created' } });
    const request = ApprovalRequestV2Schema.parse(stored);
    expect(request.actionArgs).toEqual(input);
    if ('savedSecretId' in rawInput) {
      expect(request.preview).toMatchObject({ actionArgs: { savedSecretId: rawInput.savedSecretId } });
    }
    if ('expectedUpdatedAt' in rawInput) {
      expect(request.preview).toMatchObject({ actionArgs: { secretId: rawInput.secretId,
        expectedUpdatedAt: rawInput.expectedUpdatedAt } });
    }
    const presentation = describeApprovalActionFields(request);
    if ('selection' in rawInput) {
      expect(request.preview).toMatchObject({ actionArgs: { selection: rawInput.selection } });
      expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'selection', value: JSON.stringify(rawInput.selection) }));
    }
    if ('manualModels' in rawInput) {
      expect(request.preview).toMatchObject({ actionArgs: { manualModels: rawInput.manualModels } });
      expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'manualModels', value: JSON.stringify(rawInput.manualModels) }));
    }
    if ('manualModels' in rawInput || 'selection' in rawInput && rawInput.selection !== null) {
      expect(JSON.stringify(projectApprovalRequestForPublicRead(request))).not.toContain('reviewed-model');
    }
    if (actionId !== 'secrets.delete') {
      expect(JSON.stringify(projectApprovalRequestForPublicRead(request))).not.toContain('saved-secret');
    }
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission.status, JSON.stringify(admission)).toBe('available');
    expect(effects).toEqual([]);
    expect(catalogWrites).toEqual([]);
    expect(defaultWrites).toEqual([]);
    const decided = await executor.execute('approval.request.decide', { artifactId: 'context-approval', decision: 'approve' },
      { ...context, surface: 'ui', authority: 'present_user' });
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true,
      result: { execution: { executedAtMs: expect.any(Number) } } });
    if (actionId === 'secrets.delete') {
      expect(decided).toMatchObject({ result: rawInput.expectedUpdatedAt === 8
        ? { status: 'failed', execution: { ok: false, errorCode: 'currentness_conflict' } }
        : { status: 'executed', execution: { ok: true } } });
    }
    if ('selection' in rawInput) {
      expect(decided).toMatchObject({ result: { status: 'executed', execution: { ok: true } } });
      expect(defaultWrites).toEqual([input]);
    }
    if ('manualModels' in rawInput) {
      expect(decided).toMatchObject({ result: { status: 'executed', execution: { ok: true } } });
      expect(catalogWrites).toMatchObject([{ expectedRevision: 1, catalog: {
        manualModelsByConnectionId: { provider: rawInput.manualModels },
      } }]);
    }
    expect(effects).toEqual([input]);
    expect(metadataReads).toBe(actionId === 'providers.connections.create_contribution'
      || actionId === 'providers.connections.secrets.bind' ? 1 : 0);
  });
});
