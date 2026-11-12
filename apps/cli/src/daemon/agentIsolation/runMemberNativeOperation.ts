import { createInterface } from 'node:readline';
import { ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { spawnAuthorizedHostExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { SupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';

/** A finite private pipe over the incumbent native launcher and process owner.
 * Cancellation is delivered to the member, which owns its installer descendants. */
export async function runMemberAgentEffect<T>(input: Readonly<{
  launch: HostAuthorizedPluginExecLaunch;
  signal: AbortSignal;
  request: unknown;
  readRecord(record: unknown): T | undefined;
}>): Promise<T> {
  let release = input.launch.release;
  let process: SupervisedPluginProcess;
  try {
    process = spawnAuthorizedHostExecLaunchForHost({ ...input.launch,
      maxStdoutBytes: 0, maxStderrBytes: 0, waitForGracefulRootExitBeforeTreeStop: true },
    { retainLaunch: retained => { release = retained; } });
  } catch (error) { await release(); throw error; }
  const lines = createInterface({ input: process.child.stdout });
  let terminal: T | undefined;
  let settled = false;
  let protocolError: unknown;
  const cancel = () => { if (!process.child.stdin.destroyed) process.child.stdin.write('cancel\n'); };
  const onLine = (line: string) => {
    try {
      const record = input.readRecord(JSON.parse(line));
      if (record !== undefined) { terminal = record; process.child.stdin.end(); }
    } catch (error) { protocolError = error; process.child.stdin.end(); }
  };
  lines.on('line', onLine);
  input.signal.addEventListener('abort', cancel, { once: true });
  let unsubscribe = () => {};
  try {
    process.child.stdin.write(JSON.stringify(input.request) + '\n');
    if (input.signal.aborted) cancel();
    await Promise.race([process.handle.wait(), new Promise<never>((_resolve, reject) => {
      unsubscribe = process.onOutcomeUncertain(reject);
    })]);
    await process.dispose();
    const settlement = await process.waitForSettlement();
    if (settlement.remainder) throw new ExecFileTerminationError(new Error('Member operation cleanup is unconfirmed'));
    settled = true;
  } catch (error) {
    try { await process.dispose(); }
    catch (cause) { throw new ExecFileTerminationError(cause); }
    const settlement = await process.waitForSettlement();
    if (settlement.remainder) throw new ExecFileTerminationError(error);
    settled = true;
    throw error;
  } finally {
    unsubscribe(); input.signal.removeEventListener('abort', cancel);
    lines.removeListener('line', onLine); lines.close();
    // The supervisor retains release if physical settlement is unconfirmed.
    if (settled) await release();
  }
  if (protocolError) throw protocolError;
  if (terminal === undefined) throw new Error('Member operation returned no result');
  return terminal;
}
