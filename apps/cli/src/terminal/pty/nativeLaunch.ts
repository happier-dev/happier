import { Buffer } from 'node:buffer';
import { AGENT_LAUNCH_TERMINAL_READY, AGENT_LAUNCH_TERMINAL_ACCEPTED, encodeAgentLaunchTerminalFrame } from '@/daemon/agentIsolation/agentLaunchFrame';

/** Consumes only the two fixed startup markers. All payload bytes stay in the
 * incumbent terminal rings; no marker, frame or selected material enters them. */
export function createTerminalNativeLaunch(preamble: Uint8Array, write: (data: string) => void) {
  let phase: 'ready' | 'accepted' | 'running' | 'failed' = 'ready';
  let pending = Buffer.alloc(0);
  let settle!: (accepted: boolean) => void;
  const ready = new Promise<boolean>(resolve => { settle = resolve; });
  const finish = () => { if (phase !== 'running') { phase = 'failed'; settle(false); } };
  return {
    ready, finish,
    consume(bytes: Buffer, output: (bytes: Buffer) => void): void {
      if (phase === 'running' || phase === 'failed') { output(bytes); return; }
      pending = Buffer.concat([pending, bytes]);
      while (phase === 'ready' || phase === 'accepted') {
        const marker = Buffer.from(phase === 'ready' ? AGENT_LAUNCH_TERMINAL_READY : AGENT_LAUNCH_TERMINAL_ACCEPTED);
        const position = pending.indexOf(marker);
        if (position < 0) {
          // Retain only a possible fragmented marker suffix, never a second log.
          let suffix = Math.min(pending.length, marker.length - 1);
          while (suffix && !pending.subarray(-suffix).equals(marker.subarray(0, suffix))) suffix--;
          const visible = pending.length - suffix;
          if (visible) output(pending.subarray(0, visible));
          pending = pending.subarray(visible);
          return;
        }
        if (position) output(pending.subarray(0, position));
        pending = pending.subarray(position + marker.length);
        if (phase === 'ready') {
          phase = 'accepted';
          try { write(encodeAgentLaunchTerminalFrame(preamble)); }
          catch { finish(); return; }
        } else {
          phase = 'running';
          settle(true);
          if (pending.length) output(pending);
          pending = Buffer.alloc(0);
        }
      }
    },
  };
}
