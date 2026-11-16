import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';

import type { SimulatorOperationRunner } from '../process';
import { parseAndroidAvdName } from './inventory';

export type AndroidEmulatorSpawn = (
    command: string, args: readonly string[], options: SpawnOptions,
) => Pick<ChildProcess, 'once' | 'removeListener' | 'kill' | 'unref'>;

/** The emulator pushes its allocated console port before emulation starts. The adb server then
 * owns readiness for precisely that transport; inventory polling cannot identify a concurrent boot.
 */
export async function bootAndroidSimulator(input: Readonly<{
    emulator: string;
    adb: string;
    avdName: string;
    run: SimulatorOperationRunner;
    signal?: AbortSignal;
    env?: Readonly<Record<string, string | undefined>>;
    spawn?: AndroidEmulatorSpawn;
}>): Promise<string> {
    input.signal?.throwIfAborted();
    const server = createServer();
    const report = new Promise<string>((resolve, reject) => {
        server.on('connection', (socket) => {
            let output = '';
            socket.on('data', (chunk) => { output += chunk.toString('utf8'); });
            socket.once('error', reject);
            socket.once('end', () => {
                const port = Number(output.trim());
                if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                    reject(Object.assign(new Error('Emulator reported an invalid console port'), { code: 'android_emulator_identity_invalid' }));
                } else resolve(`emulator-${port}`);
            });
        });
    });
    // Attach a rejection handler before listening/spawning can fail.
    void report.catch(() => {});
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw Object.assign(new Error('Emulator console listener has no TCP address'), { code: 'android_emulator_listener_failed' });
    }
    let child: ReturnType<AndroidEmulatorSpawn> | undefined;
    let succeeded = false;
    let abort: (() => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    try {
        child = (input.spawn ?? ((command, args, options) => spawn(command, [...args], options)))(input.emulator,
            ['-avd', input.avdName, '-report-console', `tcp:${address.port}`],
            { detached: true, stdio: 'ignore', shell: false, windowsHide: true, ...(input.env ? { env: input.env } : {}) });
        const failed = new Promise<never>((_resolve, reject) => {
            onError = reject;
            onExit = (exitCode, signal) => reject(Object.assign(new Error('Emulator exited during boot'), {
                code: 'android_emulator_exited', ...(exitCode !== null ? { exitCode } : {}), ...(signal ? { signal } : {}),
            }));
            abort = () => reject(input.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            child?.once('error', onError);
            child?.once('exit', onExit);
            input.signal?.addEventListener('abort', abort, { once: true });
            if (input.signal?.aborted) abort();
        });
        const serial = await Promise.race([report, failed]);
        const ready = await Promise.race([input.run({ command: input.adb,
            args: ['-s', serial, 'wait-for-device'], signal: input.signal }), failed]);
        if (ready.exitCode !== 0) throw Object.assign(new Error(ready.stderr || ready.cause || 'adb readiness failed'), {
            code: ready.aborted ? 'operation_cancelled' : ready.errorCode ?? 'simulator_tool_failed', exitCode: ready.exitCode,
        });
        const identity = await Promise.race([input.run({ command: input.adb,
            args: ['-s', serial, 'emu', 'avd', 'name'], signal: input.signal }), failed]);
        if (identity.exitCode !== 0) throw Object.assign(new Error(identity.stderr || identity.cause || 'Emulator identity read failed'), {
            code: identity.errorCode ?? 'simulator_tool_failed', exitCode: identity.exitCode,
        });
        if (parseAndroidAvdName(identity.stdout.toString('utf8')) !== input.avdName) {
            throw Object.assign(new Error('Emulator runtime does not match the requested AVD'), { code: 'android_emulator_identity_mismatch' });
        }
        succeeded = true;
        child.unref();
        return serial;
    } finally {
        if (abort) input.signal?.removeEventListener('abort', abort);
        if (onError) child?.removeListener('error', onError);
        if (onExit) child?.removeListener('exit', onExit);
        if (!succeeded) child?.kill('SIGTERM');
        server.close();
    }
}
