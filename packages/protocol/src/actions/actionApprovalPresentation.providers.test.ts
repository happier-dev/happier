import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition, settleApprovalRequestReplayInputs } from '../approvals/approvalRequestTransition.js';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { createProviderActionExecuteV1 } from '../providers/executeProviderActionV1.js';
import { createAccountProviderActionExecuteV1 } from '../providers/connections/accountProviderActionV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '../providers/connections/connectionRowsV1.js';

async function createApproval(actionId: string, rawInput: unknown): Promise<ApprovalRequestV2> {
  let stored: ApprovalRequestV2 | null = null;
  const provider = createProviderActionExecuteV1({ assertCurrent() {},
    account: createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
      readCatalog: async () => ({ status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 }),
      readDefinitions: async () => [], writeCatalog: async () => ({ status: 'updated' }),
    }),
    rpc: async () => ({ status: 'error', error: { code: 'provider_endpoint_unavailable', retryable: true } }),
    setDefault: async () => ({ status: 'applied' }),
  });
  const executor = createActionExecutor({
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
      return { artifactId: 'presentation-approval' };
    },
    approvalsGet: async () => structuredClone(stored),
    isApprovalExecutionOriginCurrent: async () => true,
    providerActionExecute: async (request, context) => provider(request, context),
  });
  const context = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
    serverId: 'home', machineId: 'machine', actionRequestId: 'presentation-request',
    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }),
  } as const;
  const input = getActionSpec(actionId as never).inputSchema.parse(rawInput);
  expect(await executor.execute(actionId as never, input, context)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  return ApprovalRequestV2Schema.parse(stored);
}

const template = { v: 1, name: 'Custom', endpointTemplates: [{ id: 'openai', protocol: 'openai',
  baseUrl: 'https://example.com/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
    statefulResponses: 'unknown', reasoningControls: 'unknown' } }], catalog: { source: 'manual', manualModelPolicy: 'allowed' } };
const codex = 'agent:happier.agent.codex/codex';
const poolTarget = { kind: 'group', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'qa-c41-pool-d4f812' } as const;
const gateway = (savedSecretId: string | null) => ({ action: 'createContribution', connectionId: 'provider', contributionKey: 'example.provider/source',
  displayName: 'TEST C41 Gateway', savedSecretId, enable: false,
  deployment: { kind: 'managedLocal', purposeBindingDefaults: { openai_upstream: poolTarget } } });

/** What a person reads in the main review: every row the presenter does not move to Technical details. */
async function readReview(actionId: string, input: unknown) {
  const rows = describeApprovalActionFields(await createApproval(actionId, input)).rows;
  return { rows, readable: rows.filter(row => row.kind === 'value' && !row.technical) };
}

