import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** Real CLI RPC/PTY in its own package runtime; only its transport is replaced by IPC. */
export async function createPf56NativeTerminalPeer(serverId: string) {
    const repoRoot = resolve(process.cwd(), '../..');
    const source = String.raw`
        import { pathToFileURL } from 'node:url';
        const root = process.env.PF56_REPO_ROOT;
        const load = path => import(pathToFileURL(root + '/' + path).href);
        const { createTerminalPtySessionManager } = await load('apps/cli/src/terminal/pty/sessions.ts');
        const { createPythonPtyRelayProvider } = await load('apps/cli/src/terminal/pty/pythonRelay.ts');
        const { readDaemonTerminalPtyConfig } = await load('apps/cli/src/terminal/pty/config.ts');
        const { registerMachineTerminalRpcHandlers } = await load('apps/cli/src/api/machine/rpcHandlers.terminal.ts');
        const provider = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
        if (!provider) throw new Error('Native POSIX PTY is required');
        let clockOffset = 0;
        const manager = createTerminalPtySessionManager({ ptyProvider: provider,
            config: readDaemonTerminalPtyConfig(process.env).sessionManager, env: { ...process.env, PS1: '', PS2: '' },
            now: () => Date.now() + clockOffset });
        const opened = await manager.ensure({ terminalKey: 'pf56-burst-native', cwd: process.cwd(),
            launchProcess: { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'] },
            custody: { kind: 'machine', serverId: process.env.PF56_SERVER_ID, requesterAccountId: 'terminal-account',
                machineId: 'machine', installationId: 'pf56-installation', rootPath: process.cwd() } });
        if (!opened.ok) throw new Error(opened.errorCode);
        const handlers = new Map();
        const registration = registerMachineTerminalRpcHandlers({
            rpcHandlerManager: { registerHandler: (method, handler) => handlers.set(method, handler) },
            deps: { sessionManager: manager, serverId: process.env.PF56_SERVER_ID,
                resolveHostHomeServerIdentityId: async () => process.env.PF56_SERVER_ID } });
        const context = { signal: new AbortController().signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'terminal-account', custodianAccountId: 'terminal-account',
                machineId: 'machine', installationId: 'pf56-installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        process.on('message', async message => {
            try {
                if (message.method === 'fixture.advanceClock') {
                    clockOffset += message.payload.milliseconds;
                    process.send({ id: message.id, result: null }); return;
                }
                if (message.method === 'dispose') {
                    await registration.dispose(); manager.dispose();
                    process.send({ id: message.id, result: null }, () => process.disconnect()); return;
                }
                const handler = handlers.get(message.method);
                if (!handler) throw new Error('Unexpected fixture RPC: ' + message.method);
                const result = await handler(message.payload, context);
                process.send({ id: message.id, result });
            } catch (error) { process.send({ id: message.id, error: String(error.stack || error) }); }
        });
        process.send({ id: 0, result: { terminalId: opened.terminalId } });
    `;
    const child = spawn(process.execPath, ['--conditions=happier-source', '--import',
        resolve(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'), '--input-type=module', '-e', source], {
        cwd: resolve(repoRoot, 'apps/cli'),
        env: { ...process.env, PF56_REPO_ROOT: repoRoot, PF56_SERVER_ID: serverId,
            TSX_TSCONFIG_PATH: resolve(repoRoot, 'apps/cli/tsconfig.json') },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', data => { stderr += String(data); });
    let sequence = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const id = Reflect.get(message, 'id');
        if (typeof id !== 'number') return;
        const receiver = pending.get(id);
        if (!receiver) return;
        pending.delete(id);
        const error = Reflect.get(message, 'error');
        if (typeof error === 'string') receiver.reject(new Error(error));
        else receiver.resolve(Reflect.get(message, 'result'));
    });
    child.on('exit', code => {
        for (const receiver of pending.values()) receiver.reject(new Error(`Native PTY peer exited ${code}: ${stderr}`));
        pending.clear();
    });
    const ready = await new Promise<unknown>((resolve, reject) => pending.set(0, { resolve, reject }));
    if (!ready || typeof ready !== 'object' || typeof Reflect.get(ready, 'terminalId') !== 'string') {
        throw new Error('Native PTY did not return an identity');
    }
    const terminalId: string = Reflect.get(ready, 'terminalId');
    const request = (method: string, payload: unknown = {}): Promise<unknown> => new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        child.send({ id, method, payload });
    });
    return { terminalId, request, advanceClock: (milliseconds: number) => request('fixture.advanceClock', { milliseconds }), dispose: async () => {
        if (child.exitCode !== null) return;
        await request('dispose');
    } };
}
