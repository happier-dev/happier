import * as React from 'react';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, type PluginUiTestkitOptions } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';

/** The real SDK transport/controller, with only the physical host and Action executor replaced. */
export async function createTaskActionControlTestkit(options: PluginUiTestkitOptions<ReturnType<typeof defineUiSurface>>) {
  const rawTaskWrites: string[] = [];
  // This external executor fixture does not simulate cancellation or request correlation.
  const executorSignal = new AbortController().signal;
  const controls = createPluginUiActionControlTestHost(async request => {
    try {
      const result = await options.handlers?.executeAction?.({ ...request, signal: executorSignal, requestId: 'test-host-gesture' });
      return { ok: true, result };
    } catch (error) {
      const code = error instanceof PluginError ? error.code : 'internal_error';
      return { ok: false, errorCode: code, error: code };
    }
  });
  function HostSlot() {
    const slots = React.useSyncExternalStore(controls.subscribe, controls.getSnapshot, controls.getSnapshot);
    return <>{slots.map(({ id, presentation }) => <Button key={id}
      title={presentation.title} accessibilityLabel={presentation.accessibilityLabel ?? presentation.title}
      disabled={presentation.disabled} variant={presentation.variant}
      onPress={() => controls.pressById(id)} />)}</>;
  }
  const fixture = await createPluginUiTestkit({ ...options,
    surface: context => {
      const root = options.surface(context);
      if (!React.isValidElement<{ children?: React.ReactNode }>(root)) throw new Error('Expected the public UI surface provider.');
      return React.cloneElement(root, undefined, <>{root.props.children}<HostSlot /></>);
    },
    handlers: { ...options.handlers,
      actionControl: controls.handler,
      executeAction: async invocation => {
        if (typeof invocation.action === 'string' && ['tasks/create-v1', 'tasks/edit-v1', 'tasks/transition-v1', 'tasks/set-origin-error-v1', 'tasks.internal.labels.setColor', 'tasks.internal.labels.clearColor'].includes(invocation.action)) rawTaskWrites.push(invocation.action);
        return await options.handlers?.executeAction?.(invocation) ?? null;
      },
    },
  });
  return { ...fixture, rawTaskWrites };
}
