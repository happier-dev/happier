import nodePty from '@homebridge/node-pty-prebuilt-multiarch';

const separatorIndex = process.argv.indexOf('--');
const command = separatorIndex >= 0 ? process.argv[separatorIndex + 1] : undefined;
const args = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 2) : [];

if (!command) {
  process.stderr.write('Usage: run-command-in-pty.mjs -- <command> [...args]\n');
  process.exitCode = 2;
} else {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  const terminal = nodePty.spawn(command, args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env,
    useConpty: process.platform === 'win32',
  });
  let exited = false;

  terminal.onData((data) => {
    process.stdout.write(data);
  });
  const forwardInput = (chunk) => {
    if (!exited) terminal.write(chunk.toString('utf8'));
  };
  terminal.onExit(({ exitCode }) => {
    exited = true;
    process.stdin.off('data', forwardInput);
    process.stdin.pause();
    // node-pty can retain its native event-loop handle after onExit on Linux.
    // Flush all forwarded terminal output before explicitly retiring the
    // wrapper so the Windows ConPTY adapter has the child's exact lifecycle.
    process.stdout.write('', () => process.exit(exitCode));
  });
  process.stdin.on('data', forwardInput);
  process.stdin.resume();

  const stop = () => {
    if (!exited) terminal.kill();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
