import { appendBoundedTail, formatFailureDiagnostic, redactFailureDiagnostic } from '../proc/proc.mjs';

// OpenSSH ssh.c: forwarding_success runs after every remote-forward reply;
// ExitOnForwardFailure exits instead when a listener cannot be established.
// Local listeners are bound synchronously before entering the client loop.
export function createForwardReadiness({ forwards, env }) {
  const remote = forwards.some(forward => forward.direction !== 'local');
  let confirm;
  const ready = new Promise(resolve => { confirm = resolve; });
  let stderr = '';
  const diagnostic = () => formatFailureDiagnostic({ err: stderr, env });
  return {
    diagnostic,
    onLine({ stream, line }) {
      if (stream !== 'stderr') return;
      // Retain only a bounded, redacted tail; raw SSH output is never persisted.
      stderr = appendBoundedTail(stderr, `${redactFailureDiagnostic(line, env)}\n`);
      if (remote
        ? /^debug1: forwarding_success: all expected forwarding replies received\s*$/.test(line)
        : /^debug1: Entering interactive session\.\s*$/.test(line)) confirm();
    },
    async wait({ tunnel, waitForProcess, closeRequested }) {
      const failure = result => new Error(`SSH forward exited before readiness (code=${String(result?.code ?? 'unknown')})${diagnostic()}`);
      if (tunnel.exitCode != null || tunnel.signalCode != null) throw failure({ code: tunnel.exitCode });
      await Promise.race([
        ready,
        waitForProcess(tunnel).then(result => { throw failure(result); }),
        closeRequested.then(() => { throw new Error('SSH forward readiness cancelled'); }),
      ]);
    },
  };
}
