import {
  BrowserCommandDispatchResultV1Schema,
  type BrowserCommandV1,
} from '@happier-dev/protocol';

import {
  browserCommandDispatchFailure,
  type BrowserDaemonControlAdapter,
  type BrowserDaemonControlBroker,
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
  let hasRegisteredAdapter = false;

  function registerAdapter(adapter: BrowserDaemonControlAdapter): () => void {
    adapters.add(adapter);
    hasRegisteredAdapter = true;
    return () => {
      adapters.delete(adapter);
    };
  }

  async function dispatchCommand(command: BrowserCommandV1) {
    if (command.kind === 'createSession' || command.kind === 'closeSession') {
      return browserCommandDispatchFailure({
        commandId: command.commandId,
        code: 'unsupported_command',
        message: 'Browser session commands do not have a daemon control owner.',
      });
    }

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
          code: 'unsupported_command',
          message: 'No Browser daemon control adapter supports this openView command.',
        });
      }
      return normalizeAdapterResult(adapter, command, await adapter.dispatchCommand(command));
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

    return normalizeAdapterResult(adapter, command, await adapter.dispatchCommand(command));
  }

  return {
    registerAdapter,
    dispatchCommand,
    hasExecutableAdapters: () => adapters.size > 0,
  };
}
