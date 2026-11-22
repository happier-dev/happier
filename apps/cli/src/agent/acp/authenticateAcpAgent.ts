import spawn from 'cross-spawn';

import { resolveAcpAuthenticationSelection } from './AcpAuthentication';
import { buildAcpSpawnSpec } from './acpSpawn';
import { createAcpClientConnection, type AcpClientConnection } from './connection/createAcpClientConnection';
import { loadAcpSdk } from './connection/acpSdk';
import { createAcpFilteredStdoutReadable } from './createAcpFilteredStdoutReadable';
import { createAcpNdJsonStream } from './createAcpNdJsonStream';
import { nodeToWebStreams } from './nodeToWebStreams';
import { DefaultTransport } from '@/agent/transport';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

/** Explicit terminal login only: the provider owns browser interaction and credential storage. */
export async function authenticateAcpAgent(params: Readonly<{
  agentName: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  methodId: string;
  onStderr: (text: string) => void;
  signal?: AbortSignal;
}>): Promise<void> {
  params.signal?.throwIfAborted();
  // Load before spawning: an I/O-sized await between `interrupted` and its race
  // would leave an early child error or abort unhandled.
  await loadAcpSdk();
  params.signal?.throwIfAborted();
  const spec = buildAcpSpawnSpec(params);
  const child = spawn(spec.command, spec.args, spec.options);
  const transport = new DefaultTransport(params.agentName);
  let connection: AcpClientConnection | null = null;
  let onAbort: (() => void) | undefined;
  let initializeTimer: ReturnType<typeof setTimeout> | undefined;
  let loginFailure: { error: unknown } | undefined;

  const interrupted = new Promise<never>((_resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`ACP login process exited (${signal ?? code})`)));
    onAbort = () => reject(params.signal?.reason ?? new DOMException('Login cancelled', 'AbortError'));
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
  });

  try {
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Failed to create ACP login pipes');
    // The explicit login terminal must see the provider's OAuth URL. Do not copy it to session logs.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', params.onStderr);
    const { writable, readable } = nodeToWebStreams(child.stdin, child.stdout);
    connection = await createAcpClientConnection({
      name: 'happier-cli-login',
      transport: createAcpNdJsonStream(writable, createAcpFilteredStdoutReadable({ readable, transport })),
      handlers: {
        sessionUpdate: () => {},
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
      },
    });
    const peer = connection.peer;

    const login = async () => {
      const initialized = await Promise.race([
        peer.initialize({
          protocolVersion: 1,
          clientInfo: { name: 'happier-cli-login', version: '1' },
          clientCapabilities: {},
        }),
        new Promise<never>((_resolve, reject) => {
          initializeTimer = setTimeout(() => reject(new Error('ACP login initialize timed out')), transport.getInitTimeout());
        }),
      ]).finally(() => clearTimeout(initializeTimer));

      const selection = resolveAcpAuthenticationSelection({
        authentication: { kind: 'static', methodId: params.methodId },
        advertisedMethodIds: new Set((initialized.authMethods ?? []).map((method) => method.id)),
        initializeMeta: initialized._meta ?? null,
      });
      // Interactive OAuth has its own provider-owned deadline. The initialize timeout
      // must not cut it short, and retrying a rejected login can launch another browser flow.
      await peer.authenticate({ methodId: selection.methodId });
    };
    await Promise.race([login(), interrupted]);
  } catch (error) {
    loginFailure = { error };
    throw error;
  } finally {
    clearTimeout(initializeTimer);
    if (onAbort) params.signal?.removeEventListener('abort', onAbort);
    connection?.close();
    try {
      await killProcessTree(child);
    } catch (cleanupError) {
      if (loginFailure) {
        throw new AggregateError([loginFailure.error, cleanupError], 'ACP login and process cleanup failed');
      }
      throw cleanupError;
    } finally {
      await connection?.closed.catch(() => {});
      // ACP success on stdout can arrive before the browser link on stderr.
      // Keep explicit-login output attached until provider cleanup has settled.
      child.stderr?.removeListener('data', params.onStderr);
    }
  }
}
