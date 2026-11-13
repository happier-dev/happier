import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import spawn from 'cross-spawn';

import { buildAcpSpawnSpec } from './acpSpawn';
import {
  readAdvertisedAuthMethodIds,
  validateAuthenticationSelection,
} from './AcpAuthentication';
import { createAcpClientConnection, type AcpClientConnection } from './connection/createAcpClientConnection';
import { createAcpFilteredStdoutReadable } from './createAcpFilteredStdoutReadable';
import { createAcpNdJsonStream } from './createAcpNdJsonStream';
import { nodeToWebStreams } from './nodeToWebStreams';
import { DefaultTransport } from '@/agent/transport';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';

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
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', params.onStderr);
    const { writable, readable } = nodeToWebStreams(child.stdin, child.stdout);
    connection = createAcpClientConnection({
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
          initializeTimer = setTimeout(
            () => reject(new Error('ACP login initialize timed out')),
            transport.getInitTimeout(),
          );
        }),
      ]).finally(() => clearTimeout(initializeTimer));
      const advertisedMethodIds = readAdvertisedAuthMethodIds(initialized);
      const selection = validateAuthenticationSelection({ methodId: params.methodId }, advertisedMethodIds);
      await peer.authenticate({ methodId: selection.methodId });
    };
    await Promise.race([login(), interrupted]);
  } catch (error) {
    loginFailure = { error };
    throw error;
  } finally {
    clearTimeout(initializeTimer);
    if (onAbort) params.signal?.removeEventListener('abort', onAbort);
    child.stderr?.removeListener('data', params.onStderr);
    connection?.close();
    try {
      await terminateProcessTree(child);
    } catch (cleanupError) {
      if (loginFailure) {
        throw Object.assign(new AggregateError([loginFailure.error, cleanupError], 'ACP login and process cleanup failed', { cause: loginFailure.error }), {
          failureCause: classifyPrimarySessionRuntimeIssue({ cause: 'status_error', fallbackSource: 'agent_session_error', error: loginFailure.error, startupPhase: 'client_start' }).failureCause,
        });
      }
      throw cleanupError;
    } finally {
      await connection?.closed.catch(() => {});
    }
  }
}
