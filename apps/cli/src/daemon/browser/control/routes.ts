import { BrowserCommandDispatchResultV1Schema, BrowserCommandV1Schema, BrowserDaemonViewV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserCommandDispatchResultV1, BrowserCommandV1, BrowserDaemonViewV1, BrowserEventV1, ActionExecutorContext } from '@happier-dev/protocol';

import {
  browserCommandDispatchFailure,
  browserCommandScope,
  type BrowserDaemonControlBroker,
} from './types';
import type { MachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import type { BrowserAutomationDaemonService } from '../automation/service';
import type { createBrowserProfileCookieImporter } from '../profiles/importCookies';
import type { BrowserProfilePasskeyActivation } from '../profiles/passkeys';
import type { BrowserProfileLoginsImportResultV1 } from '@happier-dev/protocol/browser/profile/v1';
import type { BrowserExtensionService } from '../extensions/service';

type ImportPasskeys = (input: BrowserProfilePasskeyActivation) => Promise<BrowserProfileLoginsImportResultV1>;

export type BrowserDaemonControlRoutes = Readonly<{
  dispatchCommand(command: unknown, context?: NonNullable<Parameters<typeof browserCommandScope>[0]> & Pick<ActionExecutorContext, 'authority'>): Promise<BrowserCommandDispatchResultV1>;
  listViews(browserSessionId: string): readonly BrowserDaemonViewV1[];
  importCookies?: ReturnType<typeof createBrowserProfileCookieImporter>;
  importPasskeys?: ImportPasskeys;
  extensions?: BrowserExtensionService;
}>;

function readCommandId(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
  const commandId = (input as Record<string, unknown>).commandId;
  const trimmedCommandId = typeof commandId === 'string' ? commandId.trim() : '';
  return trimmedCommandId.length > 0 && trimmedCommandId.length <= 256 ? trimmedCommandId : 'unknown';
}

export function createBrowserDaemonControlRoutes(input: Readonly<{
  broker: Pick<BrowserDaemonControlBroker, 'dispatchCommand'> & Partial<Pick<BrowserDaemonControlBroker, 'listViews'>>;
  captureRegistry?: Pick<MachineLiveStreamCaptureRegistry, 'resolve'>;
  automation?: () => BrowserAutomationDaemonService | null;
  importCookies?: ReturnType<typeof createBrowserProfileCookieImporter>;
  importPasskeys?: ImportPasskeys;
  extensions?: BrowserExtensionService;
}>): BrowserDaemonControlRoutes {
  async function dispatchToBroker(command: BrowserCommandV1, context?: Parameters<BrowserDaemonControlRoutes['dispatchCommand']>[1]): Promise<BrowserCommandDispatchResultV1> {
    return input.broker.dispatchCommand(command, browserCommandScope(context));
  }

  return {
    ...(input.importCookies ? { importCookies: input.importCookies } : {}),
    ...(input.importPasskeys ? { importPasskeys: input.importPasskeys } : {}),
    ...(input.extensions ? { extensions: input.extensions } : {}),
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
      if (context?.signal?.aborted) {
        return browserCommandDispatchFailure({ commandId: command.data.commandId,
          code: 'adapter_unavailable', message: 'Browser control request was cancelled.', completion: 'known' });
      }

      if (command.data.kind === 'takeControl' || command.data.kind === 'handBack') {
        const fail = (code: 'permission_denied' | 'adapter_unavailable' | 'view_not_found', message: string) =>
          browserCommandDispatchFailure({ commandId: command.data.commandId, code, message });
        if (!context?.authority) return fail('permission_denied', 'Controller commands require authenticated authority.');
        const view = input.broker.listViews?.(command.data.browserSessionId).find(candidate => candidate.viewId === command.data.viewId);
        if (!view) return fail('view_not_found', 'No registered Browser daemon adapter owns this view.');
        const automation = input.automation?.();
        if (!automation) return fail('adapter_unavailable', 'Browser automation runtime is unavailable.');
        if (automation.getInputControl(command.data).getObservationFailure(context.authority === 'present_user' ? 'human' : 'agent')) {
          return fail('permission_denied', 'Browser observation is unavailable.');
        }
        const events: BrowserEventV1[] = [];
        const unsubscribe = automation.subscribeBrowserEvents(event => {
          if (event.browserSessionId === view.browserSessionId && 'viewId' in event && event.viewId === view.viewId) events.push(event);
        });
        try {
          const authority = { browserSessionId: view.browserSessionId, viewId: view.viewId, authority: context.authority };
          if (command.data.kind === 'takeControl') await automation.recordHumanInput(authority);
          else if (!(await automation.handBack(authority)).ok) return fail('adapter_unavailable', 'Browser input is still settling. Retry hand back.');
          return BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: command.data.commandId,
            status: 'dispatched', adapterKind: view.adapterKind, events });
        } finally { unsubscribe(); }
      }

      if (command.data.kind === 'focusView' || ((context?.authority === 'present_user' || context?.authority === 'account_automation') && (
        command.data.kind === 'navigate' || command.data.kind === 'goBack' || command.data.kind === 'goForward'
        || command.data.kind === 'reload' || command.data.kind === 'stop' || command.data.kind === 'setViewport'
        || command.data.kind === 'setTarget'
      ))) {
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
            const execution = await automation.executeControlCommand(command.data,
              context?.authority === 'present_user' ? 'present_user' : 'account_automation',
              () => dispatchToBroker(command.data, context));
            if (!execution.ok) return browserCommandDispatchFailure({ commandId: command.data.commandId,
              code: 'permission_denied', message: `Browser input controller refused the command: ${execution.errorCode}.` });
            const result = execution.value;
            return result.status === 'dispatched' ? { ...result, events: [...events, ...result.events] } : result;
          } finally { unsubscribe(); }
        }
        if (context?.authority === 'account_automation') return browserCommandDispatchFailure({ commandId: command.data.commandId,
          code: 'adapter_unavailable', message: 'Browser input controller is unavailable.' });
      }
      if (input.automation?.()?.getInputControl(command.data).getObservationFailure(context?.authority === 'present_user' ? 'human' : 'agent')) {
        return browserCommandDispatchFailure({ commandId: command.data.commandId,
          code: 'permission_denied', message: 'Browser observation is unavailable.' });
      }
      return dispatchToBroker(command.data, context);
    },
  };
}
