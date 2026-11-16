import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserCommandV1 } from '@happier-dev/protocol';

import {
  browserCommandDispatchFailure,
  type BrowserDaemonControlAdapter,
  type BrowserDaemonControlBroker,
  type BrowserCommandScope,
} from './types';

function invalidAdapterResultFailure(
  adapter: BrowserDaemonControlAdapter,
  command: BrowserCommandV1,
  message: string,
) {
  return browserCommandDispatchFailure({
    commandId: command.commandId,
    adapterKind: adapter.adapterKind,
    code: 'adapter_unavailable',
    message,
  });
}

function normalizeAdapterResult(
  adapter: BrowserDaemonControlAdapter,
  command: BrowserCommandV1,
  rawResult: unknown,
) {
  const parsed = BrowserCommandDispatchResultV1Schema.safeParse(rawResult);
  if (parsed.success) {
    const result = parsed.data;
    if (result.commandId !== command.commandId) {
      return invalidAdapterResultFailure(
        adapter,
        command,
        'Browser control adapter returned a result for a different command.',
      );
    }
    if (typeof result.adapterKind !== 'undefined' && result.adapterKind !== adapter.adapterKind) {
      return invalidAdapterResultFailure(
        adapter,
        command,
        'Browser control adapter returned a result for a different adapter kind.',
      );
    }
    return result;
  }

  return browserCommandDispatchFailure({
    commandId: command.commandId,
    adapterKind: adapter.adapterKind,
    code: 'adapter_unavailable',
    message: 'Browser control adapter returned an invalid command result.',
  });
}

export function createBrowserDaemonControlBroker(): BrowserDaemonControlBroker {
  const adapters = new Set<BrowserDaemonControlAdapter>();
  const viewListeners = new Set<Readonly<{ browserSessionId: string; check: (bindingChanged?: boolean) => void }>>();
  let hasRegisteredAdapter = false;

  const listViews = (browserSessionId: string, scope?: BrowserCommandScope) =>
    [...adapters].flatMap(adapter => adapter.listViews?.(browserSessionId, scope) ?? []);
  const notify = (browserSessionId?: string) => {
    for (const listener of viewListeners) {
      if (!browserSessionId || listener.browserSessionId === browserSessionId) listener.check(Boolean(browserSessionId));
    }
  };

  function registerAdapter(adapter: BrowserDaemonControlAdapter): () => void {
    adapters.add(adapter);
    hasRegisteredAdapter = true;
    const unsubscribe = adapter.subscribeViewLifecycle?.(event => notify(event.browserSessionId));
    notify();
    return () => {
      unsubscribe?.();
      adapters.delete(adapter);
      notify();
    };
  }

  async function dispatchCommand(command: BrowserCommandV1, scope?: BrowserCommandScope) {
    if (adapters.size === 0) {
      return browserCommandDispatchFailure({
        commandId: command.commandId,
        code: hasRegisteredAdapter ? 'view_not_found' : 'adapter_unavailable',
        message: hasRegisteredAdapter
          ? 'No registered Browser daemon adapter owns this view.'
          : 'No Browser daemon control adapter is registered.',
      });
    }

    if (command.kind === 'openView') {
      const adapter = Array.from(adapters).find((candidate) => candidate.supportsOpenView(command));
      if (!adapter) {
        return browserCommandDispatchFailure({
          commandId: command.commandId,
          code: 'adapter_unavailable',
          completion: 'known',
          message: 'No Browser daemon adapter can open this target. Open workspace-owned targets with browser.workspace.open; a mounted Browser pane is not required.',
        });
      }
      return normalizeAdapterResult(adapter, command, await adapter.dispatchCommand(command, scope));
    }

    const adapter = Array.from(adapters).find((candidate) => candidate.ownsView({
      browserSessionId: command.browserSessionId,
      viewId: command.viewId,
    }));
    if (!adapter) {
      return browserCommandDispatchFailure({
        commandId: command.commandId,
        code: 'view_not_found',
        message: 'No registered Browser daemon adapter owns this view.',
      });
    }

    return normalizeAdapterResult(adapter, command, await adapter.dispatchCommand(command, scope));
  }

  return {
    registerAdapter,
    dispatchCommand,
    async replaceProfile(command, scope) {
      const adapter = [...adapters].find(candidate => candidate.ownsView(command));
      if (!adapter) return browserCommandDispatchFailure({ commandId: command.commandId,
        code: 'view_not_found', message: 'No registered Browser daemon adapter owns this view.' });
      if (!adapter.replaceProfile) return browserCommandDispatchFailure({ commandId: command.commandId,
        code: 'unsupported_command', message: 'This Browser runtime cannot replace profiles.' });
      return normalizeAdapterResult(adapter, command, await adapter.replaceProfile(command, scope));
    },
    ownsView: (view) => [...adapters].some(adapter => adapter.ownsView(view)),
    hasExecutableAdapters: () => adapters.size > 0,
    listViews,
    getCommandAccessFailure(command, scope) {
      for (const adapter of adapters) {
        if ('kind' in command && !(command.kind === 'openView'
          ? adapter.supportsOpenView(command) : adapter.ownsView(command))) continue;
        const failure = adapter.getCommandAccessFailure?.(command, scope);
        if ('kind' in command) return failure;
        if (failure) return failure;
      }
      return undefined;
    },
    watchViews: ({ browserSessionId, knownViewIds, signal, scope }) => new Promise<void>(resolve => {
      const known = new Set(knownViewIds);
      const settle = () => {
        viewListeners.delete(listener);
        signal?.removeEventListener('abort', settle);
        resolve();
      };
      // A retained logical view can acquire a new native capture occurrence. Wake on
      // the owner's lifecycle push even when membership stays equal; discovery reads
      // the projection after synchronous lifecycle listeners publish capture readiness.
      const listener = { browserSessionId, check: (bindingChanged = false) => {
        if (bindingChanged) { settle(); return; }
        const views = listViews(browserSessionId, scope);
        if (views.length !== known.size || views.some(view => !known.has(view.viewId))) settle();
      } };
      viewListeners.add(listener);
      signal?.addEventListener('abort', settle, { once: true });
      if (signal?.aborted) settle();
      else listener.check();
    }),
  };
}
