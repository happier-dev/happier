import type { PluginUiTestkitHostHandlers } from './uiHost.js';
import type { PluginUiActionControlExecution } from '../ui/index.js';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';

type Handler = NonNullable<PluginUiTestkitHostHandlers['actionControl']>;
type HostInput = Parameters<Handler>[0];
type Bind = Extract<HostInput['request'], { kind: 'bind' }>;
type SlotControl = Readonly<{ id: string; presentation: Readonly<Bind['presentation']> }>;
type Binding = { action: Bind['action']; presentation: Bind['presentation']; publish: HostInput['publish'];
  resolve?: () => void; reject?: (error: unknown) => void };

/** Installed host gesture/executor boundary; the SDK transport and author controller remain real. */
export function createPluginUiActionControlTestHost(execute: (request: Readonly<{
  action: Bind['action']; input: NonNullable<Extract<HostInput['request'], { kind: 'prepared' }>['preparation']>['input'];
}>) => Promise<PluginUiActionControlExecution>) {
  const bindings = new Map<string, Binding>();
  const listeners = new Set<() => void>();
  let snapshot: readonly SlotControl[] = Object.freeze([]);
  const publishSnapshot = () => {
    snapshot = Object.freeze([...bindings].map(([id, binding]) => Object.freeze({ id, presentation: binding.presentation })));
    for (const listener of listeners) listener();
  };
  let gestures = 0;
  const handler: Handler = async ({ request, publish }) => {
    if (request.kind === 'bind') {
      bindings.set(request.subscriptionId, { action: request.action, presentation: Object.freeze({ ...request.presentation }), publish });
      publishSnapshot();
      return { dispose: () => { if (bindings.delete(request.subscriptionId)) publishSnapshot(); } };
    }
    const binding = bindings.get(request.subscriptionId);
    if (!binding) throw new Error('Retired host control');
    if (request.kind === 'update') {
      if (!pluginJsonValuesEqual(binding.presentation, request.presentation)) {
        binding.presentation = Object.freeze({ ...request.presentation });
        publishSnapshot();
      }
      return;
    }
    try {
      const execution = request.preparation
        ? await execute({ input: request.preparation.input, action: binding.action }) : undefined;
      if (execution) publish({ kind: 'settled', requestId: request.requestId, execution });
      binding.resolve?.();
      return execution;
    } catch (error) { binding.reject?.(error); throw error; }
    finally { delete binding.resolve; delete binding.reject; }
  };
  const find = (title: string) => [...bindings].find(([, value]) => value.presentation.title === title);
  const pressById = async (id: string) => {
    const binding = bindings.get(id);
    if (!binding) throw new Error('Missing host-rendered Action control: ' + id);
    if (binding.presentation.disabled) throw new Error('Disabled host-rendered Action control: ' + id);
    await new Promise<void>((resolve, reject) => {
      binding.resolve = resolve; binding.reject = reject;
      binding.publish({ kind: 'prepare', requestId: 'host-gesture-' + ++gestures });
    });
  };
  return { handler, getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    presentation(title: string) { return find(title)?.[1].presentation; },
    async press(title: string) {
      const entry = find(title);
      if (!entry) throw new Error('Missing host-rendered Action control: ' + title);
      await pressById(entry[0]);
    },
    pressById,
  };
}
