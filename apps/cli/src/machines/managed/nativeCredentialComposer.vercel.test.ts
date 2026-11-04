import axios from 'axios';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import type { JsonValue } from '@happier-dev/protocol';
import { SessionTeamCredentialBindingIntentV1Schema } from '@happier-dev/protocol/teams';
import { ManagedControllerCredentialDeliveryReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PLUGIN, PLUGIN_MANIFEST } from '../../../../../packages/plugins/machine-vercel/src/index';
import { reference } from '../../../../../packages/plugins/machine-vercel/src/machine/schemas';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { createPluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { materializeSessionTeamCredentialNativeBinding } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import { createManagedMachineAcquisitionDriver } from './acquire';
import { composeManagedNativeCredentials } from './nativeCredentialComposer';
import { createNativeCredentialComposerFixture } from './nativeCredentialComposer.testkit';
import { createDaemonManagedMachinePolicyRuntime } from '@/daemon/startup/managedMachinePolicyRuntime';
import type { createManagedNativeInvocation } from './reconcile';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const scope = { teamId: 'team_composed', projectId: 'prj_composed' };
const resource = { ...scope, name: 'happier-composed', managedId: 'managed', createdAt: 1000 };
const account = { service: { pluginId: PLUGIN_MANIFEST.id, localId: 'vercel-account' }, accountId: 'cloud-account' };
type Policy = { mode?: 'allow-all'; allow?: Record<string, { match: JsonValue; transform: { headers: Record<string, string> }[] }[]> };
const redacted = (policy: Policy) => policy.mode === 'allow-all' ? { mode: 'allow-all' } : {
  mode: 'custom', allowedDomains: Object.keys(policy.allow ?? {}), injectionRules: Object.entries(policy.allow ?? {})
    .flatMap(([domain, rules]) => rules.map(rule => ({ domain, match: rule.match,
      headerNames: Object.keys(rule.transform[0]!.headers) }))),
};

async function fixture() {
  const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
  const authored = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN });
  const handlerEvents: unknown[] = [];
  const invocationSnapshots: string[] = [];
  const handlers = new Map(manifest.contributes.actions.map(action => {
    const handler = authored.registration('actions', action.id);
    if (!handler) throw new Error('Expected authored Vercel Action');
    const observed: typeof handler = async (input, context) => {
      handlerEvents.push({ action: action.id, phase: 'started' });
      const result = await handler(input, context);
      handlerEvents.push({ action: action.id, phase: 'completed', result });
      if (action.id === 'native-credential-apply') invocationSnapshots.push(JSON.stringify({ input,
        context: { ...context, services: { machineProvisioners: context.services.machineProvisioners } }, result }));
      return result;
    };
    Object.defineProperties(observed, Object.getOwnPropertyDescriptors(handler));
    return [action.id, observed] as const;
  }));
  const calls: HttpRequest[] = [];
  let live: unknown = { mode: 'allow-all' }, saved: unknown = { mode: 'allow-all' };
  let vendorUnavailable = false;
  let holdRelease = false;
  let releaseStarted!: () => void, finishRelease!: () => void;
  const releaseReached = new Promise<void>(resolve => { releaseStarted = resolve; });
  const releaseAllowed = new Promise<void>(resolve => { finishRelease = resolve; });
  const session = () => ({ id: 'sbx_composed', sourceSandboxName: resource.name, projectId: scope.projectId,
    createdAt: 1000, networkPolicy: live });
  const sandbox = () => ({ name: resource.name, createdAt: 1000, currentSessionId: 'sbx_composed',
    persistent: true, status: 'running', tags: { 'happier-managed-id': resource.managedId }, networkPolicy: saved });
  const http = createStablePluginHttpHost({ adapter: {
    async openWebSocket() { throw new Error('Unexpected WebSocket'); },
    async request(request): Promise<HttpResponse> {
      calls.push(request);
      if (vendorUnavailable) return { status: 503, finalUrl: request.url, headers: {}, body: new Uint8Array() };
      const url = new URL(request.url);
      let body: unknown;
      if (url.pathname.startsWith('/v2/teams/')) body = { id: scope.teamId, billing: { plan: 'hobby' } };
      else if (request.method === 'GET') body = { sandbox: sandbox(), session: session() };
      else {
        // JSON from the genuine external HTTP boundary, not an internal helper.
        const policy = JSON.parse(new TextDecoder().decode(request.body)) as Policy & { networkPolicy?: Policy };
        if (request.method === 'POST') { live = redacted(policy); body = { session: session() }; }
        else {
          if (holdRelease) { releaseStarted(); await releaseAllowed; }
          saved = redacted(policy.networkPolicy!); body = { sandbox: sandbox() };
        }
      }
      return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)) };
    },
  } });
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential mutation'); };
  const owner = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
    selectTarget: unavailable,
    resolveTarget: async target => target.kind === 'account' ? { displayName: 'Cloud fixture', account: target.account } : null,
    resolveCredentialRevision: async () => null,
    resolveCredentialConfigurationRevision: async () => null,
    // The external cloud account materializer is the credential boundary.
    materializeAccount: async ({ request }) => request.kind === 'environment'
      ? { kind: 'environment', env: { VERCEL_TEAM_ID: scope.teamId, VERCEL_PROJECT_ID: scope.projectId } }
      : { kind: 'httpHeaders', headers: { authorization: 'Bearer composed-cloud-token' } },
    projectTargetAccounts: unavailable, assertTargetAccountMaterializable: async () => {},
  });
  const f = await createNativeCredentialComposerFixture({
    machine: { resource: reference(resource), launch: { provider: reference(resource).contributionRef, schemaVersion: 1,
      name: resource.name, choices: {}, credentials: [{ purpose: { consumer: { pluginId: manifest.id, localId: 'acquire' },
        purpose: 'cloud-api' }, account, configurationRevision: null }] } },
    purposeBindingOwner: owner,
    nativeOptions: { fixtureManifest: manifest, actionHandlers: handlers, credentialOwner: owner,
      credentialPurposes: [{ purpose: 'cloud-api', service: account.service }], hostServiceAdapters: { http },
      createHostServiceBinding: (occurrence, id) => createPluginInvocationServiceBinding(occurrence, id),
    },
  });
  return { ...f, handlerEvents, invocationSnapshots, vendorCalls: calls, readVendorPolicies: () => ({ live, saved }),
    failVendorReads() { vendorUnavailable = true; },
    holdRelease() { holdRelease = true; }, releaseReached, finishRelease,
    async cleanup() { finishRelease(); await f.cleanup(); await authored.dispose(); } };
}

