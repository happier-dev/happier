import { BrowserCommandDispatchResultV1Schema, BrowserCommandV1Schema, BrowserDaemonViewV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserCommandDispatchResultV1, BrowserCommandV1, BrowserDaemonViewV1, BrowserEventV1, ActionExecutorContext } from '@happier-dev/protocol';

import {
  browserCommandDispatchFailure,
  type BrowserDaemonControlBroker,
  isBrowserDaemonControlAdapterKind,
} from './types';
import type { MachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import type { BrowserAutomationDaemonService } from '../automation/service';

export type BrowserDaemonControlRoutes = Readonly<{
  dispatchCommand(command: unknown, context?: Pick<ActionExecutorContext, 'authority' | 'bypassApprovals'>): Promise<BrowserCommandDispatchResultV1>;
  listViews(browserSessionId: string): readonly BrowserDaemonViewV1[];
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
  broker: Pick<BrowserDaemonControlBroker, 'dispatchCommand'> & Partial<Pick<BrowserDaemonControlBroker, 'listViews'>>;
  captureRegistry?: Pick<MachineLiveStreamCaptureRegistry, 'resolve'>;
  automation?: () => BrowserAutomationDaemonService | null;
}>): BrowserDaemonControlRoutes {
  async function dispatchToBroker(command: BrowserCommandV1): Promise<BrowserCommandDispatchResultV1> {
    const result = await input.broker.dispatchCommand(command);
    const parsed = BrowserCommandDispatchResultV1Schema.safeParse(result);
    if (!parsed.success || parsed.data.commandId !== command.commandId) return invalidBrokerResult(command.commandId);
    if (typeof parsed.data.adapterKind !== 'undefined' && !isBrowserDaemonControlAdapterKind(parsed.data.adapterKind)) {
      return invalidBrokerResult(command.commandId);
    }
    return parsed.data;
  }

  return {
    listViews(browserSessionId) {
      return (input.broker.listViews?.(browserSessionId) ?? []).map(view => {
        const source = input.captureRegistry?.resolve({ sourceId: view.sourceId, streamFamily: 'browser.streamed' });
        return BrowserDaemonViewV1Schema.parse({ ...view, ...(source?.ok ? { captureSource: source.source.capabilities } : {}) });
      });
    },
    async dispatchCommand(rawCommand, context) {
      const command = BrowserCommandV1Schema.safeParse(rawCommand);
      if (!command.success) {
        return browserCommandDispatchFailure({
          commandId: readCommandId(rawCommand),
          code: 'command_malformed',
          message: 'Browser command payload failed protocol validation.',
        });
      }

      // Focus and other control Actions can otherwise bypass automation admission. A retained
      // confidential view accepts only verified human control, regardless of approval bypass.
      if (context?.authority !== 'present_user' && input.automation?.()?.getInputControl(command.data).isObservationHeld()) {
        return browserCommandDispatchFailure({ commandId: command.data.commandId,
          code: 'permission_denied', message: 'Browser observation is confidential.' });
      }

      if (command.data.kind === 'takeControl' || command.data.kind === 'handBack') {
        const fail = (code: 'permission_denied' | 'adapter_unavailable' | 'view_not_found', message: string) =>
          browserCommandDispatchFailure({ commandId: command.data.commandId, code, message });
        if (context?.authority !== 'present_user'
          && !(context?.authority === 'account_automation' && context.bypassApprovals === true)) {
          return fail('permission_denied', 'Controller commands require human authority or host policy admission.');
        }
        const view = input.broker.listViews?.(command.data.browserSessionId).find(candidate => candidate.viewId === command.data.viewId);
        if (!view) return fail('view_not_found', 'No registered Browser daemon adapter owns this view.');
        const automation = input.automation?.();
        if (!automation) return fail('adapter_unavailable', 'Browser automation runtime is unavailable.');
        const events: BrowserEventV1[] = [];
        const unsubscribe = automation.subscribeBrowserEvents(event => {
          if (event.browserSessionId === view.browserSessionId && 'viewId' in event && event.viewId === view.viewId) events.push(event);
        });
        try {
          const authority = { browserSessionId: view.browserSessionId, viewId: view.viewId,
            ...(context.authority === 'present_user' ? { authority: 'present_user' as const }
              : { authority: 'account_automation' as const, bypassApprovals: true as const }) };
          if (command.data.kind === 'takeControl') await automation.recordHumanInput(authority);
          else if (!automation.handBack(authority).ok) return fail('adapter_unavailable', 'The interrupted browser action is still settling.');
          return BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: command.data.commandId,
            status: 'dispatched', adapterKind: view.adapterKind, events });
        } finally { unsubscribe(); }
      }

      if ((context?.authority === 'present_user' || context?.authority === 'account_automation') && (
        command.data.kind === 'navigate' || command.data.kind === 'goBack' || command.data.kind === 'goForward'
        || command.data.kind === 'reload' || command.data.kind === 'stop' || command.data.kind === 'focusView'
      )) {
        const automation = input.automation?.();
        if (automation) {
          const view = input.broker.listViews?.(command.data.browserSessionId).find(candidate => candidate.viewId === command.data.viewId);
          if (!view) return browserCommandDispatchFailure({ commandId: command.data.commandId,
            code: 'view_not_found', message: 'No registered Browser daemon adapter owns this view.' });
          const events: BrowserEventV1[] = [];
          const unsubscribe = automation.subscribeBrowserEvents(event => {
            if (event.browserSessionId === view.browserSessionId && 'viewId' in event && event.viewId === view.viewId) events.push(event);
          });
          try {
            const execution = await automation.executeControlCommand(view, context.authority, () => dispatchToBroker(command.data));
            if (!execution.ok) return browserCommandDispatchFailure({ commandId: command.data.commandId,
              code: 'permission_denied', message: `Browser input controller refused the command: ${execution.errorCode}.` });
            const result = execution.value;
            return result.status === 'dispatched' ? { ...result, events: [...events, ...result.events] } : result;
          } finally { unsubscribe(); }
        }
        if (context.authority === 'account_automation') return browserCommandDispatchFailure({ commandId: command.data.commandId,
          code: 'adapter_unavailable', message: 'Browser input controller is unavailable.' });
      }
      return dispatchToBroker(command.data);
    },
  };
}
