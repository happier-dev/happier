import { basename } from 'node:path';
import { isIP } from 'node:net';
import { MachineSetupEffectError } from './index.js';
import { assertProtectedNativeTarget } from './nativeFileSafety.js';

/** Resolve PID 1's listeners through their actual socket/service association.
 * Socket activation can hold SSH open while no sshd process exists yet. */
export function nativeSocketSshReader(output: (executable: string, args: readonly string[]) => Promise<string>) {
    let sockets: Promise<string> | undefined;
    const services = new Map<string, Promise<boolean>>();
    const address = (value: string) => {
        const colon = value.lastIndexOf(':');
        const host = value.slice(0, colon).replace(/^\[|\]$/g, '');
        return { host: isIP(host) === 6 ? new URL(`http://[${host}]`).hostname : host, port: value.slice(colon + 1) };
    };
    return async (local: string): Promise<boolean> => {
        sockets ??= output('systemctl', ['list-sockets', '--all', '--no-legend', '--no-pager', '--full']);
        const expected = address(local);
        let matched = false;
        for (const line of (await sockets).split('\n').filter(value => value.trim())) {
            const columns = line.trim().split(/\s+/);
            const socket = columns.at(-2), service = columns.at(-1);
            if (!socket?.endsWith('.socket')) throw new MachineSetupEffectError('required_fact_unavailable');
            const actual = address(columns[0]!);
            if (actual.host !== expected.host || actual.port !== expected.port) continue;
            matched = true;
            if (service === '-') continue;
            if (!service?.endsWith('.service')) throw new MachineSetupEffectError('required_fact_unavailable');
            let ssh = services.get(service);
            if (!ssh) {
                ssh = (async () => {
                    const value = await output('systemctl', ['show', '--property=ExecStart', '--', service]);
                    const executable = /^ExecStart=\{\s*path=([^\s;]+)\s*;/m.exec(value)?.[1];
                    if (!executable) throw new MachineSetupEffectError('required_fact_unavailable');
                    if (basename(executable) !== 'sshd') return false;
                    await assertProtectedNativeTarget(executable, 0, true);
                    return true;
                })();
                services.set(service, ssh);
            }
            if (await ssh) return true;
        }
        if (!matched) throw new MachineSetupEffectError('required_fact_unavailable');
        return false;
    };
}
