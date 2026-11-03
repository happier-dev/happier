import { describe, expect, it } from 'vitest';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { createProviderActionExecuteV1 } from '../providers/executeProviderActionV1.js';
import { createProviderErrorV1 } from '../providers/errors.js';
import { applyProviderDefaultModelSelectionV1, SessionModelSelectionV1Schema } from '../providers/selection/v1.js';
import { createAccountProviderActionExecuteV1 } from '../providers/connections/accountProviderActionV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogV1 } from '../providers/connections/connectionRowsV1.js';
import { createActionExecutor } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { ProviderConnectionV1Schema } from '../providers/connections/v1.js';
import { ProviderContributionV1Schema } from '../providers/contributions/v1.js';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '../../../plugins/cliproxyapi/src/provider/contribution.js';
import { DaemonProviderConnectionMutationResponseV1Schema } from '../rpc/providers.js';

const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;

describe('Provider Settings Actions', () => {
  it.each([
    ['MACHINE_RPC_TIMEOUT', 'agent_timeout'],
    ['RPC_METHOD_NOT_AVAILABLE', 'agent_unavailable'],
  ] as const)('preserves a returned daemon %s through Provider Action dispatch', async (errorCode, providerCode) => {
    const executor = createActionExecutor({ providerActionExecute: createProviderActionExecuteV1({
      assertCurrent() {}, setDefault: async () => ({ status: 'applied' }),
      // The transport returns a daemon error inside a successful Home ACK.
      rpc: async () => ({ error: 'Daemon request failed', errorCode }),
    }) });
    await expect(executor.execute('providers.models.projection', {
      machineId: 'machine', agentTargetKey: 'agent:happier.agent.codex/codex',
    }, context)).resolves.toMatchObject({ ok: false, errorCode: providerCode,
      details: { code: providerCode, machineId: 'machine' } });
  });

  it('preserves the typed probe refusal through real Provider dispatch and approval decision observation', async () => {
    let stored: ApprovalRequestV2 | null = null;
    const error = createProviderErrorV1('provider_endpoint_unavailable', { connectionId: 'gateway', machineId: 'hub' });
    const executor = createActionExecutor({
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'probe-approval' };
      },
      approvalsGet: async () => stored && structuredClone(stored),
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = structuredClone(next);
        return { ok: true };
      },
      // Only Artifact persistence and daemon RPC are replaced; Provider result
      // parsing, approval transitions and observation projection remain real.
      providerActionExecute: createProviderActionExecuteV1({ assertCurrent() {},
        rpc: async () => ({ status: 'error', error }),
        setDefault: async () => ({ status: 'applied' }),
      }),
    });
    const invocation = { ...context, serverId: 'test-home', actionRequestId: 'probe-request',
      machineId: 'hub' };
    expect(await executor.execute('providers.probe', { connectionId: 'gateway', machineId: 'hub' }, invocation))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'probe-approval', decision: 'approve' }, invocation))
      .toMatchObject({ ok: true, result: { execution: { ok: true, result: { status: 'error', error } } } });
  });
  it.each(['updated', 'refused', 'conflict', 'terminal_lost'] as const)(
    'settles a deferred Account gateway slot approval with %s disposition without daemon replay', async disposition => {
      const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_approval_gateway', role: 'named',
        source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
        displayName: 'Gateway', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
        revision: 1, createdAt: 1, updatedAt: 1 });
      let catalog: ProviderConnectionsCatalogV1 = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] };
      let stored: ApprovalRequestV2 | null = null;
      let catalogRevision = 1;
      const statuses: string[] = [];
      const target = { kind: 'account' as const, account: {
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'unavailable-account' } };
      const input = { action: 'update', connectionId: connection.id, expectedRevision: 1,
        deployment: { kind: 'managedLocal', purposeBindingDefaults: {
          [disposition === 'refused' ? 'undeclared-slot' : 'anthropic-upstream']: target,
        } } };
      // Account-row and Artifact persistence are the boundaries. Approval policy,
      // lifecycle transitions, Provider dispatch and Account semantics stay real.
      const account = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
        readCatalog: async () => ({ status: 'ready', revision: catalogRevision, catalog }),
        readDefinitions: async () => [{ contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
          definition: ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION), provenance: 'first_party' }],
        writeCatalog: async write => {
          expect(write.expectedRevision).toBe(catalogRevision);
          if (disposition === 'conflict') return { status: 'conflict' };
          catalog = write.catalog;
          catalogRevision++;
          return { status: 'updated' };
        },
      });
      const executor = createActionExecutor({
        isApprovalExecutionOriginCurrent: async () => true,
        approvalsCreate: async ({ request }) => {
          stored = ApprovalRequestV2Schema.parse(request);
          statuses.push(stored.status);
          return { artifactId: 'approval-gateway-slot' };
        },
        approvalsGet: async () => stored && structuredClone(stored),
        approvalsUpdate: async ({ request }) => {
          if (!stored) throw new Error('Missing approval');
          const next = ApprovalRequestV2Schema.parse(request);
          const transition = decideApprovalRequestTransition(stored, next);
          if (!transition.ok) return transition;
          if (disposition === 'terminal_lost' && next.status === 'executed') {
            throw Object.assign(new Error('Lost terminal receipt'), { code: 'ECONNRESET' });
          }
          stored = structuredClone(next);
          statuses.push(next.status);
          return { ok: true };
        },
        providerActionExecute: createProviderActionExecuteV1({ assertCurrent() {}, account,
          rpc: async () => { throw new Error('Account slot edits must not invoke a daemon'); },
          setDefault: async () => ({ status: 'applied' }),
        }),
      });
      const invocation = { ...context, serverId: 'test-home', actionRequestId: 'slot-request' };
      expect(await executor.execute('providers.connections.update', input, invocation))
        .toEqual(expect.objectContaining({ ok: true, result: expect.objectContaining({ kind: 'approval_request_created' }) }));
      const decided = await executor.execute('approval.request.decide', {
        artifactId: 'approval-gateway-slot', decision: 'approve',
      }, invocation);
      const readStored = (): ApprovalRequestV2 => {
        if (!stored) throw new Error('Missing persisted approval');
        return stored;
      };
      if (disposition === 'terminal_lost') {
        expect(decided).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
        expect(readStored()).toMatchObject({ status: 'executing' });
        expect(readStored().execution).toBeUndefined();
        expect(statuses).toEqual(['open', 'approved', 'executing']);
      } else {
        const failed = disposition === 'refused' || disposition === 'conflict';
        expect(decided).toMatchObject({ ok: true, result: { status: failed ? 'failed' : 'executed' } });
        expect(readStored().execution).toMatchObject(failed
          ? { ok: false, errorCode: disposition === 'refused' ? 'provider_connection_invalid' : 'provider_catalog_conflict' }
          : { ok: true });
        expect(statuses).toEqual(['open', 'approved', 'executing', failed ? 'failed' : 'executed']);
      }
      expect(catalog.connections[0]?.purposeBindingDefaults).toEqual(
        disposition === 'updated' || disposition === 'terminal_lost' ? { 'anthropic-upstream': target } : undefined,
      );
      if (disposition === 'terminal_lost') {
        expect(await executor.execute('approval.request.decide', {
          artifactId: 'approval-gateway-slot', decision: 'approve',
        }, invocation)).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
        expect(catalogRevision).toBe(2);
      }
    },
  );
  it('executes the same Account operation through either targeted daemon without machine-specific Provider state', async () => {
    const { createActionExecutor } = await import('./actionExecutor.js');
    // Captured Account-row transport is the boundary; both dispatch and the
    // Account semantic producer remain real and share the same Account catalog.
    const account = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 1,
      readCatalog: async () => ({ status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 }),
      writeCatalog: async () => { throw new Error('description must not write'); }, readDefinitions: async () => [],
    });
    const executor = createActionExecutor({ providerActionExecute: createProviderActionExecuteV1({
      assertCurrent() {}, account,
      rpc: async () => { throw new Error('Account description must not read machine Provider state'); },
      setDefault: async () => ({ status: 'applied' }),
    }) });
    for (const machineId of ['daemon-a', 'daemon-b']) {
      await expect(executor.execute('providers.connections.describe', {}, {
        surface: 'agent', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId },
      })).resolves.toMatchObject({ ok: true, result: { connections: [] } });
    }
  });
  it('places Account catalog actions independently of optional machine execution', async () => {
    const { getActionSpec, resolveActionExecutionPlacementForInput } = await import('./actionSpecs.js');
    const cases = [
      ['providers.connections.describe', {}, 'account'],
      ['providers.connections.describe', { machineId: 'machine' }, 'machine'],
      ['providers.connections.update', { action: 'update', connectionId: 'pc_gateway', expectedRevision: 1,
        gatewayPlacement: { kind: 'machine', machineId: 'hub' } }, 'account'],
      ['providers.connections.update', { action: 'update', machineId: 'machine', connectionId: 'pc_gateway', expectedRevision: 1,
        claudeHelperModels: { fast: 'model' } }, 'account'],
      ['providers.connections.enabled.set', { action: 'setEnabled', connectionId: 'pc_gateway', enabled: true, scope: 'account' }, 'account'],
      ['providers.connections.enabled.set', { action: 'setEnabled', machineId: 'machine', connectionId: 'pc_gateway', enabled: true, scope: 'machine' }, 'machine'],
      ['providers.models.list', { connectionId: 'pc_gateway' }, 'account'],
      ['providers.models.manual.remove', { action: 'manualRemove', connectionId: 'pc_gateway', modelId: 'model', expectedConnectionRevision: 1 }, 'account'],
      ['providers.models.source_visibility.set', { action: 'setConnectionVisibility', connectionId: 'pc_gateway', shown: true }, 'account'],
      ['providers.connections.start_local', { action: 'startLocal', machineId: 'machine', contributionKey: 'example.gateway/gateway' }, 'machine'],
    ] as const;
    const admittedCases = cases.map(([id, input, expected]) => {
      const spec = getActionSpec(id);
      return { id, spec, input: spec.inputSchema.parse(input), expected };
    });
    for (const { id, spec, input, expected } of admittedCases) {
      expect(spec.surfaces.agent, id).toBe(true);
      expect(spec.surfaces.cli, id).toBe(true);
      expect(resolveActionExecutionPlacementForInput(spec, input), id).toBe(expected);
    }
    expect(getActionSpec('providers.connections.update').executionPlacement).toBe('account');
    expect(getActionSpec('providers.models.list').executionPlacement).toBe('account');
  }, 60_000);

  it('admits the exact scoped credential operation and preserves a daemon unknown-outcome refusal', async () => {
    const actionId = 'providers.connections.secrets.bind';
    expect(ActionIdSchema.safeParse(actionId).success).toBe(true);
    const { getActionSpec } = await import('./actionSpecs.js');
    const { createActionExecutor } = await import('./actionExecutor.js');
    const spec = getActionSpec(actionId);
    expect(spec.inputSchema.safeParse({ action: 'bindSecret', machineId: 'machine', connectionId: 'connection',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ action: 'delete', machineId: 'machine', connectionId: 'connection' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ action: 'bindSecret', machineId: 'machine', connectionId: 'connection',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine', accountId: 'foreign' }).success).toBe(false);
    const requests: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
      approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    const executor = createActionExecutor({
      isActionApprovalRequired: (id, ctx, input) => isApprovalRequiredByActionsSettings(id, settings, ctx, undefined, undefined, input),
      providerActionExecute: createProviderActionExecuteV1({ assertCurrent: () => {}, setDefault: async () => ({ status: 'applied' }),
        rpc: async ({ request }) => {
          // Only the daemon RPC transport is replaced; parsing, dispatch and outcome handling remain real.
          requests.push(request);
          throw createProviderErrorV1('provider_rpc_mutation_outcome_unknown');
        },
      }),
    });
    const input = { action: 'bindSecret', machineId: 'machine', connectionId: 'connection',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine' };
    await expect(executor.execute(actionId, input, { ...context, actionsSettings: settings })).resolves.toMatchObject({
      ok: false, errorCode: 'provider_rpc_mutation_outcome_unknown',
    });
    expect(requests).toEqual([{ actionId, input }]);
  }, 60_000);

  it('asks before scoped grants, deletion, probe, process and experimental compatibility, but reads remain safe', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    for (const id of ['providers.connections.enabled.set', 'providers.connections.delete', 'providers.probe',
      'providers.connections.start_local', 'providers.models.load', 'providers.models.experimental.confirm'] as const satisfies readonly ActionId[]) {
      const spec = getActionSpec(id);
      expect(resolveActionApprovalRouting({ actionId: id, spec,
        context: { surface: 'agent', authority: 'account_automation' } })).toMatchObject({ required: true });
    }
    expect(getActionSpec('providers.connections.describe').safety).toBe('safe');
    expect(getActionSpec('providers.models.projection').inputSchema.safeParse({ machineId: 'machine',
      agentTargetKey: 'agent:codex', forceRefresh: true }).success).toBe(false);
    expect(getActionSpec('providers.models.refresh').safety).toBe('danger');
  }, 60_000);

  it('keeps default intent for an unavailable connection and refuses a different Agent target', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const schema = getActionSpec('providers.defaults.set').inputSchema;
    const selection = SessionModelSelectionV1Schema.parse({ v: 1, ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'unavailable', modelId: 'model' }, updatedAt: 1 });
    expect(schema.safeParse({ agentTargetKey: 'agent:codex', selection }).success).toBe(true);
    expect(schema.safeParse({ agentTargetKey: 'agent:claude', selection }).success).toBe(false);
    expect(schema.safeParse({ agentTargetKey: 'agent:codex', selection: null }).success).toBe(true);
    const other = SessionModelSelectionV1Schema.parse({ ...selection, ref: { ...selection.ref, agentTargetKey: 'agent:claude' } });
    const raw = { unknownPreference: { retained: true }, providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:claude': other } };
    let stored: Record<string, unknown> = raw;
    const { createActionExecutor } = await import('./actionExecutor.js');
    const executor = createActionExecutor({
      providerActionExecute: createProviderActionExecuteV1({ assertCurrent: () => {}, rpc: async () => { throw new Error('Default intent must not consult a daemon'); },
        setDefault: async input => { stored = applyProviderDefaultModelSelectionV1(stored, input); return { status: 'applied' }; },
      }),
    });
    expect(await executor.execute('providers.defaults.set', { agentTargetKey: 'agent:codex', selection }, context)).toEqual({ ok: true, result: { status: 'updated' } });
    expect(stored).toEqual({ ...raw, providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:claude': other, 'agent:codex': selection } });
    expect(await executor.execute('providers.defaults.set', { agentTargetKey: 'agent:codex', selection: null }, context)).toEqual({ ok: true, result: { status: 'updated' } });
    expect(stored).toEqual(raw);
    expect(() => applyProviderDefaultModelSelectionV1({ providerDefaultModelSelectionsByAgentTargetKeyV1: null }, { agentTargetKey: 'agent:codex', selection })).toThrow();
  }, 60_000);

  it('keeps a dispatched mutation ACK after retirement, but refuses a retired read and malformed mutation ACK', async () => {
    const { createActionExecutor } = await import('./actionExecutor.js');
    let current = true;
    let reply: unknown = { status: 'success', action: 'startLocal', contributionKey: 'example.gateway/gateway', phase: 'running' };
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'providers.connections.start_local': ['ui'] } });
    const executor = createActionExecutor({
      isActionApprovalRequired: (id, ctx, input) => isApprovalRequiredByActionsSettings(id, settings, ctx, undefined, undefined, input),
      providerActionExecute: createProviderActionExecuteV1({
        assertCurrent: () => { if (!current) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' }); },
        rpc: async () => { current = false; return reply; }, setDefault: async () => ({ status: 'applied' }),
      }),
    });
    const waivedContext = { ...context, actionsSettings: settings };
    const input = { action: 'startLocal', machineId: 'machine', contributionKey: 'example.gateway/gateway' };
    expect(await executor.execute('providers.connections.start_local', input, waivedContext))
      .toEqual({ ok: true, result: reply });
    current = true;
    reply = { unrecognized: true };
    expect(await executor.execute('providers.connections.start_local', input, waivedContext))
      .toMatchObject({ ok: false, errorCode: 'provider_rpc_mutation_outcome_unknown' });
    current = true;
    reply = { status: 'error', error: createProviderErrorV1('agent_unavailable') };
    const read = await executor.execute('providers.connections.describe', { machineId: 'machine' }, context);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errorCode).not.toBe('provider_rpc_mutation_outcome_unknown');
  }, 60_000);
});
