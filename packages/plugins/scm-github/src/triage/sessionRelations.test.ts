import { describe, expect, it, vi } from 'vitest';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionsService, PluginActionReadInvalidation } from '@happier-dev/plugin-sdk/actions';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { encodeGithubTriageConfiguration } from './configuration.js';
import { GITHUB_REPOSITORY_RESPONSE } from './__fixtures__/githubResponses.js';
import { GITHUB_TEST_ACCOUNT, createStubGithubTransport } from './testkit/githubTriage.test-support.js';
import { linkGithubTriageSession, readGithubTriageSessionLinks } from './sessionRelations.js';
import * as sessionRelations from './sessionRelations.js';

function fixture(respond: (input: unknown) => unknown) {
  const source = createTriageSourceV1Fixture().configuredInstance;
  const token = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: ['octo-org/example-app'] } });
  if (token === null) throw new Error('Invalid fixture');
  const instance = { ...source, instance: { ...source.instance, source: { pluginId: 'happier.scm.forge.github', localId: 'github-forge' } },
    binding: { purpose: 'github-connected-account', account: GITHUB_TEST_ACCOUNT },
    localInstanceKey: 'github.com', configuration: { v: 1 as const, token } };
  const calls: unknown[] = [];
  const transport = createStubGithubTransport({ respond: request => new URL(request.url).pathname === '/repositories/4210'
    ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE } : undefined });
  // The cross-plugin Action transport is the system boundary; the GitHub
  // parser, exact account, routing, identity and result logic remain real.
  const actions = { async execute(action: unknown, input: unknown) {
    expect(action).toEqual({ pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' });
    calls.push(input); return respond(input);
  } } as unknown as ActionsService;
  const context: PluginInvocationContext = { ...transport.context, services: { ...transport.context.services, actions } };
  const localRef = { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '12' };
  const relation = { sessionId: 'session-1', bindingId: 'binding-1', revision: 3,
    pullRequest: { repository: 'octo-org/example-app', number: 12 }, repositoryId: '4210', linkedAtMs: 42 };
  return { instance, localRef, relation, calls, context, transport };
}

describe('GitHub PR source relationship adapter', () => {
  it('preserves a typed relationship read refusal instead of reporting a removed connection', async () => {
    const refusal = new PluginError({ code: 'plugin_action_machine_required', retryable: false });
    const state = fixture(() => { throw refusal; });
    await expect(readGithubTriageSessionLinks({ v: 1, instance: state.instance, localRef: state.localRef }, state.context))
      .rejects.toBe(refusal);
  });
  it('preserves a typed binding refusal through the existing Action error result', async () => {
    const refusal = new PluginError({ code: 'channels_pr_link_binding_not_ready', retryable: false });
    const state = fixture(() => { throw refusal; });
    await expect(linkGithubTriageSession({ v: 1, instance: state.instance, localRef: state.localRef,
      sessionId: 'session-1', linked: true }, state.context)).rejects.toBe(refusal);
    expect(state.calls).toHaveLength(1);
  });
  it.each(['account', 'native'] as const)('observes canonical %s membership without executing reads or acquiring credentials', async mode => {
    const state = fixture(() => { throw new Error('Observation must not execute the read handler'); });
    const instance = mode === 'account' ? state.instance : { ...state.instance, binding: {
      purpose: 'github-connected-account', source: 'native', service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' } } };
    const ownRouting = { serverIdentityId: 'server-1', machineId: 'machine-1', pluginId: 'happier.scm.forge.github' };
    const targetDispose = vi.fn(() => { notify = undefined; });
    const purposeDispose = vi.fn();
    let notify: PluginActionReadInvalidation | undefined;
    const observe = vi.fn(async (_action: unknown, _input: unknown, invalidate: PluginActionReadInvalidation, _options: unknown) => {
      notify = invalidate; return { dispose: targetDispose };
    });
    const actions = { ...state.context.services.actions, observe, async getCurrentExecutionRouting() { return ownRouting; } } as unknown as ActionsService;
    const context = { ...state.context, services: { ...state.context.services, actions,
      connectedAccounts: { ...state.context.services.connectedAccounts, watch: () => ({ dispose: purposeDispose }) } } };
    const changed = Object.assign(vi.fn(), { retire: vi.fn() });
    const observation = await sessionRelations.observeGithubTriageSessionLinks({ v: 1, instance, localRef: state.localRef, sessionId: 'session-1' }, changed, context);
    expect(observe).toHaveBeenCalledWith({ pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' },
      { kind: 'readRelations', credentialRef: mode === 'native' ? null : GITHUB_TEST_ACCOUNT, sessionId: 'session-1',
        pullRequest: { repositoryId: '4210', number: 12 } }, changed, {
        signal: context.signal, ...(mode === 'native' ? { expectedExecutionRouting: { ...ownRouting, pluginId: 'happier.channels' } } : {}),
      });
    notify?.();
    expect(changed).toHaveBeenCalledOnce();
    notify?.retire();
    expect(changed.retire).toHaveBeenCalledOnce();
    await observation.dispose();
    expect(targetDispose).toHaveBeenCalledOnce();
    expect(purposeDispose).toHaveBeenCalledOnce();
    changed.mockClear();
    notify?.();
    expect(changed).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
    expect(state.transport.requests).toEqual([]);
    expect(state.transport.materializeCount()).toBe(0);
  });
  it('retires the credential lifetime when canonical observation is unavailable instead of falling back to snapshots', async () => {
    const state = fixture(() => { throw new Error('No snapshot fallback'); });
    const dispose = vi.fn();
    const unavailable = Object.assign(new Error('No admitted observer'), { code: 'plugin_action_read_observation_unavailable' });
    const actions = { ...state.context.services.actions, async observe() { throw unavailable; } } as unknown as ActionsService;
    const context = { ...state.context, services: { ...state.context.services, actions,
      connectedAccounts: { ...state.context.services.connectedAccounts, watch: () => ({ dispose }) } } };
    await expect(sessionRelations.observeGithubTriageSessionLinks({ v: 1, instance: state.instance }, Object.assign(vi.fn(), { retire: vi.fn() }), context)).rejects.toBe(unavailable);
    expect(dispose).toHaveBeenCalledOnce();
    expect(state.calls).toEqual([]);
    expect(state.transport.materializeCount()).toBe(0);
  });
  it('disposes a late observer acquisition after cancellation', async () => {
    const state = fixture(() => { throw new Error('No handler during observation'); });
    const controller = new AbortController();
    const purposeDispose = vi.fn();
    const targetDispose = vi.fn();
    let release: ((value: { dispose(): void }) => void) | undefined;
    let started: (() => void) | undefined;
    const acquired = new Promise<void>(resolve => { started = resolve; });
    const actions = { ...state.context.services.actions, observe: () => {
      started?.(); return new Promise<{ dispose(): void }>(resolve => { release = resolve; });
    } } as unknown as ActionsService;
    const context = { ...state.context, signal: controller.signal, services: { ...state.context.services, actions,
      connectedAccounts: { ...state.context.services.connectedAccounts, watch: () => ({ dispose: purposeDispose }) } } };
    const pending = sessionRelations.observeGithubTriageSessionLinks({ v: 1, instance: state.instance }, Object.assign(vi.fn(), { retire: vi.fn() }), context);
    await acquired;
    controller.abort();
    release?.({ dispose: targetDispose });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(purposeDispose).toHaveBeenCalledOnce();
    expect(targetDispose).toHaveBeenCalledOnce();
  });
  it('reads exact native binding identities and original clocks without GitHub IO', async () => {
    const state = fixture(() => ({ kind: 'relations', links: [state.relation] }));
    expect(await readGithubTriageSessionLinks({ v: 1, instance: state.instance, localRef: state.localRef, sessionId: 'session-1' }, state.context))
      .toMatchObject({ kind: 'complete', links: [{ localRef: state.localRef, sessionId: 'session-1', linkedAtMs: 42,
        displayPath: 'octo-org/example-app#12', locator: { routingToken: 'octo-org/example-app' } }] });
    expect(state.calls).toEqual([{ kind: 'readRelations', credentialRef: GITHUB_TEST_ACCOUNT, sessionId: 'session-1',
      pullRequest: { repositoryId: '4210', number: 12 } }]);
    expect(state.transport.requests).toEqual([]);
    expect(state.transport.materializeCount()).toBe(0);
  });

  it('attaches using immutable repository proof and exact configured credentials without mandatory readback', async () => {
    const state = fixture(() => ({ kind: 'attached', bindingId: 'binding-1' }));
    expect(await linkGithubTriageSession({ v: 1, instance: state.instance, localRef: state.localRef,
      sessionId: 'session-1', linked: true }, state.context)).toEqual({ status: 'linked' });
    expect(state.calls).toEqual([{ kind: 'attach', credentialRef: GITHUB_TEST_ACCOUNT, sessionId: 'session-1',
      pullRequest: { repository: 'octo-org/example-app', number: 12 }, expectedRepositoryId: '4210' }]);
    expect(state.transport.requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([['GET', '/repositories/4210']]);
    expect(state.transport.materializations.map(request => request.account)).toEqual([GITHUB_TEST_ACCOUNT]);
  });

  it('keeps a native read at the source’s admitted placement and refuses a missing placement', async () => {
    const state = fixture(() => { throw new Error('Native reads must not use the default Account transport'); });
    const native = { ...state.instance, binding: { purpose: 'github-connected-account', source: 'native',
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' } } };
    const ownRouting = { serverIdentityId: 'server-1', machineId: 'machine-1', pluginId: 'happier.scm.forge.github' };
    const nativeCalls: unknown[] = [];
    // Host routing and the cross-plugin RPC are genuine boundaries; the
    // adapter must provide the incumbent exact-placement precondition.
    const actions = { ...state.context.services.actions,
      async getCurrentExecutionRouting() { return ownRouting; },
      async executeWithExecutionOrigin(action: unknown, input: unknown, options: unknown) {
        nativeCalls.push({ action, input, options });
        return { result: { kind: 'relations', links: [state.relation] } };
      },
    } as unknown as ActionsService;
    const context = { ...state.context, services: { ...state.context.services, actions } };
    expect(await readGithubTriageSessionLinks({ v: 1, instance: native, localRef: state.localRef }, context))
      .toMatchObject({ kind: 'complete', links: [{ localRef: state.localRef }] });
    expect(nativeCalls).toMatchObject([{ input: { kind: 'readRelations', credentialRef: null },
      options: { expectedExecutionRouting: { ...ownRouting, pluginId: 'happier.channels' } } }]);
    await expect(readGithubTriageSessionLinks({ v: 1, instance: native }, state.context))
      .rejects.toMatchObject({ code: 'github_session_relations_native_origin_unavailable' });
    expect(state.transport.requests).toEqual([]);
  });

  it('unlinks every exact canonical row by retained revision, without GitHub IO', async () => {
    const state = fixture(input => typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'readRelations'
      ? { kind: 'relations', links: [state.relation] } : { kind: 'removed' });
    expect(await linkGithubTriageSession({ v: 1, instance: state.instance, localRef: state.localRef,
      sessionId: 'session-1', linked: false }, state.context)).toEqual({ status: 'unlinked' });
    expect(state.calls[1]).toEqual({ kind: 'unlink', sessionId: 'session-1', bindingId: 'binding-1', expectedRevision: 3 });
    expect(state.transport.requests).toEqual([]);
  });

  it('retains native placement for unlink even though the canonical unlink operand has no credential field', async () => {
    const state = fixture(() => { throw new Error('A native unlink must not fall through the default transport'); });
    const native = { ...state.instance, binding: { purpose: 'github-connected-account', source: 'native',
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' } } };
    const calls: Array<Readonly<{ input: unknown; options: unknown }>> = [];
    const actions = { ...state.context.services.actions,
      async getCurrentExecutionRouting() { return { serverIdentityId: 'server-1', machineId: 'machine-1', pluginId: 'happier.scm.forge.github' }; },
      async executeWithExecutionOrigin(_action: unknown, input: unknown, options: unknown) {
        calls.push({ input, options });
        return { result: typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'readRelations'
          ? { kind: 'relations', links: [state.relation] } : { kind: 'removed' } };
      },
    } as unknown as ActionsService;
    expect(await linkGithubTriageSession({ v: 1, instance: native, localRef: state.localRef, sessionId: 'session-1', linked: false },
      { ...state.context, services: { ...state.context.services, actions } })).toEqual({ status: 'unlinked' });
    expect(calls).toMatchObject([{ input: { kind: 'readRelations' } }, { input: { kind: 'unlink', sessionId: 'session-1' },
      options: { expectedExecutionRouting: { serverIdentityId: 'server-1', machineId: 'machine-1', pluginId: 'happier.channels' } } }]);
    expect(state.transport.requests).toEqual([]);
  });

  it('refuses foreign PR identity and leaves Issues outside the PR role', async () => {
    const state = fixture(() => ({ kind: 'relations', links: [{ ...state.relation, repositoryId: '99' }] }));
    expect(await readGithubTriageSessionLinks({ v: 1, instance: state.instance, localRef: state.localRef }, state.context))
      .toMatchObject({ kind: 'failed' });
    const count = state.calls.length;
    expect(await linkGithubTriageSession({ v: 1, instance: state.instance, localRef: { ...state.localRef, kindId: 'issue' },
      sessionId: 'session-1', linked: true }, state.context)).toEqual({ status: 'failed' });
    expect(state.calls).toHaveLength(count);
    expect(state.transport.requests).toEqual([]);
  });
});
