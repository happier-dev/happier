import { spawn } from 'node:child_process';

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function parseArgs(argv) {
    const args = [...argv];
    let intervalMs = 30_000;
    let idleMs = 30_000;
    let label = 'typecheck';

    while (args.length > 0) {
        const arg = args[0];
        if (arg === '--') break;
        if (arg === '--interval-ms') {
            args.shift();
            const v = args.shift();
            intervalMs = Number(v);
            continue;
        }
        if (arg === '--idle-ms') {
            args.shift();
            const v = args.shift();
            idleMs = Number(v);
            continue;
        }
        if (arg === '--label') {
            args.shift();
            label = String(args.shift() ?? label);
            continue;
        }
        break;
    }

    if (args[0] === '--') args.shift();
    return { intervalMs, idleMs, label, cmd: args[0], cmdArgs: args.slice(1) };
}

const { intervalMs, idleMs, label, cmd, cmdArgs } = parseArgs(process.argv.slice(2));
if (!cmd) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/runWithHeartbeat.mjs [--interval-ms N] [--idle-ms N] [--label STR] -- <cmd> [...args]');
    process.exit(2);
}

const startedAtMs = Date.now();
let lastOutputAtMs = startedAtMs;

const child = spawn(cmd, cmdArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
});

const markOutput = () => { lastOutputAtMs = Date.now(); };
child.stdout.on('data', (chunk) => {
    markOutput();
    process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
    markOutput();
    process.stderr.write(chunk);
});

const interval = setInterval(() => {
    const nowMs = Date.now();
    if (nowMs - lastOutputAtMs < idleMs) return;
    const elapsed = formatDuration(nowMs - startedAtMs);
    process.stderr.write(`[${label}] still running (elapsed ${elapsed})\n`);
}, intervalMs);
interval.unref();

const forwardSignal = (signal) => {
    try {
        child.kill(signal);
    } catch {
        // ignore
    }
};
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('close', (code, signal) => {
    clearInterval(interval);
    if (signal) process.exit(1);
    process.exit(code ?? 1);
});
child.on('error', (err) => {
    clearInterval(interval);
    // eslint-disable-next-line no-console
    console.error(`[${label}] failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});

