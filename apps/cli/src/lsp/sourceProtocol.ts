import type { PluginProcessHandle, PluginProcessOutput, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { ManagedExecutableRef } from '@happier-dev/protocol';

import { createJsonRpcProcessClient } from '@/plugins/runtime/exec/jsonRpc';
import type { WorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { OpenLanguageServerProtocol } from './serverSession';

/** The command a target resolves on its own PATH for a declared language-server executable. */
export function readLanguageServerCommandName(executable: ManagedExecutableRef): string {
  if (executable.kind === 'packaged-runtime-binary') return executable.executableBaseName;
  const id = String(executable.id);
  return id.slice(id.lastIndexOf('/') + 1);
}

/**
 * Open a language server inside a workspace source that is not this Machine (the
 * Session's target): the source starts it with long-lived stdin/stdout streams
 * (holder `spawn`, `i`/`o`/`e` frames, `kill`, exit frame, reattach) and the same
 * JSON-RPC client owner speaks LSP over those streams. This Machine's language
 * servers keep the managed Exec owner.
 */
export function createSourceLanguageServerProtocolOpener(source: WorkspaceSource): OpenLanguageServerProtocol {
  return async input => {
    input.signal.throwIfAborted();
    const command = await source.resolveExecutable(readLanguageServerCommandName(input.definition.executable), process.env);
    if (!command) throw Object.assign(new Error('The language server is not installed in this workspace'), { code: 'server_missing' });
    const child = source.spawn({ command, args: input.definition.args, cwd: input.rootPath });
    const listeners = new Set<(chunk: PluginProcessOutput) => void>();
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let sequence = 0;
    child.stderr.on('data', (data: Buffer) => {
      stderr.push(data);
      for (const listener of listeners) listener({ sequence: sequence++, stream: 'stderr', data });
    });
    let requestedBy: PluginProcessResult['termination']['requestedBy'] = { kind: 'none' };
    const exited = new Promise<PluginProcessResult['termination']>(resolve => {
      child.once('error', error => resolve({ requestedBy, observed: { kind: 'failed',
        diagnostic: { code: 'spawn_failed', severity: 'error', message: error.message } } }));
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ requestedBy,
        observed: signal ? { kind: 'signal', signal } : { kind: 'exit', exitCode: code ?? -1 } }));
    });
    // A refused or lost start also fails queued writes; each write's own callback reports it below.
    child.stdin.on('error', () => undefined);
    const write = (data: Uint8Array) => new Promise<void>((resolve, reject) => {
      child.stdin.write(data, error => error ? reject(error) : resolve());
    });
    const protocol = createJsonRpcProcessClient({ stdout: child.stdout, write: async data => await write(
      typeof data === 'string' ? Buffer.from(data) : data), framing: 'contentLength', cancellationMethod: '$/cancelRequest',
      readStderrPreview: () => Buffer.concat(stderr).toString('utf8').slice(-2_000) });
    let disposed: Promise<void> | undefined;
    const dispose = () => disposed ??= (async () => {
      requestedBy = { kind: 'dispose', reason: 'caller' };
      protocol.dispose();
      await child.terminateTree().catch(() => undefined);
      await exited;
    })();
    const onAbort = () => { void dispose(); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    void exited.then(() => input.signal.removeEventListener('abort', onAbort));
    const processHandle: PluginProcessHandle = {
      write, closeStdin: async () => { child.stdin.end(); },
      waitForExit: () => exited,
      wait: async () => ({ termination: await exited, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
        stdoutTruncated: false, stderrTruncated: false }),
      onOutput: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
      dispose,
    };
    // The same plugin-facing client owner Exec uses; currentness is this handle's own lifetime.
    const { guardJsonRpcClient } = await import('@/plugins/runtime/invocation/services/exec');
    const client = guardJsonRpcClient(protocol, signal => { input.signal.throwIfAborted(); signal?.throwIfAborted(); });
    void exited.then(({ observed }) => protocol.settleExit(Object.assign(new Error('Language server exited'), {
      code: 'plugin_exec_client_exited', exitCode: observed.kind === 'exit' ? observed.exitCode : null })));
    const handle: PluginProtocolClientHandle<'jsonRpc'> = {
      client: client as PluginProtocolClientHandle<'jsonRpc'>['client'],
      process: processHandle,
      wait: () => processHandle.wait(),
      dispose,
    };
    // Graceful LSP shutdown/exit within the supervisor's own grace, then the tree stop.
    const { registerPluginProtocolClientGracefulDisposerForHost } = await import('@/plugins/runtime/invocation/services/exec');
    const { PROCESS_TERMINATION_GRACE_MS } = await import('@/plugins/runtime/exec/processSupervisor');
    registerPluginProtocolClientGracefulDisposerForHost(handle, async beforeTerminate => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROCESS_TERMINATION_GRACE_MS);
      try {
        await Promise.race([beforeTerminate(controller.signal).catch(() => undefined), exited,
          new Promise<void>(settle => controller.signal.addEventListener('abort', () => settle(), { once: true }))]);
      } finally { clearTimeout(timer); }
      await dispose();
    });
    return handle;
  };
}
