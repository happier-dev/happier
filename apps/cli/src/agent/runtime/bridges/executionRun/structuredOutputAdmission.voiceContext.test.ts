import { describe, expect, it } from 'vitest';
import { readExecutionRunOfferedModel } from './structuredOutputAdmission';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

describe('Voice selected-model context fact', () => {
  it('probes native models in each hosted Session directory when cwd is omitted', async () => {
    const directories: string[] = [];
    await Promise.all(['/work/session-a', '/work/session-b'].map(workingDirectory =>
      runAddedHostedSession({ environment: {}, workingDirectory, end: () => {} }, () =>
        readExecutionRunOfferedModel({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          modelId: 'native-model', readNativeOfferedModel: async request => {
            directories.push(request.cwd);
            return { id: 'native-model', name: 'Native model' };
          } }))));
    expect(directories.sort()).toEqual(['/work/session-a', '/work/session-b']);
  });

  it.each([undefined, 32_768])('reads only the prepared Provider model fact (window: %s)', async contextWindowTokens => {
    const backendTarget = { kind: 'builtInAgent' as const, agentId: 'codex' };
    const model = { id: 'catalog-model', name: 'Catalog model',
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }) };
    const params = { backendTarget, modelId: model.id,
      modelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'connection', modelId: model.id }),
      prepared: { providerBinding: { model } } };
    expect(await readExecutionRunOfferedModel(params)).toEqual(model);
  });

  it('keeps the native catalog as the native model fact owner', async () => {
    const model = { id: 'native-model', name: 'Native model', contextWindowTokens: 65_536 };
    expect(await readExecutionRunOfferedModel({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      modelId: model.id, readNativeOfferedModel: async () => model })).toEqual(model);
  });

  it('cancels a pending catalog read instead of accepting its late model reply', async () => {
    const controller = new AbortController();
    const model = { id: 'native-model', name: 'Native model', contextWindowTokens: 65_536 };
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let reply!: (value: typeof model) => void;
    const nativeReply = new Promise<typeof model>(resolve => { reply = resolve; });
    const params = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' }, modelId: model.id,
      signal: controller.signal,
      readNativeOfferedModel: async (_request: unknown, signal?: AbortSignal) => {
        entered();
        return await new Promise<typeof model>((resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
          void nativeReply.then(value => {
            signal?.removeEventListener('abort', abort);
            resolve(value);
          });
        });
      } };
    const outcome = expect(readExecutionRunOfferedModel(params)).rejects.toMatchObject({ name: 'AbortError' });
    await reading;
    controller.abort(new DOMException('Cancelled catalog read', 'AbortError'));
    reply(model);
    await outcome;
  });
});
