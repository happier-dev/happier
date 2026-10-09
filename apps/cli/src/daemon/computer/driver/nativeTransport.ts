import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

export class ComputerDriverError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ComputerDriverError'; }
}

const resultSchema = z.object({
  isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.object({ type: z.string(), mimeType: z.string().optional(), data: z.string().optional() })).optional(),
});
export type NativeToolResult = z.infer<typeof resultSchema>;

export function nativeRefusalCode(result: NativeToolResult): string {
  const error = z.object({ code: z.string().min(1) }).safeParse(result.structuredContent?.error);
  if (error.success) return error.data.code;
  const code = result.structuredContent?.code;
  return typeof code === 'string' && code ? code : 'driver_refused';
}

/** Private pinned MCP codec; host Actions retain all approval and target authority. */
export async function openNativeComputerTransport(executablePath: string, displayId: string, context?: Readonly<{ signal?: AbortSignal }>) {
  if (context?.signal?.aborted) throw new ComputerDriverError('driver_unavailable');
  const desktopEnvironment: Record<string, string> = {};
  if (process.platform === 'linux') {
    desktopEnvironment.DISPLAY = displayId;
    for (const key of ['XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
      const value = process.env[key];
      if (value !== undefined) desktopEnvironment[key] = value;
    }
  }
  const transport = new StdioClientTransport({ command: executablePath,
    args: ['mcp', '--direct', '--embedded', '--no-overlay'],
    env: { ...getDefaultEnvironment(), ...desktopEnvironment, CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' }, stderr: 'ignore' });
  let nextId = 0;
  let unavailable = false;
  let startRequested = false;
  let resolveProcessClosed: () => void = () => undefined;
  const processClosed = new Promise<void>(resolve => { resolveProcessClosed = resolve; });
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, Readonly<{ resolve(value: unknown): void; reject(error: Error): void }>>();
  const lostConnection = () => {
    unavailable = true;
    for (const request of pending.values()) request.reject(new ComputerDriverError('driver_unavailable'));
    pending.clear();
  };
  transport.onclose = () => { lostConnection(); resolveProcessClosed(); };
  transport.onerror = lostConnection;
  transport.onmessage = message => {
    if (!('id' in message) || typeof message.id !== 'number' || 'method' in message) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if ('error' in message) request.reject(new ComputerDriverError('driver_protocol_error'));
    else request.resolve(message.result);
  };
  // SDK Client imposes a 60s request timer with no public disable option.
  // Its public stdio transport lets admitted native effects settle without
  // a competing operation deadline or private SDK mutation.
  const request = (method: string, args: Record<string, unknown>): Promise<unknown> => {
    if (unavailable) return Promise.reject(new ComputerDriverError('driver_unavailable'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void transport.send({ jsonrpc: '2.0', id, method, params: args }).catch(lostConnection);
    });
  };
  const close = () => closePromise ??= (async () => {
    try { await transport.close(); }
    finally {
      // SDK close can return immediately after requesting SIGKILL. Only the
      // child close event proves it can no longer deliver the unknown input.
      if (startRequested) await processClosed;
    }
  })();
  const cancelInitialization = () => {
    lostConnection();
    // The initialization catch awaits this same close and propagates failures.
    void close().catch(() => undefined);
  };
  context?.signal?.addEventListener('abort', cancelInitialization, { once: true });
  try {
    startRequested = true;
    await transport.start();
    const initialized = z.object({ protocolVersion: z.string(), serverInfo: z.object({ name: z.string(), version: z.string() }) }).safeParse(
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'happier-native-computer', version: '1.0.0' } }));
    if (!initialized.success || initialized.data.serverInfo.version !== '0.31.0') throw new ComputerDriverError('driver_version_mismatch');
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch (error) {
    await close();
    throw error;
  } finally { context?.signal?.removeEventListener('abort', cancelInitialization); }
  return {
    unavailable: () => unavailable,
    quarantine: lostConnection,
    async call(name: string, args: Record<string, unknown>): Promise<NativeToolResult> {
      const parsed = resultSchema.safeParse(await request('tools/call', { name, arguments: args }));
      if (!parsed.success) throw new ComputerDriverError('driver_result_invalid');
      return parsed.data;
    },
    close,
  };
}