describe('an approval review reads values by meaning, from the real approval an Action creates', () => {
  it.each([
    { target: undefined, reference: { kind: 'providerConnection', id: 'saved-provider' } },
    { target: { kind: 'account', account: { service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'personal-muse' } },
      reference: { kind: 'connectedAccount', id: 'personal-muse', service: 'happier.agent.muse/muse-account' } },
    { target: poolTarget, reference: { kind: 'connectedAccount', id: poolTarget.groupId, service: 'happier.agent.codex/openai-codex', pool: true } },
  ])('reviews an experimental model source as its declared reference kind ($reference.kind)', async ({ target, reference }) => {
    const connectionId = target ? 'connected-source:catalog-identity' : 'saved-provider';
    const request = await createApproval('providers.models.experimental.confirm', {
      action: 'confirmExperimental', connectionId, connectedAccountTarget: target,
      catalogSourceKey: 's'.repeat(43), expectedConnectionRevision: 0, agentTargetKey: codex,
      modelId: 'experimental-model', compatibilityFingerprint: 'compatibility:v1:experimental',
    });
    // Exercise the real settlement writer projection, then the serialized history reader.
    const declined = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify({
      ...settleApprovalRequestReplayInputs(request), status: 'rejected', updatedAtMs: request.updatedAtMs + 1,
      decision: { kind: 'reject', decidedAtMs: request.updatedAtMs + 1 },
    })));
    expect(decideApprovalRequestTransition(request, declined)).toEqual({ ok: true, changed: true });
    for (const review of [request, declined]) {
      const { rows } = describeApprovalActionFields(review);
      expect(rows).toContainEqual(expect.objectContaining({ path: 'connectionId', reference: expect.objectContaining(reference) }));
      if (target) {
        expect(rows).toContainEqual(expect.objectContaining({ path: 'connectedAccountTarget', reference: expect.objectContaining(reference) }));
        expect(rows.filter(row => row.kind === 'value' && row.reference?.kind === 'providerConnection')).toEqual([]);
      }
    }
  });

  it('reads an Add Provider gateway without stored ids, empty operands or raw binding members', async () => {
    const { rows, readable } = await readReview('providers.connections.create_contribution', gateway(null));
    // An operand that carries nothing is not a reading; it stays an exact literal in Details.
    expect(readable.map(row => row.path)).not.toContain('savedSecretId');
    expect(rows).toContainEqual(expect.objectContaining({ path: 'savedSecretId', value: 'null', technical: true }));
    // The Deployment choice reads by its declared, translatable label, not by its stored id.
    expect(readable).toContainEqual(expect.objectContaining({ path: 'deployment.kind',
      selectedOptions: [expect.objectContaining({ labelKey: 'actionPresentation.options.managedLocal' })] }));
    // A pool reads as the pool, through the Connected Account reference; its plugin/local/group ids are not rows.
    const slots = readable.find(row => row.kind === 'value' && row.path === 'deployment.purposeBindingDefaults');
    expect(slots?.kind === 'value' && slots.entries?.filter(entry => entry.reference)).toEqual([expect.objectContaining({
      reference: expect.objectContaining({ kind: 'connectedAccount', id: 'qa-c41-pool-d4f812', service: 'happier.agent.codex/openai-codex', pool: true }) })]);
    expect(slots?.kind === 'value' && slots.entries?.map(entry => entry.label)).not.toEqual(expect.arrayContaining(['Plugin id']));
    expect(slots?.kind === 'value' && slots.entries?.map(entry => entry.label)).not.toEqual(expect.arrayContaining(['Group id']));
  });

  it('leaves the connection row out of a creation that already names it, keeping its id in Details', async () => {
    const { rows, readable } = await readReview('providers.connections.create_contribution', gateway(null));
    expect(readable).toContainEqual(expect.objectContaining({ path: 'displayName', value: 'TEST C41 Gateway' }));
    expect(readable.map(row => row.path)).not.toContain('connectionId');
    expect(rows).toContainEqual(expect.objectContaining({ path: 'connectionId', value: 'provider', technical: true,
      reference: expect.objectContaining({ kind: 'providerConnection', displayName: 'TEST C41 Gateway' }) }));
  });

  it('keeps the connection row of a rename, where the saved name and the new name differ', async () => {
    const { readable } = await readReview('providers.connections.update', { action: 'update', connectionId: 'provider',
      expectedRevision: 3, displayName: 'Renamed gateway' });
    expect(readable.map(row => row.path)).toEqual(expect.arrayContaining(['connectionId', 'displayName']));
  });

  it('reads each subscription slot by its Provider-declared purpose, not by a humanized id', async () => {
    const { readable } = await readReview('providers.connections.create_contribution', gateway(null));
    const slots = readable.find(row => row.kind === 'value' && row.path === 'deployment.purposeBindingDefaults');
    expect(slots?.kind === 'value' && slots.entries).toEqual([expect.objectContaining({
      label: 'Openai upstream',
      reference: { kind: 'connectedAccount', id: 'qa-c41-pool-d4f812', service: 'happier.agent.codex/openai-codex', pool: true,
        purpose: { id: 'openai_upstream', contributionKey: 'example.provider/source', connectionId: 'provider' } } })]);
  });

  it('names a connection that does not exist yet by what it is created with, never as unavailable', async () => {
    const custom = await readReview('providers.connections.create_custom', { action: 'createCustom', connectionId: 'provider',
      savedSecretId: null, enable: false, template });
    expect(custom.readable).toContainEqual(expect.objectContaining({ path: 'connectionId',
      reference: expect.objectContaining({ kind: 'providerConnection', displayName: 'Custom' }) }));
  });

  it('reads a Saved Secret operand as a reference to the secret, never its id as a value', async () => {
    const { readable } = await readReview('providers.connections.create_contribution', gateway('saved-secret'));
    expect(readable).toContainEqual(expect.objectContaining({ path: 'savedSecretId', reference: { kind: 'savedSecret', id: 'saved-secret' } }));
  });

  it('reads the Saved Secret a delete names by the reference the catalog keys it with', async () => {
    const { readable } = await readReview('secrets.delete', { secretId: 'resource-1', expectedUpdatedAt: 7 });
    expect(readable).toContainEqual(expect.objectContaining({ path: 'secretId',
      reference: { kind: 'savedSecret', id: 'happier:shared-secret:v1:resource-1' } }));
    // The concurrency check is no reading of what is deleted; it stays in Details.
    expect(readable.map(row => row.path)).not.toContain('expectedUpdatedAt');
  });

  it('reads a chosen default model as the model, and a cleared default or empty credential as no reading', async () => {
    const chosen = await readReview('providers.defaults.set', { agentTargetKey: codex, selection: { v: 1,
      ref: { agentTargetKey: codex, providerConnectionId: 'provider', modelId: 'reviewed-model' }, updatedAt: 1 } });
    expect(chosen.readable).toContainEqual(expect.objectContaining({ path: 'selection', reference: expect.objectContaining({
      kind: 'providerModel', id: 'reviewed-model', connectionId: 'provider' }) }));
    expect(chosen.readable.find(row => row.kind === 'value' && row.path === 'selection')).not.toHaveProperty('entries');
    const cleared = await readReview('providers.defaults.set', { agentTargetKey: codex, selection: null });
    expect(cleared.readable.map(row => row.path)).not.toContain('selection');
    const custom = await readReview('providers.connections.create_custom', { action: 'createCustom', connectionId: 'provider',
      savedSecretId: null, enable: false, template });
    expect(custom.readable.map(row => row.path)).not.toEqual(expect.arrayContaining(['savedSecretId']));
    expect(custom.readable.map(row => row.path)).not.toEqual(expect.arrayContaining(['template.credential']));
  });
});
