import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const execute = createFrontDoorActionExecute();

/** Explicit UI links share Action policy with Agents; the platform effect stays below admission. */
export async function requestOpenExternalUrl(
  url: string,
  options?: Readonly<{ signal?: AbortSignal; serverId?: string; expectedAccountId?: string }>,
): Promise<boolean> {
  try {
    const result = await execute('links.openExternal', { url: url.trim() }, {
      surface: 'ui', actionCaller: { kind: 'host' },
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.serverId ? { serverId: options.serverId } : {}),
      ...(options?.expectedAccountId ? { expectedAccountId: options.expectedAccountId } : {}),
    });
    return result.ok && typeof result.result === 'object' && result.result !== null
      && 'status' in result.result && result.result.status === 'opened';
  } catch {
    return false;
  }
}
