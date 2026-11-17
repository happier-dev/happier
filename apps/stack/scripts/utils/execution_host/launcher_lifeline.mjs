// Preloaded into Node foreground children. The launcher holds the other end of
// this IPC channel for exactly as long as it waits for the child, so the
// channel closing while the child still runs means the launcher was killed
// without forwarding a signal (e.g. SIGKILL from an agent tool). Treat that as
// the owner hanging up: run the child's own SIGHUP cleanup, or end it.
if (process.channel) {
  process.once('disconnect', () => {
    if (process.listenerCount('SIGHUP') > 0) process.emit('SIGHUP', 'SIGHUP');
    else process.kill(process.pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGHUP');
  });
  // The lifeline must never keep a finished command alive.
  process.channel.unref();
}
