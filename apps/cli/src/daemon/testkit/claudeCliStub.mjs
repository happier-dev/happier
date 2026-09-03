#!/usr/bin/env node

const command = String(process.argv[2] ?? '');
if (['--version', '-v', 'version'].includes(command)) {
  process.stdout.write('0.0.0-daemon-integration-stub\n');
  process.exit(0);
}
if (['--help', '-h', 'help'].includes(command)) {
  process.stdout.write('claude (daemon integration stub)\n');
  process.exit(0);
}

process.stdin.resume();
const keepAlive = setInterval(() => {}, 60_000);
const stop = () => {
  clearInterval(keepAlive);
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
