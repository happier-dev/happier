import { describe, expect, it, vi } from 'vitest';

import { createHostPluginSettingsActionInvoker } from './settingsActionInvoker.js';
import type { PluginSettingsActionDeclarationV2 } from './contributions/settings.js';
import type { JsonValue } from '../json/strictJsonValue.js';

function createError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const declaration: PluginSettingsActionDeclarationV2 = {
  id: 'discover',
  title: 'Discover',
  placement: { kind: 'afterField', fieldId: 'endpoint' },
  confirmation: {
    kind: 'required',
    title: 'Discover endpoint',
    description: 'Contact the provider?',
    confirmLabel: 'Discover',
  },
  patchFieldIds: ['endpoint'],
};

function nestedJson(depth: number): JsonValue {
  let value: JsonValue = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    value = { next: value };
  }
  return value;
}

describe('host-internal plugin settings action invoker', () => {
  it('passes the invocation context to the confirmation owner before it can present', async () => {
    const context = Object.freeze({ contributionId: 'voice-settings-action' });
    const confirm = vi.fn(async () => true);
    const invoker = createHostPluginSettingsActionInvoker<typeof context, void>({
      createError,
      confirm,
      snapshot: async () => ({ values: { endpoint: 'old' }, revision: '7' }),
      execute: async () => ({ patch: { endpoint: 'new' } }),
      applyPatch: async () => undefined,
    });

    await invoker.invoke({
      key: 'plugin/generation/contribution/discover',
      declaration,
      userGesture: true,
      signal: new AbortController().signal,
      isCurrent: () => true,
      context,
    });

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ context }));
  });

  it('owns gesture, confirmation, currentness, single-flight, bounds, and atomic apply ordering', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const invoker = createHostPluginSettingsActionInvoker({
      createError,
      confirm: vi.fn(async () => { order.push('confirm'); return true; }),
      snapshot: vi.fn(async () => {
        order.push('snapshot');
        return { values: { endpoint: 'old' }, revision: '7' };
      }),
      execute: vi.fn(async () => {
        order.push('execute');
        await pending;
        return { patch: { endpoint: 'new' } };
      }),
      applyPatch: vi.fn(async ({ patch }) => {
        order.push('apply');
        return patch;
      }),
    });
    const signal = new AbortController().signal;
    const input = {
      key: 'plugin/generation/contribution/discover',
      declaration,
      userGesture: true,
      signal,
      isCurrent: () => true,
      context: Object.freeze({ secretHandle: 'host-only' }),
    } as const;

    await expect(invoker.invoke({ ...input, userGesture: false }))
      .rejects.toMatchObject({ code: 'plugin_settings_action_user_gesture_required' });
    const first = invoker.invoke(input);
    await expect(invoker.invoke(input)).rejects.toMatchObject({ code: 'plugin_settings_action_busy' });
    release();
    await expect(first).resolves.toEqual({ endpoint: 'new' });
    expect(order).toEqual(['confirm', 'snapshot', 'execute', 'apply']);
  });

  it('rejects undeclared or oversized patches before the persistence port', async () => {
    const applyPatch = vi.fn();
    const execute = vi.fn()
      .mockResolvedValueOnce({ patch: { hidden: 'not declared' } })
      .mockResolvedValueOnce({ patch: { endpoint: 'x'.repeat(65_536) } });
    const invoker = createHostPluginSettingsActionInvoker({
      createError,
      confirm: async () => true,
      snapshot: async () => ({ values: {}, revision: '1' }),
      execute,
      applyPatch,
    });
    await expect(invoker.invoke({
      key: 'one', declaration, userGesture: true,
      signal: new AbortController().signal, isCurrent: () => true,
    })).rejects.toMatchObject({ code: 'plugin_settings_action_patch_field_forbidden' });
    await expect(invoker.invoke({
      key: 'two', declaration, userGesture: true,
      signal: new AbortController().signal, isCurrent: () => true,
    })).rejects.toMatchObject({ code: 'plugin_settings_action_patch_bounded' });
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it('accepts byte-small strict JSON patches beyond the retired generic depth limit', async () => {
    const deepPatchValue = nestedJson(128);
    const applyPatch = vi.fn(async ({ patch }: Readonly<{ patch: Readonly<Record<string, JsonValue>> }>) => patch);
    const invoker = createHostPluginSettingsActionInvoker({
      createError,
      confirm: async () => true,
      snapshot: async () => ({ values: {}, revision: '1' }),
      execute: async () => ({ patch: { endpoint: deepPatchValue } }),
      applyPatch,
    });

    await expect(invoker.invoke({
      key: 'deep', declaration, userGesture: true,
      signal: new AbortController().signal, isCurrent: () => true,
    })).resolves.toEqual({ endpoint: deepPatchValue });
    expect(applyPatch).toHaveBeenCalledWith(expect.objectContaining({
      patch: { endpoint: deepPatchValue },
    }));
  });

  it('does not apply a result after its generation becomes stale', async () => {
    let current = true;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const executing = new Promise<void>((resolve) => { entered = resolve; });
    const applyPatch = vi.fn();
    const invoker = createHostPluginSettingsActionInvoker({
      createError,
      confirm: async () => true,
      snapshot: async () => ({ values: {}, revision: '1' }),
      execute: async () => {
        entered();
        await pending;
        return { patch: { endpoint: 'https://stale.example' } };
      },
      applyPatch,
    });
    const invocation = invoker.invoke({
      key: 'stale', declaration, userGesture: true,
      signal: new AbortController().signal, isCurrent: () => current,
    });
    await executing;
    current = false;
    release();
    await expect(invocation).rejects.toMatchObject({
      code: 'plugin_settings_action_generation_retired',
    });
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it('retires an aborted reservation even when the provider ignores abort without letting stale settlement clear its replacement', async () => {
    let releaseStale!: () => void;
    let releaseReplacement!: () => void;
    let enteredStale!: () => void;
    let enteredReplacement!: () => void;
    const stalePending = new Promise<void>((resolve) => { releaseStale = resolve; });
    const replacementPending = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const staleEntered = new Promise<void>((resolve) => { enteredStale = resolve; });
    const replacementEntered = new Promise<void>((resolve) => { enteredReplacement = resolve; });
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) {
        enteredStale();
        await stalePending;
        return { patch: { endpoint: 'https://stale.example' } };
      }
      enteredReplacement();
      await replacementPending;
      return { patch: { endpoint: 'https://replacement.example' } };
    });
    const applyPatch = vi.fn(async ({ patch }) => patch);
    const invoker = createHostPluginSettingsActionInvoker({
      createError,
      confirm: async () => true,
      snapshot: async () => ({ values: {}, revision: '1' }),
      execute,
      applyPatch,
    });
    const staleController = new AbortController();
    const sharedInput = {
      key: 'same-provider-generation/action',
      declaration,
      userGesture: true,
      isCurrent: () => true,
    } as const;

    const staleInvocation = invoker.invoke({
      ...sharedInput,
      signal: staleController.signal,
    });
    await staleEntered;
    staleController.abort();

    const replacementInvocation = invoker.invoke({
      ...sharedInput,
      signal: new AbortController().signal,
    });
    const replacementAdmitted = await Promise.race([
      replacementEntered.then(() => true),
      replacementInvocation.then(() => false, () => false),
    ]);
    if (!replacementAdmitted) {
      releaseStale();
      await staleInvocation.catch(() => undefined);
      expect(replacementAdmitted).toBe(true);
      return;
    }

    releaseStale();
    await expect(staleInvocation).rejects.toMatchObject({
      code: 'plugin_settings_action_generation_retired',
    });
    await expect(invoker.invoke({
      ...sharedInput,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'plugin_settings_action_busy' });
    expect(applyPatch).not.toHaveBeenCalled();

    releaseReplacement();
    await expect(replacementInvocation).resolves.toEqual({
      endpoint: 'https://replacement.example',
    });
    expect(applyPatch).toHaveBeenCalledTimes(1);
  });

  it('rejects accessor-backed hostile results without invoking their getters', async () => {
    let getterObserved = false;
    const patch = Object.defineProperty({}, 'endpoint', {
      enumerable: true,
      get() { getterObserved = true; return 'stolen'; },
    });
    const invoker = createHostPluginSettingsActionInvoker({
      createError,
      confirm: async () => true,
      snapshot: async () => ({ values: {}, revision: '1' }),
      execute: async () => ({ patch } as never),
      applyPatch: vi.fn(),
    });
    await expect(invoker.invoke({
      key: 'hostile', declaration, userGesture: true,
      signal: new AbortController().signal, isCurrent: () => true,
    })).rejects.toMatchObject({ code: 'plugin_settings_action_result_invalid' });
    expect(getterObserved).toBe(false);
  });

  it('projects canonical strict-JSON rejections into the existing settings-action error', async () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    class NonPlainJson {
      readonly value = 'not-plain';
    }

    for (const value of [new NonPlainJson(), sparse, cycle, undefined]) {
      const invoker = createHostPluginSettingsActionInvoker({
        createError,
        confirm: async () => true,
        snapshot: async () => ({ values: {}, revision: '1' }),
        execute: async () => ({ patch: { endpoint: value } } as never),
        applyPatch: vi.fn(),
      });
      await expect(invoker.invoke({
        key: `invalid-${typeof value}`, declaration, userGesture: true,
        signal: new AbortController().signal, isCurrent: () => true,
      })).rejects.toMatchObject({ code: 'plugin_settings_action_result_invalid' });
    }
  });
});
