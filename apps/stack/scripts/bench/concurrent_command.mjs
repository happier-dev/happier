import { spawnProc } from '../utils/proc/proc.mjs';

function parseInvocation(argv) {
  const separator = argv.indexOf('--');
  const countArg = argv.find((arg) => arg.startsWith('--count='));
  const count = Number(countArg?.slice('--count='.length));
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw new Error('concurrent benchmark count must be an integer between 1 and 64');
  }
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('concurrent benchmark command is required after --');
  }
  const [command, ...args] = argv.slice(separator + 1);
  return { count, command, args };
}

function signalChildTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The child may already have completed.
  }
}

async function main() {
  const { count, command, args } = parseInvocation(process.argv.slice(2));
  const children = Array.from({ length: count }, (_, index) => spawnProc(
    `bench-concurrent:${index + 1}`,
    command,
    args,
    process.env,
    { cwd: process.cwd(), persistOutput: false },
  ));
  let interruptedSignal = null;
  const forwardSignal = (signal) => {
    interruptedSignal ??= signal;
    for (const child of children) signalChildTree(child, signal);
  };
  const onSigint = () => forwardSignal('SIGINT');
  const onSigterm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const outcomes = await Promise.all(children.map((child) => child.completion));
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  if (interruptedSignal) {
    process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143;
    return;
  }
  const failed = outcomes.find((outcome) => outcome.error || outcome.signal || outcome.code !== 0);
  process.exitCode = failed?.code ?? (failed ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`[bench-concurrent] ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
