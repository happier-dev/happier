import type { SimulatorSidebandMessageV1 } from '@happier-dev/protocol/devices/simulator/sidebandV1';
import type { SimulatorOperationSpawn } from './process';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type SimulatorLogStartInput = Readonly<{
    platform: 'ios' | 'android';
    deviceId: string;
    simulatorId: string;
    command: string;
    maxLineBytes: number;
    spawn?: SimulatorOperationSpawn;
    now?: () => number;
    emit: (message: Extract<SimulatorSidebandMessageV1, { kind: 'logs' }>) => void;
    failed: (reasonCode: string) => void;
}>;

export function startSimulatorLogs(input: SimulatorLogStartInput): Readonly<{ stop: () => void }> {
    const spawnProcess: SimulatorOperationSpawn = input.spawn ?? ((command, args, options) => spawn(command, [...args], options));
    let stopped = false;
    let pending = '';
    const decoder = new StringDecoder('utf8');
    let child: ReturnType<SimulatorOperationSpawn> | undefined;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        child?.stdout?.removeListener('data', onData);
        child?.kill('SIGTERM');
    };
    const fail = (reason: string) => { if (stopped) return; stop(); input.failed(reason); };
    const emit = (message: string) => {
        if (!message || stopped) return;
        const level = /^(?:E\/|.*\s(?:Error|Fault)\s)/.test(message) ? 'error'
            : /^(?:W\/|.*\sWarning\s)/.test(message) ? 'warn'
                : /^(?:[VD]\/|.*\sDebug\s)/.test(message) ? 'debug' : 'info';
        input.emit({ v: 1, kind: 'logs', simulatorId: input.simulatorId,
            emittedAtMs: input.now?.() ?? Date.now(), level, message });
    };
    // Split long/unterminated lines at the containing stream's byte boundary. No
    // retained history or independent log quota; downstream admission owns delivery.
    const onData = (chunk: Buffer | string) => {
        if (stopped) return;
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        while (pending.length) {
            const newline = pending.indexOf('\n');
            if (newline >= 0 && Buffer.byteLength(pending.slice(0, newline)) <= input.maxLineBytes) {
                emit(pending.slice(0, newline).replace(/\r$/, ''));
                pending = pending.slice(newline + 1);
            } else if (Buffer.byteLength(pending) > input.maxLineBytes) {
                let length = 0;
                let bytes = 0;
                for (const character of pending) {
                    const size = Buffer.byteLength(character);
                    if (bytes + size > input.maxLineBytes) break;
                    bytes += size; length += character.length;
                }
                if (length === 0) { fail('max_frame_bytes'); return; }
                emit(pending.slice(0, length));
                pending = pending.slice(length);
            } else break;
        }
    };
    try {
        child = spawnProcess(input.command, input.platform === 'ios'
            ? ['simctl', 'spawn', input.deviceId, 'log', 'stream', '--style', 'compact', '--level', 'debug']
            : ['-s', input.deviceId, 'logcat', '-v', 'brief'],
        { stdio: 'pipe', shell: false, windowsHide: true });
        child.stdout?.on('data', onData);
        // Drain diagnostics without exposing device content to daemon logs.
        child.stderr?.resume();
        child.once('error', error => {
            const code = 'code' in error && typeof error.code === 'string' ? error.code : 'error';
            fail(`simulator_logs_process_${code}`);
        });
        child.once('close', code => fail(`simulator_logs_process_exit_${code ?? 'signal'}`));
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'error';
        fail(`simulator_logs_process_${code}`);
    }
    return { stop };
}
