// Preloaded into Node foreground children. The launcher holds the other end of
// this IPC channel for exactly as long as it waits for the child, so the
// channel closing while the child still runs means the launcher was killed
// without forwarding a signal (e.g. SIGKILL from an agent tool). Treat that as
// the owner hanging up: run the child's own SIGHUP cleanup, or end it.
import { LAUNCHER_RELEASE } from './foreground_child.mjs';

if (process.channel) {
  const onRelease = message => {
    if (message !== LAUNCHER_RELEASE) return;
    process.off('disconnect', onDisconnect);
    process.off('message', onRelease);
    if (process.connected) process.disconnect();
  };
  const onDisconnect = () => {
    if (process.listenerCount('SIGHUP') > 0) process.emit('SIGHUP', 'SIGHUP');
    else process.kill(process.pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGHUP');
  };
  process.on('message', onRelease);
  process.once('disconnect', onDisconnect);
  // The lifeline must never keep a finished command alive.
  process.channel.unref();
}
