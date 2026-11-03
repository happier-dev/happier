import { constants, userInfo } from 'node:os';
import type { CommandHandler } from '../commandRegistry';
import { AGENT_LAUNCH_TERMINAL_READY, AGENT_LAUNCH_TERMINAL_ACCEPTED, readAgentLaunchFrame } from '../../daemon/agentIsolation/agentLaunchFrame';
import { executeAgentLaunchPayload } from '../../daemon/agentIsolation/agentLaunchShim';
import { observeCurrentAgentIsolationLaunchIdentity } from '../../daemon/agentIsolation/agentIsolationNativeIdentity';

type AgentLaunchStopSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';

/** RunAs entry only. No Account, daemon-home or general CLI bootstrap is opened. */
export async function runAgentLaunchShim(args: readonly string[]): Promise<void> {
  const identity = userInfo();
  if (process.platform !== 'linux' || identity.username !== 'happier-agent' && !/^hpm-[a-f0-9]{24}$/u.test(identity.username)
    || identity.uid === 0 || process.getuid?.() !== identity.uid) {
    throw Object.assign(new Error('agent_launch_identity_unavailable'), { code: 'agent_launch_identity_unavailable' });
  }
  if (args.length) throw Object.assign(new Error('agent_launch_frame_invalid'), { code: 'agent_launch_frame_invalid' });
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let readingTerminalFrame = false;
  const controller = new AbortController();
  let requestedSignal: AgentLaunchStopSignal | undefined;
  const interrupt = (signal: AgentLaunchStopSignal) => {
    requestedSignal ??= signal;
    controller.abort();
    // Startup may still be waiting for the frame; close that same stream so
    // cancellation cannot leave an unreferenced read waiting indefinitely.
    if (!terminal || readingTerminalFrame) process.stdin.destroy();
  };
  const terminate = () => interrupt('SIGTERM');
  const interruptInput = () => interrupt('SIGINT');
  const hangup = () => interrupt('SIGHUP');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interruptInput);
  process.on('SIGHUP', hangup);
  try {
    if (terminal) {
      process.stdin.setRawMode(true);
      readingTerminalFrame = true;
      process.stdout.write(AGENT_LAUNCH_TERMINAL_READY);
    }
    const payload = await readAgentLaunchFrame(process.stdin, terminal ? 'terminal' : undefined);
    if (terminal) {
      process.stdin.pause();
      process.stdin.setRawMode(false);
      readingTerminalFrame = false;
    }
    try { await observeCurrentAgentIsolationLaunchIdentity(identity, payload.nativeIdentity, controller.signal); }
    catch (cause) {
      if (controller.signal.aborted) throw cause;
      throw Object.assign(new Error('agent_launch_identity_unavailable', { cause }), { code: 'agent_launch_identity_unavailable' });
    }
    controller.signal.throwIfAborted();
    const result = await executeAgentLaunchPayload(payload, { agentHome: identity.homedir,
      input: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal,
      ...(terminal ? { terminal: { accepted: () => { process.stdout.write(AGENT_LAUNCH_TERMINAL_ACCEPTED); } } } : {}) });
    process.exitCode = result.code ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
  } catch (error) {
    if (requestedSignal) {
      process.exitCode = 128 + constants.signals[requestedSignal];
      return;
    }
    throw error;
  } finally {
    if (terminal && readingTerminalFrame) process.stdin.setRawMode(false);
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interruptInput);
    process.off('SIGHUP', hangup);
  }
}

export const handleAgentLaunchCliCommand: CommandHandler = async context => {
  try { await runAgentLaunchShim(context.args.slice(1)); }
  catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const publicCodes = ['agent_launch_identity_unavailable', 'agent_launch_frame_invalid', 'agent_launch_material_invalid',
      'agent_launch_stream_failed', 'agent_launch_transport_unavailable'];
    process.stderr.write(`${typeof code === 'string' && publicCodes.includes(code) ? code : 'agent_launch_failed'}\n`);
    process.exitCode = 1;
  }
};
