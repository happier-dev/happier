// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageDetailInstance, TriageDetailPanelNavigationProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_SECURITY_ALERT_ACTION_IDS_V1 as ids,
  GithubSecurityAlertReadResultV1Schema,
  GithubCodeScanningLocationsResultV1Schema,
  GithubCodeScanningLocationResultV1Schema,
  GithubSecurityAlertMutationResultV1Schema,
} from '../../triage/securityAlerts/actionContracts.js';
import { useGithubSecurityAlertDetail, type GithubSecurityAlertControllerV1 } from './controller.js';
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await act(async () => { await fixture.dispose(); }); });

function detailInput(kindId = 'code-scanning-alert') {
  const source = { pluginId: 'happier.scm.forge.github', localId: 'github-forge' };
  return TriageDetailSurfaceInputV1Schema.parse({ v: 1,
    instance: { v: 1, instance: { source, sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70' },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: { service: { pluginId: source.pluginId, localId: 'github-account' }, accountId: 'account-1' } },
      localInstanceKey: 'github.com', configuration: { v: 1, token: 'fixture' } },
    observation: { entryRef: { source, kindId, collisionScope: 'github:1', entryId: '7' }, observedAtMs: 100,
      locator: { v: 1, routingToken: 'owner/repo' }, snapshot: { v: 1, title: 'Finding', scopeLabel: 'owner/repo', state: { presentation: 'active', nativeLabel: 'open' }, facts: [] }, viewer: { involvement: [] } }, linkedSessions: [] });
}
const location = { ref: 'refs/heads/main', analysisKey: 'scanner', environment: '{}', category: 'default', state: 'open',
  commitSha: 'a'.repeat(40), path: 'src/a.ts', startLine: 2, endLine: 3, startColumn: null, endColumn: null, message: 'Finding' };
function answer(input: ReturnType<typeof detailInput>): JsonValue {
  return GithubSecurityAlertReadResultV1Schema.parse({ kind: 'alert', kindId: 'code-scanning-alert', detail: { nativeState: 'open', severity: 'high', projectionTruncated: false, url: 'https://github.com/owner/repo/security/code-scanning/7',
    dismissedReason: null, dismissedComment: null, dismissedBy: null, dismissedAt: null, ruleId: 'rule', ruleName: 'Rule', ruleDescription: 'Description', ruleHelp: null,
    ruleSeverity: 'warning', toolName: 'Scanner', toolVersion: null, message: 'Finding', location },
  observation: { kind: 'present', localRef: { kindId: input.observation.entryRef.kindId, collisionScope: 'github:1', entryId: '7' },
    locator: input.observation.locator, snapshot: input.observation.snapshot, viewer: input.observation.viewer } });
}

function ControllerProbe(props: Readonly<{
  input: ReturnType<typeof detailInput>;
  options: Parameters<typeof useGithubSecurityAlertDetail>[1];
  accept: (controller: GithubSecurityAlertControllerV1) => void;
}>) {
  props.accept(useGithubSecurityAlertDetail(props.input, props.options));
  return null;
}

describe('the selected security alert controller', () => {
  it('exposes the frame-owned off-page fix PR navigation only for the current Dependabot association without another read', async () => {
    let input = detailInput('dependabot-alert');
    const signal = new AbortController().signal;
    const opened: string[] = [];
    const binding = {
      entryRef: { ...input.observation.entryRef, kindId: 'pull-request', entryId: '42' },
      title: 'Update vulnerable dependency', url: 'https://github.com/owner/repo/pull/42',
      open: async () => { opened.push('entry'); return { kind: 'opened' as const }; },
      openExternal: async () => { opened.push('github'); },
    };
    let association: typeof binding | null = binding;
    let current!: GithubSecurityAlertControllerV1;
    const reads: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'alert-fix-navigation', mountNonce: 'alert-fix-navigation' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageDetailInstance>
        <TriageDetailPanelNavigationProvider navigation={{ panels: ['overview'], select: () => {}, ...(association === null ? {} : { fixPullRequest: association }) }}>
          <ControllerProbe input={input} options={{ activity: { active: true, activeSignal: signal } }} accept={value => { current = value; }} />
        </TriageDetailPanelNavigationProvider>
      </TriageDetailInstance>),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action }) => {
        reads.push((action as { localId: string }).localId);
        return { kind: 'unavailable', failure: { class: 'permission', code: 'alert_detail_denied' } };
      } },
    }); });
    mounted.push(fixture);
    expect(current).toHaveProperty('fixPullRequest', binding);
    if (!('fixPullRequest' in current) || current.fixPullRequest !== binding) throw new Error('Missing fix PR navigation');
    await current.fixPullRequest.open();
    await current.fixPullRequest.openExternal();
    expect(opened).toEqual(['entry', 'github']);
    expect(reads).toEqual([ids.read]);
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(current).toHaveProperty('fixPullRequest', binding);
    expect(reads).toEqual([ids.read]);
    // Both no-association and denied-association outcomes withdraw the parent's offer.
    association = null;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(current).toHaveProperty('fixPullRequest', null);
    association = binding;
    input = detailInput('code-scanning-alert');
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(current).toHaveProperty('fixPullRequest', null);
  });

  it('hands Fix choices and exact alert identity to the shared owner and preserves cancellation', async () => {
    const input = detailInput();
    const signal = new AbortController().signal;
    const handoffs: unknown[] = [];
    let current!: GithubSecurityAlertControllerV1;
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'alert-fix-probe', mountNonce: 'alert-fix-probe' }, authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageDetailInstance><ControllerProbe input={input} options={{ activity: { active: true, activeSignal: signal } }} accept={value => { current = value; }} /></TriageDetailInstance>),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input: payload }) => {
        const localId = (action as { localId: string }).localId;
        if (localId === ids.read) return answer(input);
        expect(localId).toBe('sessions/run-configured-v1');
        handoffs.push(payload);
        return { v: 1, handoff: { kind: 'cancelled' } };
      } },
    }); });
    mounted.push(fixture);
    let result: unknown;
    await act(async () => { result = await current.fix({ configuredActionId: 'fix', sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'compose' }); });
    const entry = { entryRef: input.observation.entryRef, sourceInstanceId: input.instance.instance.sourceInstanceId };
    expect(handoffs).toEqual([{ v: 1, handoff: { task: 'fix', configuredActionId: 'fix', context: { kind: 'entry', entry },
      evidence: [{ kind: 'alertEntry', entry }], sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'compose' } }]);
    expect(result).toMatchObject({ v: 1, handoff: { kind: 'cancelled' } });
  });

  it('dispatches the named native transition, rejects a wrong-family reason and preserves an uncertain outcome', async () => {
    const input = detailInput();
    const signal = new AbortController().signal;
    const calls: Array<{ localId: string; input: unknown }> = [];
    let current!: GithubSecurityAlertControllerV1;
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'alert-write-probe', mountNonce: 'alert-write-probe' }, authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageDetailInstance><ControllerProbe input={input} options={{ activity: { active: true, activeSignal: signal } }} accept={value => { current = value; }} /></TriageDetailInstance>),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input: payload }) => {
        const localId = (action as { localId: string }).localId;
        calls.push({ localId, input: payload });
        if (localId === ids.read) return answer(input);
        return GithubSecurityAlertMutationResultV1Schema.parse({ kind: 'uncertain', failure: { class: 'unknown', code: 'response_lost' } });
      } },
    }); });
    mounted.push(fixture);
    await act(async () => { expect(await current.mutations.dismissControl('fix_started', 'Retained comment').prepare({ signal })).toBeNull(); });
    expect(calls).toHaveLength(1);
    await act(async () => {
      const control = current.mutations.dismissControl('false positive', 'Retained comment');
      const prepared = await control.prepare({ signal });
      expect(calls).toHaveLength(1);
      expect(prepared?.input).toMatchObject({ reason: 'false positive', comment: 'Retained comment' });
      control.onSettled({ ok: true, result: GithubSecurityAlertMutationResultV1Schema.parse({ kind: 'uncertain', failure: { class: 'unknown', code: 'response_lost' } }) });
    });

    expect(current.mutations.outcome).toMatchObject({ kind: 'uncertain', failure: { code: 'response_lost' } });
    expect(calls.map(call => call.localId)).toEqual([ids.read]);
  });

  it.each(['dependabot-alert', 'code-scanning-alert'])('never sends %s through legacy issue/PR detail Actions', async kindId => {
    const calls: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'legacy-alert-probe', mountNonce: 'legacy-alert-probe' }, authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: renderSurface, launchInput: { ...detailInput(kindId), panel: 'actions' },
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action }) => { calls.push((action as { localId: string }).localId); return null; } },
    }); });
    mounted.push(fixture);
    // The alert's own composition reads it through its native alert Actions, never a PR/issue reader.
    expect(calls).toContain(ids.read);
    expect(calls.filter(id => !/^github\/(security-alert|dependabot-alert|code-scanning-alert)\//u.test(id))).toEqual([]);
  });

  it('cancels a hidden acquisition, rejects its late result and retries on the next visible interval', async () => {
    let active = true;
    let current!: GithubSecurityAlertControllerV1;
    let finish!: (value: JsonValue) => void;
    const pending = new Promise<JsonValue>(resolve => { finish = resolve; });
    let requestSignal!: AbortSignal;
    let count = 0;
    const input = detailInput();
    const signal = new AbortController().signal;
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'hidden-alert-probe', mountNonce: 'hidden-alert-probe' }, authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageDetailInstance><ControllerProbe input={input} options={{ activity: { active, activeSignal: signal } }} accept={value => { current = value; }} /></TriageDetailInstance>),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, signal }) => {
        if ((action as { localId: string }).localId !== ids.read) throw new Error('Unexpected read');
        requestSignal = signal;
        count += 1;
        return count === 1 ? pending : answer(input);
      } },
    }); });
    mounted.push(fixture);
    active = false;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(requestSignal.aborted).toBe(true);
    await act(async () => { finish(answer(input)); });
    expect(current.detail.state.kind).toBe('loading');
    active = true;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(count).toBe(2);
    expect(current.detail.state.kind).toBe('ready');
  });

  it('does no hidden work, shares one selected read, and requests only the selected immutable location page', async () => {
    let active = false;
    let locationsActive = false;
    let input = detailInput();
    const signal = new AbortController().signal;
    let current!: GithubSecurityAlertControllerV1;
    const calls: Array<{ localId: string; input: unknown }> = [];
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'alert-probe', mountNonce: 'alert-probe' }, authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageDetailInstance><ControllerProbe input={input} options={{ activity: { active, activeSignal: signal }, locationsActive }} accept={value => { current = value; }} /></TriageDetailInstance>),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input: payload }) => {
        const localId = (action as { localId: string }).localId;
        calls.push({ localId, input: payload });
        if (localId === ids.read) return answer(input);
        if (localId === ids.listLocations) return GithubCodeScanningLocationsResultV1Schema.parse({ kind: 'locations', rows: [location], continuation: 'next-page', incomplete: 'pagination' });
        if (localId === ids.readLocation) return GithubCodeScanningLocationResultV1Schema.parse({ kind: 'location', location, code: null, projectionTruncated: false, codeUnavailable: { class: 'unknown', code: 'contents_denied' }, firstLine: 2, lastLine: 3, totalLines: 0, sourceUrl: 'https://github.com/owner/repo/blob/' + location.commitSha + '/src/a.ts' });
        return { kind: 'unavailable', failure: { class: 'unknown', code: 'unexpected' } };
      } },
    }); });
    mounted.push(fixture);
    expect(calls).toHaveLength(0);
    active = true;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(calls.map(call => call.localId)).toEqual([ids.read]);
    const selected = current.detail.state;
    input = { ...input, observation: { ...input.observation, observedAtMs: 200 } };
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(current.detail.state).toBe(selected);
    expect(calls).toHaveLength(1);
    locationsActive = true;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(calls.map(call => call.localId)).toEqual([ids.read, ids.listLocations]);
    const row = current.locations.state.rows[0]!;
    await act(async () => { current.selectLocation(row); });
    expect(calls.at(-1)).toMatchObject({ localId: ids.readLocation, input: { selectedInstance: { path: 'src/a.ts', commitSha: location.commitSha } } });
    expect(current.snippet.state).toMatchObject({ kind: 'ready', value: { location, code: null, codeUnavailable: { code: 'contents_denied' } } });
    const count = calls.length;
    locationsActive = false;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { current.locations.loadMore(); current.snippet.refresh(); });
    expect(calls).toHaveLength(count);
    expect(current.selectedLocation).toBe(row);
    active = false;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    active = true;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(calls).toHaveLength(count);
    input = { ...input, instance: { ...input.instance, configuration: { v: 1, token: 'reconfigured' } } };
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(current.selectedLocation).toBeNull();
    expect(current.locations.state.rows).toEqual([]);
    expect(calls.slice(count).map(call => call.localId)).toEqual([ids.read]);
  });
});
