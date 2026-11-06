// @vitest-environment jsdom
import * as React from 'react';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { defineUiSurface, usePluginHostApi } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { JsonValue, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginUiHostApi, PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import { PluginUiActionOperationHostReadResultV1ProtocolSchema,
  type PluginUiActionOperationHostReadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import { LocalActRunForm, useLocalActRunFormV1 } from './LocalActRunForm.js';
import { LocalActRunFormView, localActPermissionKindV1 } from './LocalActRunFormView.js';
import { HappierInputPickerProvider, type HappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import { invokeInputTypePicker } from '@happier-dev/protocol/inputs/runtime';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await act(async () => { await fixture.dispose(); }); });

const seed = { workspace: { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' },
  target: { kind: 'session' as const, sessionId: 'session-a6' }, workflowPath: '.github/workflows/ci.yml', event: 'push' };
// The host scope is a real system boundary; lifetime/retirement semantics have their own composed test.
const sharedScope: PluginEphemeralSharedScope = { acquire(_key, create) {
  const held = create(); return { value: held.value, release: () => held.dispose() };
} };

type ActionControlHandler = NonNullable<NonNullable<Parameters<typeof createPluginUiTestkit>[0]['handlers']>['actionControl']>;
type ActionControlHostInput = Parameters<ActionControlHandler>[0];
type BoundControl = Extract<ActionControlHostInput['request'], { kind: 'bind' }>;

// Only the installed host gesture/executor is substituted; SDK transport and author controls stay real.
function hostRunBoundary(execute: (input: unknown, action: Parameters<PluginUiHostApi['actionControl']>[0]['action']) => Promise<PluginUiActionControlExecution>) {
  const bindings = new Map<string, { action: BoundControl['action']; presentation: BoundControl['presentation'];
    publish: ActionControlHostInput['publish']; resolve?: () => void; reject?: (error: unknown) => void }>();
  let gestures = 0;
  const handler: ActionControlHandler = async ({ request, publish }) => {
    if (request.kind === 'bind') {
      expect(['projects.compute.exec', 'projects.worker.preferences.set']).toContain(request.action);
      bindings.set(request.subscriptionId, { action: request.action, presentation: request.presentation, publish });
      return { dispose: () => { bindings.delete(request.subscriptionId); } };
    }
    const binding = bindings.get(request.subscriptionId);
    if (!binding) throw new Error('Retired host control');
    if (request.kind === 'update') { binding.presentation = request.presentation; return; }
    try {
      if (request.preparation) publish({ kind: 'settled', requestId: request.requestId,
        execution: await execute(request.preparation.input, binding.action) });
      binding.resolve?.();
    } catch (error) { binding.reject?.(error); throw error; }
    finally { delete binding.resolve; delete binding.reject; }
  };
  const find = (title: string) => {
    const binding = [...bindings.values()].find(value => value.presentation.title === title);
    if (!binding) throw new Error(`Missing host-rendered Action control: ${title}`);
    return binding;
  };
  return { handler,
    presentation(title: string) { return find(title).presentation; },
    async press(title: string) {
      const binding = find(title);
      expect(binding.presentation.disabled).not.toBe(true);
      await new Promise<void>((resolve, reject) => {
        binding.resolve = resolve; binding.reject = reject;
        binding.publish({ kind: 'prepare', requestId: `host-gesture-${++gestures}` });
      });
    },
  };
}

describe('mounted local form ordinary compute hook', () => {
  it('chooses declared Saved Secret references without eager work and carries only references into an explicit primary Run', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    const actions: unknown[] = [];
    const dispatched: { action: unknown; input: unknown }[] = [];
    const controls = hostRunBoundary(async (input, action) => {
      dispatched.push({ action, input });
      return { ok: true, result: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'review' } };
    });
    let pickerCalls = 0;
    let answer: unknown = { kind: 'completed', input: { ref: 'happier:shared-secret:v1:ci-token', resourceRevision: 3 } };
    const port: HappierInputPickerPort = {
      describe: field => field.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'savedSecretReference'
        ? { label: 'Browse…', accessibilityLabel: `Browse for ${field.title}` } : null,
      pick: async request => {
        const result = await invokeInputTypePicker({
          field: { ...request.field, widget: 'select' },
          ...(request.value === undefined ? {} : { value: normalizeStrictJsonValue(request.value) }),
          signal: request.signal,
          host: {
            resolveType: async () => { throw new Error('No plugin type lookup for a host picker'); },
            resolveOptions: async () => { throw new Error('No inventory read before picker demand'); },
            openPicker: async () => { throw new Error('No contributed picker for a host type'); },
            openHostPicker: async () => { pickerCalls++; return answer; },
          },
        });
        return result.status === 'error' ? { status: 'error', message: result.reasonCode } : result;
      },
    };
    function Probe() {
      const host = usePluginHostApi();
      return <HappierInputPickerProvider port={port}>
        <LocalActRunForm accountId="account" mountId="secret-ref-form" seed={seed} host={host}
          sharedScope={sharedScope} signal={renderer.signal}>{value => {
            current = value;
            return <LocalActRunFormView form={value} host={host} machineName="Build box" jobLabel={null} />;
          }}</LocalActRunForm>
      </HappierInputPickerProvider>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'secret-ref-form', mountNonce: 'secret-ref-form' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { actionControl: controls.handler, readMachineDisplayName: async () => ({ status: 'ready', displayName: 'Build box' }),
        executeAction: async ({ action }): Promise<JsonValue> => {
          actions.push(action);
          if (typeof action !== 'object' || action.localId !== 'github/actions/local-inspect') throw new Error('Editing must not launch');
          return { workspace: seed.workspace, workflowPath: seed.workflowPath, workflows: [seed.workflowPath],
            secretRequirements: [{ name: 'GITHUB_TOKEN', kind: 'secret', required: false }, { name: 'PACKAGE_TOKEN', kind: 'secret', required: false }],
            tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
            preferenceAddress: { serverId: 'home', refId: 'checkout' },
            preference: { status: 'ready', revision: 1, provenance: 'saved', preference: {
              enabled: false, allowAdHoc: true, unavailable: 'ask', scriptOverrides: {},
            } }, workflow: { events: ['push'], jobs: [{ id: 'test', needs: [], runsOn: ['ubuntu-latest'] }] } };
        },
      },
    }); });
    mounted.push(fixture);
    const choose = async (name: string) => {
      const button = await fixture.queryByRole('button', { name: `${name}: Browse…` });
      expect(button, 'Declared secret must have a reference picker').toBeDefined();
      await act(async () => { await fixture.press(button!); });
    };
    expect(pickerCalls).toBe(0);
    await choose('GITHUB_TOKEN');
    const selected = current.snapshot!.selection;
    expect(selected.environmentBindings).toEqual({ v: 1, bindings: {
      GITHUB_TOKEN: { ref: 'happier:shared-secret:v1:ci-token', revision: 3 },
    } });
    answer = { kind: 'cancelled' };
    await choose('PACKAGE_TOKEN');
    expect(current.snapshot!.selection).toBe(selected);
    answer = { kind: 'completed', input: { ref: 'happier:shared-secret:v1:bad', resourceRevision: 1, value: 'raw-secret' } };
    await choose('PACKAGE_TOKEN');
    expect(current.snapshot!.selection).toBe(selected);
    answer = { kind: 'completed', input: { ref: 'happier:shared-secret:v1:package-token', resourceRevision: 5 } };
    await choose('PACKAGE_TOKEN');
    expect(current.snapshot!.selection.environmentBindings).toEqual({ v: 1, bindings: {
      GITHUB_TOKEN: { ref: 'happier:shared-secret:v1:ci-token', revision: 3 },
      PACKAGE_TOKEN: { ref: 'happier:shared-secret:v1:package-token', revision: 5 },
    } });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Clear GITHUB_TOKEN' })); });
    expect(current.snapshot!.selection.environmentBindings).toEqual({ v: 1, bindings: {
      PACKAGE_TOKEN: { ref: 'happier:shared-secret:v1:package-token', revision: 5 },
    } });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Clear PACKAGE_TOKEN' })); });
    expect(current.snapshot!.selection.environmentBindings).toBeUndefined();
    expect(actions).toEqual([{ pluginId: 'happier.scm.forge.github', localId: 'github/actions/local-inspect' }]);
    expect(dispatched).toHaveLength(0);
    expect(await fixture.queryByRole('button', { name: 'UNDECLARED' })).toBeUndefined();
    await choose('PACKAGE_TOKEN');
    await act(async () => { current.controller!.setSelection({ ...current.snapshot!.selection,
      architecture: 'linux/arm64', platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] }); });
    await act(async () => { await controls.press('Run on Build box'); });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ action: 'projects.compute.exec', input: {
      workspace: seed.workspace, executable: '/tools/act', cwd: '/repo', execution: 'primary', choice: { kind: 'primary' },
      argv: ['push', '--workflows=.github/workflows/ci.yml', '--platform=ubuntu-latest=ghcr.io/example/runner:reviewed',
        '--container-architecture=linux/arm64', '--secret-file=', '--env-file=', '--var-file=', '--input-file=',
        '--secret=PACKAGE_TOKEN', '--secret=GITHUB_TOKEN=', '--json=false', '--insecure-secrets=false', '--rm=true', '--reuse=false'],
      environmentBindings: { v: 1, bindings: { PACKAGE_TOKEN: { ref: 'happier:shared-secret:v1:package-token', revision: 5 } } },
    } });
    // The fresh effect-time inspection stays; editing itself made only the opening inspection.
    expect(actions).toHaveLength(2);
  });
  it('uses distinct host gestures for Allow and Run while preserving siblings and starting nothing on enablement', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    const dispatched: { action: unknown; input: unknown }[] = [];
    const preference = { enabled: false, allowAdHoc: false, unavailable: 'ask', scriptOverrides: {} };
    const controls = hostRunBoundary(async (input, action) => {
      dispatched.push({ action, input });
      if (action === 'projects.worker.preferences.set') return { ok: true, result: { status: 'applied',
        preference: { ...preference, allowAdHoc: true }, revision: 2, provenance: 'saved' } };
      return { ok: true, result: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'review' } };
    });
    function Probe() {
      const host = usePluginHostApi();
      return <LocalActRunForm accountId="account" mountId="first-use-controls" seed={seed} host={host}
        sharedScope={sharedScope} signal={renderer.signal}>{value => {
          current = value;
          return <LocalActRunFormView form={value} host={host} machineName="Build box" jobLabel={null} />;
        }}</LocalActRunForm>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'first-use-controls', mountNonce: 'first-use-controls' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { actionControl: controls.handler, readMachineDisplayName: async () => ({ status: 'ready', displayName: 'Build box' }),
        executeAction: async ({ action }) => {
          if (typeof action !== 'object' || action.localId !== 'github/actions/local-inspect') throw new Error('Mutations must use separate host controls');
          return { workspace: seed.workspace, workflowPath: seed.workflowPath, workflows: [seed.workflowPath], secretRequirements: [],
            tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
            preferenceAddress: { serverId: 'home', refId: 'checkout' },
            preference: { status: 'ready', revision: 1, provenance: 'saved', preference: dispatched.some(call => call.action === 'projects.worker.preferences.set')
              ? { ...preference, allowAdHoc: true } : preference },
            workflow: { events: ['push'], jobs: [{ id: 'test', needs: [], runsOn: ['ubuntu-latest'] }] } };
        },
      },
    }); });
    mounted.push(fixture);
    await act(async () => { current.controller!.setSelection({ ...current.snapshot!.selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] }); });
    const draft = current.snapshot!.selection;
    expect(dispatched).toHaveLength(0);
    expect(controls.presentation('Allow for this project').disabled).not.toBe(true);
    expect(await fixture.queryByRole('button', { name: 'Allow for this project' })).toBeUndefined();
    expect(controls.presentation('Run on Build box').disabled).toBe(true);
    await act(async () => { await controls.press('Allow for this project'); });
    expect(dispatched).toEqual([{ action: 'projects.worker.preferences.set', input: {
      workspace: { serverId: 'home', refId: 'checkout' }, expectedRevision: 1,
      expected: { kind: 'value', value: preference }, next: { ...preference, allowAdHoc: true },
    } }]);
    expect(current.snapshot?.selection).toBe(draft);
    expect(localActPermissionKindV1(current.snapshot!)).toBe('allowed');
    expect(current.controller!.canRun()).toBe(true);
    expect(controls.presentation('Run on Build box').disabled).not.toBe(true);
    await act(async () => { await controls.press('Run on Build box'); });
    expect(dispatched.map(call => call.action)).toEqual(['projects.worker.preferences.set', 'projects.compute.exec']);
  });
  it('binds Run to the host control with fresh preparation and original settlement instead of an author compute gesture', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    const inspected: unknown[] = [];
    const dispatched: unknown[] = [];
    const hold = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'review' };
    const execution = { ok: true as const, result: hold };
    const controls = hostRunBoundary(async input => { dispatched.push(input); return execution; });
    function Probe() {
      const host = usePluginHostApi();
      return <LocalActRunForm accountId="account" mountId="host-run-form" seed={seed} host={host}
        sharedScope={sharedScope} signal={renderer.signal}>{value => {
          current = value;
          return <LocalActRunFormView form={value} host={host} machineName="Build box" jobLabel={null} />;
        }}</LocalActRunForm>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'host-run-form', mountNonce: 'host-run-form' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { actionControl: controls.handler, readMachineDisplayName: async () => ({ status: 'ready', displayName: 'Build box' }),
        executeAction: async ({ action, input }): Promise<JsonValue> => {
          if (typeof action !== 'object' || action.localId !== 'github/actions/local-inspect') throw new Error('Run must use the host control, not raw executeAction');
          inspected.push(input);
          return { workspace: seed.workspace, workflowPath: seed.workflowPath, workflows: [seed.workflowPath], secretRequirements: [],
            tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
            preferenceAddress: { serverId: 'home', refId: 'checkout' },
            preference: { status: 'ready', revision: 1, provenance: 'saved', preference: {
              enabled: false, allowAdHoc: true, unavailable: 'ask', scriptOverrides: {},
            } }, workflow: { events: ['push'], jobs: [{ id: 'test', needs: [], runsOn: ['ubuntu-latest'] }] } };
        },
      },
    }); });
    mounted.push(fixture);
    await act(async () => { current.controller!.setSelection({ ...current.snapshot!.selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] }); });
    expect(dispatched).toHaveLength(0);
    expect(controls.presentation('Run on Build box').disabled).not.toBe(true);
    expect(await fixture.queryByRole('button', { name: 'Run on Build box' })).toBeUndefined();
    await act(async () => { await controls.press('Run on Build box'); });
    expect(inspected).toHaveLength(2);
    expect(dispatched).toEqual([expect.objectContaining({ executable: '/tools/act', execution: 'primary',
      workspace: seed.workspace, argv: expect.arrayContaining(['--rm=true', '--reuse=false', '--insecure-secrets=false']) })]);
    expect(current.snapshot?.lastResult).toEqual(execution);
  });
  it('exposes inspection failure independently of permission loading and clears it on deliberate retry', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    let offline = true;
    const actions: unknown[] = [];
    function Probe() {
      const host = usePluginHostApi();
      current = useLocalActRunFormV1({ accountId: 'account', mountId: 'inspection-recovery', seed, host,
        sharedScope, signal: renderer.signal });
      return null;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'inspection-recovery', mountNonce: 'inspection-recovery' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { readMachineDisplayName: async () => ({ status: 'unavailable' }),
        executeAction: async ({ action }): Promise<JsonValue> => {
          actions.push(action);
          if (typeof action !== 'object' || action.localId !== 'github/actions/local-inspect') throw new Error('Unexpected Action');
          if (offline) return { ok: false, errorCode: 'machine_offline' };
          return { workspace: seed.workspace, workflowPath: seed.workflowPath, workflows: [seed.workflowPath], secretRequirements: [],
            tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
            preferenceAddress: { serverId: 'home', refId: 'checkout' },
            preference: { status: 'ready', revision: 1, provenance: 'saved', preference: {
              enabled: false, allowAdHoc: false, unavailable: 'ask', scriptOverrides: {},
            } }, workflow: { events: ['push'], jobs: [] } };
        },
      },
    }); });
    mounted.push(fixture);
    expect.soft(current.inspectionError).toBe('machine_offline');
    expect(current.snapshot?.loading).toBe(false);
    const draft = current.snapshot!.selection;
    offline = false;
    await act(async () => { await current.controller!.inspect(); });
    expect.soft(current.inspectionError).toBeNull();
    expect(current.snapshot?.selection).toBe(draft);
    expect(current.snapshot?.inspection?.preference).toMatchObject({ status: 'ready', preference: { allowAdHoc: false } });
    expect(actions).toHaveLength(2);
  });
  it('keeps unfinished Advanced operands editable and clears optional values before any Run', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    const actions: unknown[] = [];
    const controls = hostRunBoundary(async () => { throw new Error('No host Run while editing'); });
    function Probe() {
      const host = usePluginHostApi();
      return <LocalActRunForm accountId="account" mountId="clearing-form" seed={seed} host={host}
        sharedScope={sharedScope} signal={renderer.signal}>{value => {
          current = value;
          return <LocalActRunFormView form={value} host={host} machineName={null} jobLabel={null} />;
        }}</LocalActRunForm>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'clearing-local-form', mountNonce: 'clearing-local-form' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { actionControl: controls.handler, readMachineDisplayName: async () => ({ status: 'unavailable' }),
        executeAction: async ({ action }) => {
          actions.push(action);
          if (typeof action === 'object' && action.localId === 'github/actions/local-inspect') return {
            workspace: seed.workspace, workflowPath: seed.workflowPath, workflows: [seed.workflowPath], secretRequirements: [],
            tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
            preferenceAddress: { serverId: 'home', refId: 'checkout' },
            preference: { status: 'ready', revision: 1, provenance: 'saved', preference: {
              enabled: false, allowAdHoc: true, unavailable: 'ask', scriptOverrides: {},
            } }, workflow: { events: ['push'], jobs: [] },
          };
          throw new Error(`Unexpected Action ${JSON.stringify(action)}`);
        },
      },
    }); });
    mounted.push(fixture);
    expect(current.snapshot?.selection).not.toHaveProperty('artifactServerPath');
    const advanced = (await fixture.getAllByRole('button')).find(control => control.name?.startsWith('Advanced'));
    if (!advanced) throw new Error('Missing Advanced control');
    await fixture.press(advanced);
    const edit = async (label: string, text: string) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
      if (!input) throw new Error(`Missing ${label} field`);
      const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
      await act(async () => { setValue.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
      expect((await fixture.getByRole('textbox', { label })).value).toBe(text);
    };
    // Partial operands must remain editable while the selection carries only parsed values.
    await edit('Variables', 'C');
    await edit('Variables', 'CI_SHARD=1\nC');
    await edit('Variables', 'CI_SHARD=1\nCI_TARGET=two');
    expect(current.snapshot?.selection.variables).toEqual([{ name: 'CI_SHARD', value: '1' }, { name: 'CI_TARGET', value: 'two' }]);
    await edit('Matrix', 'os:ubuntu-latest,');
    await edit('Matrix', 'os:ubuntu-latest,node:22');
    expect(current.snapshot?.selection.matrix).toEqual(['os:ubuntu-latest', 'node:22']);
    await act(async () => { current.controller!.setSelection({ ...current.controller!.getSnapshot().selection,
      variables: [{ name: 'CI_EXTERNAL', value: '3' }], matrix: ['node:24'] }); });
    expect((await fixture.getByRole('textbox', { label: 'Variables' })).value).toBe('CI_EXTERNAL=3');
    expect((await fixture.getByRole('textbox', { label: 'Matrix' })).value).toBe('node:24');
    await edit('Variables', '');
    await edit('Matrix', '');
    expect(current.snapshot?.selection).not.toHaveProperty('variables');
    expect(current.snapshot?.selection).not.toHaveProperty('matrix');
    await fixture.press(await fixture.getByRole('switch', { name: 'Artifacts' }));
    expect(current.snapshot?.selection.artifactServerPath).toBe('.happier/act-artifacts');
    await fixture.press(await fixture.getByRole('switch', { name: 'Artifacts' }));
    expect(current.snapshot?.selection).not.toHaveProperty('artifactServerPath');
    expect((await fixture.getByRole('switch', { name: 'Artifacts' })).state?.checked).toBe(false);
    expect(actions.filter(action => action === 'projects.compute.exec')).toHaveLength(0);
  });
  it('renders dependency and whole-workflow images and enables the existing Run again only after fresh settlement', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    const calls: { action: unknown; input: unknown }[] = [];
    const reads: unknown[] = [];
    const operation = { version: 1 as const, operationId: 'accepted-a', revision: 1,
      actionId: 'projects.compute.exec' as const, state: 'accepted' as const,
      scope: { accountId: 'account', machineId: 'custodian-a' }, title: 'Local command', createdAt: 1,
      cancellation: 'supported' as const,
      domainRef: { kind: 'projectCommand' as const, purpose: 'exec' as const, serverId: 'home',
        machineId: 'primary', workspaceRefId: 'checkout', cwd: '/repo' } };
    let observed: PluginUiActionOperationHostReadResultV1 = { operation, observation: 'available' };
    const content = () => {
      // The genuine host transport emits the owner's admitted receipt, not a type-only operation approximation.
      const bytes = new TextEncoder().encode(JSON.stringify(PluginUiActionOperationHostReadResultV1ProtocolSchema.parse(observed)));
      return { contentType: 'application/json', bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    const controls = hostRunBoundary(async input => {
      calls.push({ action: 'projects.compute.exec', input });
      const accepted = calls.filter(call => call.action === 'projects.compute.exec').length === 1
        ? operation : { ...operation, operationId: 'accepted-b', createdAt: 4 };
      observed = PluginUiActionOperationHostReadResultV1ProtocolSchema.parse({ operation: accepted, observation: 'available' });
      return { ok: true, result: { operation: accepted } };
    });
    function Probe() {
      const host = usePluginHostApi();
      return <LocalActRunForm accountId="account" mountId="observed-form" seed={{ ...seed, yamlJobId: 'test' }} host={host}
        sharedScope={sharedScope} signal={renderer.signal}>{value => {
          current = value;
          return <LocalActRunFormView form={value} host={host} machineName={value.snapshot?.machineDisplayName ?? null} jobLabel={null} />;
        }}</LocalActRunForm>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'observed-local-form', mountNonce: 'observed-local-form' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { actionControl: controls.handler, readMachineDisplayName: async () => ({ status: 'ready', displayName: 'Build box' }),
        readResource: async ({ resource }) => { reads.push(resource); return content(); },
        watchResource: async () => ({ digest: content().digest }),
        executeAction: async ({ action, input }): Promise<JsonValue> => {
          calls.push({ action, input });
          if (typeof action === 'object' && action.localId === 'github/actions/local-inspect') return {
            workspace: seed.workspace, workflowPath: seed.workflowPath, workflows: [seed.workflowPath], secretRequirements: [],
            tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
            preferenceAddress: { serverId: 'home', refId: 'checkout' },
            preference: { status: 'ready', revision: 1, provenance: 'saved', preference: {
              enabled: false, allowAdHoc: true, unavailable: 'ask', scriptOverrides: {},
            } }, workflow: { events: ['push'], jobs: [
              { id: 'build', needs: [], runsOn: ['ubuntu-24.04'] },
              { id: 'test', needs: ['build'], runsOn: ['ubuntu-latest'] },
              { id: 'lint', needs: [], runsOn: ['ubuntu-22.04'] },
            ] },
          };
          if (action === 'projects.compute.exec') throw new Error('Run must be a host-owned gesture');
          if (action === 'projects.execution.output.open') return { kind: 'opened' };
          throw new Error(`Unexpected Action ${JSON.stringify(action)}`);
        },
      },
    }); });
    mounted.push(fixture);
    expect(reads).toHaveLength(0);
    await fixture.getByRole('textbox', { label: 'Image for ubuntu-latest' });
    expect.soft(await fixture.queryByRole('textbox', { label: 'Image for ubuntu-24.04' })).toBeDefined();
    expect(await fixture.queryByRole('textbox', { label: 'Image for ubuntu-22.04' })).toBeUndefined();
    const wholeWorkflowSelection = { ...current.snapshot!.selection };
    delete wholeWorkflowSelection.yamlJobId;
    await act(async () => { current.controller!.setSelection(wholeWorkflowSelection); });
    expect.soft(await fixture.queryByRole('textbox', { label: 'Image for ubuntu-22.04' })).toBeDefined();
    await act(async () => { current.controller!.setSelection({ ...current.snapshot!.selection, architecture: 'linux/arm64',
      yamlJobId: 'test', platforms: [
        { label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' },
        { label: 'ubuntu-24.04', image: 'ghcr.io/example/build:reviewed' },
      ] }); });
    expect(controls.presentation('Run on Build box').disabled).not.toBe(true);
    expect(calls.filter(call => call.action === 'projects.compute.exec')).toHaveLength(0);
    await act(async () => { await controls.press('Run on Build box'); });
    const ref = { serverId: 'home', machineId: 'custodian-a', operationId: 'accepted-a' };
    const resource = { hostRead: 'action.operations.get' as const, input: ref };
    expect(reads).toContainEqual(resource);
    expect(current.snapshot?.operation?.state).toBe('accepted');
    expect.soft(current.operationStatus).toBe('accepted');
    expect.soft(await fixture.queryByText('Running on Build box')).toBeUndefined();
    expect(current.controller!.canRun()).toBe(false);
    expect(controls.presentation('Run again').disabled).toBe(true);
    observed = { operation: { ...operation, state: 'running', revision: 2, startedAt: 2 }, observation: 'available' };
    await act(async () => { fixture.invalidateResource(resource, content().digest); });
    expect.soft(current.operationStatus).toBe('running');
    await fixture.getByText('Running on Build box');
    observed = { operation: { ...operation, state: 'succeeded', revision: 3, startedAt: 2, settledAt: 3 }, observation: 'reconnecting' };
    await act(async () => { fixture.invalidateResource(resource, content().digest); });
    expect(current.snapshot?.operation?.state).toBe('succeeded');
    expect(current.snapshot?.operationObservation).toBe('reconnecting');
    expect.soft(current.operationStatus).toBe('reconnecting');
    expect.soft(await fixture.queryByText('Running on Build box')).toBeUndefined();
    expect(current.controller!.canRun()).toBe(false);
    expect(controls.presentation('Run again').disabled).toBe(true);
    const settled = current.snapshot?.operation;
    observed = { ...observed, observation: 'available' };
    await act(async () => { fixture.invalidateResource(resource, content().digest); });
    expect(current.snapshot?.operation).toBe(settled);
    expect.soft(current.operationStatus).toBe('succeeded');
    expect.soft(await fixture.queryByText('Running on Build box')).toBeUndefined();
    expect(current.controller!.canRun()).toBe(true);
    expect.soft(controls.presentation('Run again').disabled).not.toBe(true);
    expect(calls.filter(call => call.action === 'projects.compute.exec')).toHaveLength(1);
    await act(async () => { await current.controller!.openOutput(); });
    expect(calls.filter(call => call.action === 'projects.compute.exec')).toHaveLength(1);
    await act(async () => { await controls.press('Run again'); });
    expect(calls.filter(call => call.action === 'projects.compute.exec')).toHaveLength(2);
    expect(current.snapshot?.operationRef).toEqual({ ...ref, operationId: 'accepted-b' });
    expect(current.snapshot?.operation?.state).toBe('accepted');
    expect(controls.presentation('Run again').disabled).toBe(true);
    await act(async () => { renderer.abort(); });
    expect(current.controller).toBeNull();
    expect(() => controls.presentation('Run again')).toThrow('Missing host-rendered Action control');
  });
  it('retires the real form controller when its renderer ends without unmounting React', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    function Probe() {
      const host = usePluginHostApi();
      current = useLocalActRunFormV1({ accountId: 'account', mountId: 'retained-local-form', seed,
        host, sharedScope, signal: renderer.signal });
      return null;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'retained-local-form', mountNonce: 'retained-local-form' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readMachineDisplayName: async () => ({ status: 'unavailable' }),
        executeAction: async () => ({ kind: 'approval_request_created', artifactId: 'inspection-hold', actionId: 'github/actions/local-inspect' }),
      },
    }); });
    mounted.push(fixture);
    const controller = current.controller!;
    expect(await controller.invoke({ kind: 'readSelection' })).toMatchObject({ status: 'applied' });
    await act(async () => { renderer.abort(); });
    expect(await controller.invoke({ kind: 'readSelection' })).toEqual({ status: 'unavailable' });
    expect(await controller.invoke({ kind: 'setSelection', selection: {
      ...controller.getSnapshot().selection, architecture: 'linux/arm64',
    } })).toEqual({ status: 'unavailable' });
    expect(controller.getSnapshot().selection.architecture).toBe('');
  });
  it('exposes actual workflow choices and the selected job dependency mappings before host Run preparation', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    const calls: { action: unknown; input: unknown }[] = [];
    const unmappedSeed = { workspace: seed.workspace, target: seed.target };
    const workflowPath = '.github/workflows/dependencies.yml';
    function Probe() {
      const host = usePluginHostApi();
      current = useLocalActRunFormV1({ accountId: 'account', mountId: 'unmapped-mounted-id', seed: unmappedSeed, host, sharedScope,
        signal: renderer.signal });
      return null;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'unmapped-local-form', mountNonce: 'unmapped-local-form' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { readMachineDisplayName: async () => ({ status: 'unavailable' }),
        executeAction: async ({ action, input }) => {
          calls.push({ action, input });
          if (typeof action === 'object' && action.localId === 'github/actions/local-inspect') {
            const selected = typeof input === 'object' && input !== null && 'workflowPath' in input;
            return { workspace: seed.workspace, workflows: [workflowPath], secretRequirements: [],
              tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
              preferenceAddress: { serverId: 'home', refId: 'checkout' },
              preference: { status: 'ready', revision: 1, provenance: 'saved', preference: {
                enabled: false, allowAdHoc: true, unavailable: 'ask', scriptOverrides: {},
              } }, ...(selected ? { workflowPath, workflow: { events: ['push'], jobs: [
                { id: 'build', needs: [], runsOn: ['ubuntu-24.04'] },
                { id: 'test', needs: ['build'], runsOn: ['ubuntu-latest'] },
              ] } } : {}) };
          }
          throw new Error(`Unexpected Action ${JSON.stringify(action)}`);
        },
      },
    }); });
    mounted.push(fixture);
    expect(current.workflowChoices).toEqual([workflowPath]);
    expect(current.runnerRequirements).toBeNull();
    await act(async () => { current.controller!.setSelection({ ...current.snapshot!.selection, workflowPath }); });
    expect(current.runnerRequirements).toEqual({ kind: 'ready', labels: ['ubuntu-latest', 'ubuntu-24.04'] });
    const wholeWorkflow = current.runnerRequirements;
    await act(async () => { current.controller!.setSelection({ ...current.snapshot!.selection,
      yamlJobId: 'test', event: 'push', architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/test:reviewed' }] }); });
    expect(current.runnerRequirements).toEqual({ kind: 'ready', labels: ['ubuntu-latest', 'ubuntu-24.04'] });
    expect(current.controller!.canRun()).toBe(false);
    expect(calls.filter(call => call.action === 'projects.compute.exec')).toHaveLength(0);
    const selectedRequirements = current.runnerRequirements;
    await act(async () => { current.controller!.setSelection({ ...current.snapshot!.selection,
      platforms: [...current.snapshot!.selection.platforms, { label: 'ubuntu-24.04', image: 'ghcr.io/example/build:reviewed' }] }); });
    expect(current.runnerRequirements).toBe(selectedRequirements);
    expect(wholeWorkflow).toEqual(selectedRequirements);
    expect(current.controller!.canRun()).toBe(true);
    const prepared = await act(async () => await current.controller!.runControl.prepare({ signal: renderer.signal }));
    expect(prepared).toMatchObject({ input: { workspace: seed.workspace, argv: expect.arrayContaining([
        `--workflows=${workflowPath}`, '--job=test', '--platform=ubuntu-latest=ghcr.io/example/test:reviewed',
        '--platform=ubuntu-24.04=ghcr.io/example/build:reviewed',
      ]) } });
    expect(calls.filter(call => call.action === 'projects.compute.exec')).toHaveLength(0);
  });
  it('reads only the bound Machine and never applies a late receipt across address changes', async () => {
    const renderer = new AbortController();
    let current!: ReturnType<typeof useLocalActRunFormV1>;
    const reads: { request: Parameters<PluginUiHostApi['readMachineDisplayName']>[0];
      resolve(value: Awaited<ReturnType<PluginUiHostApi['readMachineDisplayName']>>): void }[] = [];
    function Probe() {
      const host = usePluginHostApi();
      current = useLocalActRunFormV1({ accountId: 'account', mountId: 'name-mounted-id', seed, host, sharedScope,
        signal: renderer.signal });
      return null;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'machine-name-probe', mountNonce: 'machine-name-probe' },
      authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
      surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readMachineDisplayName: ({ request }) => new Promise(resolve => { reads.push({ request, resolve }); }),
        // Only genuine host transports are substituted; no inspect/internal logic is mocked.
        executeAction: async () => ({ kind: 'approval_request_created', artifactId: 'inspect-hold', actionId: 'github/actions/local-inspect' }),
      },
    }); });
    mounted.push(fixture);
    expect(reads.map(read => read.request)).toEqual([{ serverId: 'home', machineId: 'primary' }]);
    await act(async () => { current.controller!.setSelection({ ...current.controller!.getSnapshot().selection,
      workspace: { ...seed.workspace, machineId: 'secondary' } }); });
    expect(current.snapshot?.machineDisplayName).toBeNull();
    await act(async () => { current.controller!.setSelection({ ...current.controller!.getSnapshot().selection,
      workspace: seed.workspace }); });
    expect(reads.map(read => read.request)).toEqual([
      { serverId: 'home', machineId: 'primary' }, { serverId: 'home', machineId: 'secondary' },
      { serverId: 'home', machineId: 'primary' },
    ]);
    await act(async () => { reads[0]!.resolve({ status: 'ready', displayName: 'Old primary name' });
      reads[1]!.resolve({ status: 'ready', displayName: 'Secondary name' }); });
    expect(current.snapshot?.machineDisplayName).toBeNull();
    await act(async () => { reads[2]!.resolve({ status: 'ready', displayName: 'Current primary name' }); });
    expect(current.snapshot?.machineDisplayName).toBe('Current primary name');
    await act(async () => { current.controller!.setSelection({ ...current.controller!.getSnapshot().selection,
      workspace: { ...seed.workspace, serverId: 'another-home' } }); });
    await act(async () => { reads[3]!.resolve({ status: 'unavailable' }); });
    expect(current.snapshot?.machineDisplayName).toBeNull();
  });
});
