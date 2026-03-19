import type { SocketCollector } from './socketClient';
import { callLegacyEncryptedSessionRpc } from './sessionRpc';

const BooleanRpcResultSchema = {
  safeParse(input: unknown): { success: true; data: boolean } | { success: false } {
    if (input === true || input === false) {
      return { success: true, data: input };
    }
    return { success: false };
  },
};

export async function requestSessionSwitchRpc(opts: {
  ui: SocketCollector;
  sessionId: string;
  to: 'local' | 'remote';
  secret: Uint8Array;
  timeoutMs?: number;
}): Promise<boolean> {
  return await callLegacyEncryptedSessionRpc({
    ui: opts.ui,
    sessionId: opts.sessionId,
    method: 'switch',
    req: { to: opts.to },
    secret: opts.secret,
    schema: BooleanRpcResultSchema,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}
