import { describe, expect, it, vi } from 'vitest';

const targetPluginId = 'acme.targeted-contributions-conformance-target';
const contributorPluginId = 'acme.targeted-contributions-conformance-contributor';

type TargetAction = (input: unknown, context: unknown) => unknown | Promise<unknown>;

async function loadTargetAction(): Promise<TargetAction> {
  const fixture = await import(new URL('./daemon.mjs', import.meta.url).href);
  const activate = Reflect.get(fixture, 'activate');
  if (typeof activate !== 'function') throw new Error('Target fixture did not export activate');

  const actions = new Map<string, TargetAction>();
  await activate({
    actions: {
      register(actionId: string, handler: unknown) {
        if (typeof handler !== 'function') throw new Error(`Target fixture registered non-callable '${actionId}'`);
        actions.set(actionId, handler as TargetAction);
      },
    },
  });
  const action = actions.get('verify-targeted-admission');
  if (!action) throw new Error('Target fixture did not register its verification action');
  return action;
}

function contribution(handle: object, immutableGenerationId = 'contributor-generation-current') {
  return Object.freeze({
    contributor: Object.freeze({
      pluginId: contributorPluginId,
      contributionId: 'provider-a',
      immutableGenerationId,
    }),
    operations: Object.freeze({ verify: handle }),
  });
}

describe('targeted-contributions packed conformance target fixture', () => {
  it('executes the exact current opaque verify handle from the target-owned snapshot', async () => {
    const targetAction = await loadTargetAction();
    const signal = new AbortController().signal;
    const operation = Object.freeze({ opaque: 'current-operation' });
    const observation = {
      readCurrent: vi.fn(async () => Object.freeze({
        generation: 'target-generation-current',
        contributions: Object.freeze([contribution(operation)]),
      })),
      dispose: vi.fn(),
    };
    const observeForSelf = vi.fn(() => observation);
    const executeAdmittedTargetedOperation = vi.fn(async (
      actualOperation: object,
      input: unknown,
      options: unknown,
    ) => {
      expect(actualOperation).toBe(operation);
      expect(input).toEqual({});
      expect(options).toEqual({ signal });
      return Object.freeze({ verified: true });
    });

    await expect(targetAction({}, {
      signal,
      services: {
        targetedContributions: { observeForSelf },
        actions: { executeAdmittedTargetedOperation },
      },
    })).resolves.toEqual({
      targetGeneration: 'target-generation-current',
      contributors: [{
        pluginId: contributorPluginId,
        contributionId: 'provider-a',
        immutableGenerationId: 'contributor-generation-current',
      }],
      verifications: [{
        contributor: {
          pluginId: contributorPluginId,
          contributionId: 'provider-a',
          immutableGenerationId: 'contributor-generation-current',
        },
        result: { verified: true },
      }],
    });
    expect(observeForSelf).toHaveBeenCalledWith({
      targetPluginId,
      id: 'providers',
      protocol: { id: 'packed-targeted-provider', version: 1 },
    }, { onInvalidated: expect.any(Function) });
    expect(observation.dispose).toHaveBeenCalledOnce();
    expect(executeAdmittedTargetedOperation).toHaveBeenCalledOnce();
  });

  it('does not scan or invoke actions when the current target-owned snapshot is empty', async () => {
    const targetAction = await loadTargetAction();
    const signal = new AbortController().signal;
    const observation = {
      readCurrent: vi.fn(async () => Object.freeze({
        generation: 'target-generation-empty',
        contributions: Object.freeze([]),
      })),
      dispose: vi.fn(),
    };
    const executeAdmittedTargetedOperation = vi.fn();

    await expect(targetAction({}, {
      signal,
      services: {
        targetedContributions: { observeForSelf: vi.fn(() => observation) },
        actions: { executeAdmittedTargetedOperation },
      },
    })).resolves.toEqual({
      targetGeneration: 'target-generation-empty',
      contributors: [],
      verifications: [],
    });
    expect(executeAdmittedTargetedOperation).not.toHaveBeenCalled();
    expect(observation.dispose).toHaveBeenCalledOnce();
  });

  it('does not retry a stale exact handle or reuse it after a later target snapshot', async () => {
    const targetAction = await loadTargetAction();
    const signal = new AbortController().signal;
    const staleOperation = Object.freeze({ opaque: 'stale-operation' });
    const currentOperation = Object.freeze({ opaque: 'current-operation' });
    let reads = 0;
    const observation = {
      readCurrent: vi.fn(async () => {
        reads += 1;
        return Object.freeze({
          generation: reads === 1 ? 'target-generation-stale' : 'target-generation-current',
          contributions: Object.freeze([
            contribution(
              reads === 1 ? staleOperation : currentOperation,
              reads === 1 ? 'contributor-generation-stale' : 'contributor-generation-current',
            ),
          ]),
        });
      }),
      dispose: vi.fn(),
    };
    const stale = Object.assign(new Error('Targeted operation generation is stale'), {
      code: 'plugin_generation_stale',
    });
    const executeAdmittedTargetedOperation = vi.fn(async (operation: object) => {
      if (operation === staleOperation) throw stale;
      if (operation !== currentOperation) throw new Error('Unexpected replacement operation');
      return Object.freeze({ verified: true });
    });
    const context = {
      signal,
      services: {
        targetedContributions: { observeForSelf: vi.fn(() => observation) },
        actions: { executeAdmittedTargetedOperation },
      },
    };

    await expect(targetAction({}, context)).rejects.toBe(stale);
    await expect(targetAction({}, context)).resolves.toMatchObject({
      targetGeneration: 'target-generation-current',
      verifications: [{
        contributor: { immutableGenerationId: 'contributor-generation-current' },
        result: { verified: true },
      }],
    });
    expect(executeAdmittedTargetedOperation.mock.calls.map(([operation]) => operation)).toEqual([
      staleOperation,
      currentOperation,
    ]);
    expect(observation.dispose).toHaveBeenCalledTimes(2);
  });
});
