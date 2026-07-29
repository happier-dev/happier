import {
  BrowserCommandDispatchResultV1Schema,
  BrowserCommandV1Schema,
  type BrowserCommandDispatchResultV1,
} from '@happier-dev/protocol';

import {
  browserCommandDispatchFailure,
  type BrowserDaemonControlBroker,
  isBrowserDaemonControlAdapterKind,
} from './types';

export type BrowserDaemonControlRoutes = Readonly<{
  dispatchCommand(command: unknown): Promise<BrowserCommandDispatchResultV1>;
}>;

function readCommandId(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
  const commandId = (input as Record<string, unknown>).commandId;
  const trimmedCommandId = typeof commandId === 'string' ? commandId.trim() : '';
  return trimmedCommandId.length > 0 && trimmedCommandId.length <= 256 ? trimmedCommandId : 'unknown';
}

function invalidBrokerResult(commandId: string): BrowserCommandDispatchResultV1 {
  return browserCommandDispatchFailure({
    commandId,
    code: 'adapter_unavailable',
    message: 'Browser control broker returned an invalid command result.',
  });
}

export function createBrowserDaemonControlRoutes(input: Readonly<{
  broker: Pick<BrowserDaemonControlBroker, 'dispatchCommand'>;
}>): BrowserDaemonControlRoutes {
  return {
    async dispatchCommand(rawCommand) {
      const command = BrowserCommandV1Schema.safeParse(rawCommand);
      if (!command.success) {
        return browserCommandDispatchFailure({
          commandId: readCommandId(rawCommand),
          code: 'command_malformed',
          message: 'Browser command payload failed protocol validation.',
        });
      }

      const result = await input.broker.dispatchCommand(command.data);
      const parsed = BrowserCommandDispatchResultV1Schema.safeParse(result);
      if (!parsed.success) return invalidBrokerResult(command.data.commandId);
      if (parsed.data.commandId !== command.data.commandId) {
        return invalidBrokerResult(command.data.commandId);
      }
      if (
        typeof parsed.data.adapterKind !== 'undefined'
        && !isBrowserDaemonControlAdapterKind(parsed.data.adapterKind)
      ) {
        return invalidBrokerResult(command.data.commandId);
      }

      return parsed.data;
    },
  };
}
