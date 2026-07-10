#!/usr/bin/env node

const relayWriteFramePrefix = '\u001eHAPPIER_PTY_WRITE ';
const ptyBackendIds = ['node-pty', '@homebridge/node-pty-prebuilt-multiarch'];

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function loadPtyBackends() {
  const loaded = [];
  const errors = [];
  for (const id of ptyBackendIds) {
    try {
      loaded.push({ id, module: require(id) });
    } catch (error) {
      errors.push(`${id}: ${describeError(error)}`);
    }
  }
  return { loaded, errors };
}

function failRelayStartup(message, errors) {
  const details = errors.length > 0 ? ` (${errors.join('; ')})` : '';
  const output = `${message}${details}`;
  process.stderr.write(`${output}\n`);
  process.exit(127);
  throw new Error(output);
}

const argv = process.argv.slice(2);
let argsKind = 'array';
if (argv[0] === '--args-kind') {
  argsKind = argv[1] || '';
  argv.splice(0, 2);
}
if (argsKind !== 'array' && argsKind !== 'string') {
  process.stderr.write('node_pty_relay: invalid args kind\n');
  process.exit(64);
}
if (argv[0] === '--') {
  argv.shift();
}

const file = argv.shift();
if (!file) {
  process.stderr.write('node_pty_relay: missing command\n');
  process.exit(64);
}
const childArgs = argsKind === 'string' ? (argv[0] || '') : argv;

const cols = Number.parseInt(process.env.HAPPIER_NODE_PTY_RELAY_COLS || '', 10);
const rows = Number.parseInt(process.env.HAPPIER_NODE_PTY_RELAY_ROWS || '', 10);

const ptyOptions = {
  name: process.env.TERM || 'xterm-256color',
  encoding: null,
  cols: Number.isFinite(cols) && cols > 1 ? cols : 120,
  rows: Number.isFinite(rows) && rows > 1 ? rows : 40,
  cwd: process.cwd(),
  env: process.env,
  useConpty: true,
  useConptyDll: true,
};

function spawnPty(file, args, options) {
  const { loaded, errors } = loadPtyBackends();
  if (loaded.length === 0) {
    failRelayStartup('node_pty_relay: no PTY backend available', errors);
  }
  for (const backend of loaded) {
    try {
      return backend.module.spawn(file, args, options);
    } catch (error) {
      errors.push(`${backend.id}.spawn: ${describeError(error)}`);
    }
  }
  failRelayStartup('node_pty_relay: PTY backend spawn failed', errors);
}

const pty = spawnPty(file, childArgs, ptyOptions);

let exiting = false;
let framedInputBuffer = '';
let framedInputActive = false;

function forwardSignal(signal) {
  try {
    pty.kill(signal);
  } catch {
    // best effort
  }
}

function closeRelayInput() {
  process.stdin.off('data', onStdinData);
  process.stdin.off('end', onStdinEnd);
  process.stdin.pause();
  if (typeof process.stdin.destroy === 'function') {
    process.stdin.destroy();
  }
}

function requestRelayExit(exitCode) {
  if (exiting) return;
  exiting = true;
  process.exitCode = exitCode;
  closeRelayInput();
}

function markRelayError(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  requestRelayExit(1);
  try {
    pty.kill();
  } catch {
    // best effort
  }
}

function writeToPty(data) {
  try {
    pty.write(data);
  } catch (error) {
    markRelayError(error);
  }
}

function decodeRelayWriteFrame(line) {
  const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!normalizedLine.startsWith(relayWriteFramePrefix)) {
    throw new Error('node_pty_relay: invalid write frame');
  }
  const encoded = normalizedLine.slice(relayWriteFramePrefix.length);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function drainFramedInput() {
  while (true) {
    const newlineIndex = framedInputBuffer.indexOf('\n');
    if (newlineIndex === -1) return;
    const line = framedInputBuffer.slice(0, newlineIndex);
    framedInputBuffer = framedInputBuffer.slice(newlineIndex + 1);
    writeToPty(decodeRelayWriteFrame(line));
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

function onStdinData(chunk) {
  if (exiting) return;
  try {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (!framedInputActive && framedInputBuffer.length === 0) {
      const startsFramedInput =
        text.startsWith(relayWriteFramePrefix) ||
        relayWriteFramePrefix.startsWith(text) ||
        text.startsWith('\u001e');
      if (!startsFramedInput) {
        writeToPty(text);
        return;
      }
      framedInputActive = true;
    }
    framedInputBuffer += text;
    drainFramedInput();
  } catch (error) {
    markRelayError(error);
  }
}

function onStdinEnd() {
  if (framedInputActive && framedInputBuffer.length > 0) {
    markRelayError(new Error('node_pty_relay: incomplete write frame'));
    return;
  }
  try {
    pty.kill();
  } catch {
    // best effort
  }
}

process.stdin.on('data', onStdinData);
process.stdin.on('end', onStdinEnd);

pty.onData((data) => {
  process.stdout.write(data);
});

pty.onExit((event) => {
  requestRelayExit(typeof event.exitCode === 'number' ? event.exitCode : 1);
});