describe('source-composed authored Vercel native credential delivery', () => {
  it.each(['guest-revoked', 'guest-re-enrolled', 'controller-reinstalled'] as const)(
    'removes retained injection rules once on reconnect without deleting Sessions: %s', async drift => {
    // Compile-contract assertion belongs to the shared p-closeout gate, not a runtime test.
    expectTypeOf<Parameters<ReturnType<typeof createManagedNativeInvocation<true>>['invoke']>[0]>()
      .toEqualTypeOf<'nativeCredentialApply'>();
    const f = await fixture();
    const driver = createManagedMachineAcquisitionDriver({ ...f.driverInput,
      prepareTeamCredentialNativeSource: f.input.prepareSource });
    const failures: unknown[] = [];
    const runtime = createDaemonManagedMachinePolicyRuntime({
      readCensus: async () => ({ machines: [f.input.machine], targets: [] }),
      executePolicy: async () => { throw new Error('No compute policy requested'); },
      reconcileNativeCredentials: (machine, signal) => driver.reconcileNativeCredentials(machine, { ...f.options, signal }),
      onUnavailable: error => { failures.push(error); },
    });
    try {
      expect(await driver.execute('machines.managed.credentials.install', f.input.request, f.options))
        .toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      // The real Home census owner separately proves these identity withdrawals.
      // This HTTP response retains the old Session row but admits no desired rule.
      f.setNativeDesiredBindingKeys([]);
      if (drift === 'guest-re-enrolled') f.input.machine.enrolledMachineId = 'replacement-guest';
      if (drift === 'controller-reinstalled') {
        f.input.machine.controller = { ...f.driverInput.controller, installationId: 'replacement-controller-installation' };
        f.driverInput.controller.installationId = f.input.machine.controller.installationId;
      }
      const installed = f.vendorCalls.length;
      await runtime.notifyChanged();
      expect(failures).toEqual([]);
      expect(f.vendorCalls.slice(installed).filter(call => call.method !== 'GET')
        .map(call => JSON.parse(new TextDecoder().decode(call.body))))
        .toEqual([{ mode: 'allow-all' }, { networkPolicy: { mode: 'allow-all' } }]);
      expect(f.readVendorPolicies()).toEqual({ live: { mode: 'allow-all' }, saved: { mode: 'allow-all' } });
      expect(f.binding.installation).toBe('confirmed');
      const settled = f.vendorCalls.length;
      await runtime.notifyChanged();
      expect(failures).toEqual([]);
      expect(f.vendorCalls.slice(settled).filter(call => call.method !== 'GET')).toEqual([]);
    } finally { await runtime.stop(); await f.cleanup(); }
  });

  it('reports a native policy outage without suppressing ordinary compute policy scheduling', async () => {
    const f = await fixture();
    const driver = createManagedMachineAcquisitionDriver({ ...f.driverInput,
      prepareTeamCredentialNativeSource: f.input.prepareSource });
    const machine = { ...f.input.machine, retention: { kind: 'deadline' as const, at: 0, effect: 'stop' as const, interrupts: true as const } };
    const failures: unknown[] = [];
    let computeStarted = false;
    const runtime = createDaemonManagedMachinePolicyRuntime({
      readCensus: async () => ({ machines: [machine], targets: [] }),
      // The scheduler's native compute executor is an external operation boundary.
      executePolicy: async () => { computeStarted = true; throw new Error('Compute executor unavailable'); },
      reconcileNativeCredentials: (current, signal) => driver.reconcileNativeCredentials(current, { ...f.options, signal }),
      onUnavailable: error => { failures.push(error); },
    });
    try {
      f.failVendorReads();
      await runtime.notifyChanged();
      expect(computeStarted).toBe(true);
      expect(failures).toHaveLength(2);
    } finally { await runtime.stop(); await f.cleanup(); }
  });

  it('removes an offline-deleted Session policy once on reconnect and leaves a second reconnect unchanged', async () => {
    const f = await fixture();
    const driver = createManagedMachineAcquisitionDriver({ ...f.driverInput,
      prepareTeamCredentialNativeSource: f.input.prepareSource });
    let online = false;
    const failures: unknown[] = [];
    const runtime = createDaemonManagedMachinePolicyRuntime({
      isAvailable: () => online,
      readCensus: async () => ({ machines: [f.input.machine], targets: [] }),
      executePolicy: async () => { throw new Error('No compute policy is requested'); },
      reconcileNativeCredentials: (machine, signal) => driver.reconcileNativeCredentials(machine, { ...f.options, signal }),
      onUnavailable: error => { failures.push(error); },
    });
    try {
      expect(await driver.execute('machines.managed.credentials.install', f.input.request, f.options))
        .toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      await runtime.notifyChanged();
      const installed = f.vendorCalls.length;
      // Home HTTP now returns the post-cascade census, not a synthetic target.
      f.setNativeBindings([]);
      online = true;
      await runtime.notifyChanged();
      expect(failures).toEqual([]);
      expect(f.vendorCalls.slice(installed).filter(call => call.method !== 'GET')
        .map(call => JSON.parse(new TextDecoder().decode(call.body))))
        .toEqual([{ mode: 'allow-all' }, { networkPolicy: { mode: 'allow-all' } }]);
      const firstReconnect = f.vendorCalls.length;
      await runtime.notifyChanged();
      expect(failures).toEqual([]);
      expect(f.vendorCalls.slice(firstReconnect).filter(call => call.method !== 'GET')).toEqual([]);
    } finally { await runtime.stop(); await f.cleanup(); }
  });

  it('settles an admitted vendor apply after source withdrawal while refusing a fresh acquisition', async () => {
    const f = await fixture();
    try {
      const before = f.source.sourceReads;
      f.holdRelease();
      const driver = createManagedMachineAcquisitionDriver({ ...f.driverInput, prepareTeamCredentialNativeSource: f.input.prepareSource });
      const applying = driver.execute('machines.managed.credentials.install', f.input.request, f.options);
      const reached = await Promise.race([
        f.releaseReached.then(() => ({ phase: 'vendor-write-held' as const })),
        applying.then(result => ({ phase: 'settled-before-vendor-write' as const, result })),
      ]);
      expect(reached).toEqual({ phase: 'vendor-write-held' });
      const admissionReads = f.source.sourceReads - before;
      f.source.setResource(null);
      const selected = f.binding.providerModelSelection;
      expect(await f.input.prepareSource({ ...f.source.request, application: selected.application!,
        currentSelection: { providerConnectionId: f.binding.delivery.providerAuthorizationTicket.connectionId,
          agentTargetKey: selected.agentTargetKey, modelId: selected.modelId } }))
        .toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
      f.finishRelease();
      expect(await applying).toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      expect(f.binding.installation).toBe('confirmed');
      expect(f.binding.submission).toBeUndefined();
      expect(admissionReads).toBe(1);
      expect(f.vendorCalls.filter(call => call.method !== 'GET')).toHaveLength(2);
      expect(JSON.stringify(f.invocationSnapshots)).not.toContain('native-source-secret');
    } finally { await f.cleanup(); }
  });

  it('uses real source headers only at vendor IO and awaits exact empty-policy release', async () => {
    const f = await fixture();
    try {
      const driver = createManagedMachineAcquisitionDriver({ ...f.driverInput, prepareTeamCredentialNativeSource: f.input.prepareSource });
      const result = await driver.execute('machines.managed.credentials.install', f.input.request, f.options);
      expect(result, JSON.stringify({ handlers: f.handlerEvents,
        requests: f.vendorCalls.map(call => [call.method, new URL(call.url).pathname]) }))
        .toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      const completions = vi.mocked(axios.post).mock.calls.filter(([url]) => String(url).endsWith('/report'))
        .map(([, body]) => ManagedControllerCredentialDeliveryReportV1Schema.parse(body).credentialDelivery)
        .filter(report => 'result' in report);
      expect(completions).toMatchObject([{ appliedPolicy: {
        ownedBindingKeys: [f.binding.safeFacet.bindingKey], desiredBindingKeys: [f.binding.safeFacet.bindingKey],
      } }]);
      const writes = f.vendorCalls.filter(call => call.method !== 'GET');
      expect(writes.map(call => [call.method, new URL(call.url).pathname])).toEqual([
        ['POST', '/v2/sandboxes/sessions/sbx_composed/network-policy'], ['PATCH', '/v2/sandboxes/happier-composed'],
      ]);
      const policy = JSON.parse(new TextDecoder().decode(writes[0]!.body));
      expect(policy).toEqual({ allow: { '*': [], 'example.test': [
        ['/v1/responses', 'POST'], ['/v1/models', 'GET'],
      ].map(([path, method]) => ({ match: { path: { exact: path }, method: [method],
          headers: [{ key: { exact: 'authorization' }, value: { exact: 'Bearer random-placeholder-a' } }] },
        transform: [{ headers: { authorization: 'Bearer native-source-secret', host: 'example.test',
          'x-happier-attribution': '["member-account","session-a"]' } }] })) } });
      expect(JSON.parse(new TextDecoder().decode(writes[1]!.body))).toEqual({ networkPolicy: policy });
      expect(await f.handles[0]!.readRenderedHeaders()).toMatchObject({ ok: false });
      const nativeBinding = SessionTeamCredentialBindingIntentV1Schema.parse({ v: 1, slot: { kind: 'provider_model' },
        resourceId: f.binding.resourceId, expectedResourceRevision: f.binding.resourceRevision,
        deliveryMode: 'vendor-native', nativeDelivery: f.binding.safeFacet });
      if (nativeBinding.resourceId === null) throw new Error('Expected installed resource');
      const agent = await materializeSessionTeamCredentialNativeBinding({
        consumer: { kind: 'session', sessionId: f.binding.sessionId }, row: f.binding.delivery.model,
        binding: nativeBinding, agentId: f.source.agentId, lease: f.source.lease,
        materializationBaseDir: f.source.happyHomeDir, signal: new AbortController().signal,
        // This is the installed-binding read boundary, not an installation or
        // source resolver. Its safe facts are exactly the composed binding.
        opened: { model: f.binding.delivery.model, endpoint: f.binding.delivery.endpoint,
          credentialTransport: f.binding.delivery.credentialTransport, placeholder: f.binding.delivery.placeholder,
          cleanup: async () => {} },
      });
      try {
        expect(agent.environmentOverlay).toEqual([{ name: 'RUN_PROVIDER_TOKEN', value: 'random-placeholder-a', source: 'provider' }]);
        expect(agent.providerBinding.upstream?.normalizedUrl).toBe(f.binding.delivery.endpoint.normalizedUrl);
        expect(f.binding.delivery.endpoint.publicHeaders).toEqual({});
        expect(JSON.stringify({ agent, calls: f.calls, binding: f.binding })).not.toContain('native-source-secret');
      } finally { await agent.cleanup(); }
      f.holdRelease();
      let settled = false;
      const released = composeManagedNativeCredentials({ ...f.input, request: { ...f.input.request, operation: 'release' }, desiredBindingKeys: [] })
        .then(result => { settled = true; return result; });
      await f.releaseReached;
      expect(settled).toBe(false);
      f.finishRelease();
      expect(await released).toEqual({ kind: 'confirmed', binding: f.binding.safeFacet });
      expect(f.handles).toHaveLength(1);
      expect(f.invocationSnapshots).toHaveLength(2);
      for (const snapshot of f.invocationSnapshots) {
        expect(snapshot).not.toContain('native-source-secret');
        expect(snapshot).not.toContain('composed-cloud-token');
      }
      expect(f.vendorCalls.filter(call => call.method !== 'GET').slice(2).map(call => JSON.parse(new TextDecoder().decode(call.body))))
        .toEqual([{ mode: 'allow-all' }, { networkPolicy: { mode: 'allow-all' } }]);
      const before = { writes: f.vendorCalls.length, material: vi.mocked(axios.get).mock.calls.length };
      expect(await composeManagedNativeCredentials({ ...f.input, request: { ...f.input.request, bindingKey: 'foreign-binding' } }))
        .toMatchObject({ kind: 'refused' });
      expect({ writes: f.vendorCalls.length, material: vi.mocked(axios.get).mock.calls.length }).toEqual(before);
    } finally { await f.cleanup(); }
  });
});
