import { Agent } from 'node:http';
import { connect } from 'node:net';
import { observeLocalIpcPeerIdentity, resolveProcessCustodyPeerIdentityExecutable } from '@/subprocess/supervision/processCustody';

/** One connection pool per Session host; peer admission lasts for the connection. */
export function createLocalSessionRpcAgent(endpointPath: string, platform: NodeJS.Platform = process.platform, keepAlive = true): Agent {
  const agent = new Agent({ keepAlive });
  if (platform !== 'win32') return agent;
  // Descriptor files are routing hints on Windows. Prove the connected pipe's
  // server belongs to this OS user before HTTP can send admitted private input.
  agent.createConnection = (_options, callback) => {
    const socket = connect(endpointPath);
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      socket.off('error', finish);
      callback?.(error, socket);
    };
    const refuse = () => {
      const error = Object.assign(new Error('Local Session pipe server identity is unproven'), { code: 'local_session_unavailable' });
      socket.destroy();
      finish(error);
    };
    socket.once('error', finish);
    socket.once('connect', () => {
      const executablePath = resolveProcessCustodyPeerIdentityExecutable(platform);
      if (!executablePath) { refuse(); return; }
      void observeLocalIpcPeerIdentity({ socket, executablePath, peer: 'server' }).then(identity => {
        if (!identity) { refuse(); return; }
        finish(null);
        // The native witness borrows the pipe as stdio and pauses its read side.
        // HTTP has installed its parser now, so it can receive the response.
        socket.resume();
      }, refuse);
    });
    // Returning the unverified socket would let ClientRequest write immediately.
    return undefined;
  };
  return agent;
}
