import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

const execute = createFrontDoorActionExecute();
type ExternalUrlOptions = Readonly<{ signal?: AbortSignal; serverId?: string; expectedAccountId?: string }>;

/** Keep the Action's refusal when the calling surface presents its own outcome. */
export function requestOpenExternalUrlResult(url: string, options?: ExternalUrlOptions): Promise<ActionExecuteResult> {
  return execute('links.openExternal', { url: url.trim() }, {
    surface: 'ui', actionCaller: { kind: 'host' },
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.serverId ? { serverId: options.serverId } : {}),
    ...(options?.expectedAccountId ? { expectedAccountId: options.expectedAccountId } : {}),
  });
}

/** Explicit UI links share Action policy with Agents; the platform effect stays below admission. */
export async function requestOpenExternalUrl(
  url: string,
  options?: ExternalUrlOptions,
): Promise<boolean> {
  try {
    const result = await requestOpenExternalUrlResult(url, options);
    if (!result.ok) {
      const { presentActionTurnedOffNoticeIfOff } = await import('@/sync/ops/actions/actionTurnedOffNotice');
      presentActionTurnedOffNoticeIfOff(result, 'links.openExternal');
    }
    return result.ok && typeof result.result === 'object' && result.result !== null
      && 'status' in result.result && result.result.status === 'opened';
  } catch {
    return false;
  }
}
