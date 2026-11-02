import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture physical spawn and PATH before consumer OS doubles. Only PATH is
// retained; every other child environment key is inherited at call time.
const require = createRequire(import.meta.url);
const { spawn } = require('node:child_process');
const nativePath = process.env.PATH;
const entry = fileURLToPath(import.meta.url);
const serverRoot = resolve(dirname(entry), '../..');
// Only these fixed labels may cross the diagnostic IPC projection.
const setupPhases = new Set(['owner_import', 'sqlite_setup', 'identity_seed', 'listen', 'socket_ready',
    'sqlite_storage_prepare_started',
    'sqlite_storage_prepare_returned',
    'sqlite_migration_started',
    'sqlite_migration_returned',
    'sqlite_prisma_init_started',
    'sqlite_prisma_init_returned',
    'sqlite_prisma_connect_started',
    'sqlite_prisma_connect_returned',
    'sqlite_auth_init_started',
    'sqlite_auth_init_returned']);
const setupErrorNames = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError']);
const setupErrorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'ENOMEM', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOSPC', 'ETIMEDOUT', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);
function projectSetupFailure(error) {
    const migration = error instanceof Error
        ? /^sqlite migration deploy failed \(status=(null|-?\d+)\)\./.exec(error.message) : null;
    return { errorName: setupErrorNames.has(error?.name) ? error.name : 'Error',
        errorCode: setupErrorCodes.has(error?.code) ? error.code : 'unclassified',
        ...(migration ? { operation: 'sqlite_migration_deploy',
            exitStatus: migration[1] === 'null' ? null : Number(migration[1]) } : {}),
    };
}

/** Process isolation keeps consumer filesystem/process doubles outside real Home storage and auth. */
export async function createExternalActionHomeProcessForTests(options) {
    console.info('External Action Home setup', { stage: 'parent_started' });
    const child = spawn(process.execPath, ['--conditions=happier-source', '--import', resolve(serverRoot, '../../packages/cli-common/registerSourceRuntime.mjs'), entry,
        '--external-action-home-child'], { cwd: serverRoot, env: { ...process.env, PATH: nativePath,
            TSX_TSCONFIG_PATH: resolve(serverRoot, 'tsconfig.json') },
        serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const pending = new Map();
    const dispatches = new Map();
    let nextId = 0;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.on('error', error => { rejectReady(error); for (const item of pending.values()) item.reject(error); });
    child.on('exit', code => {
        const error = new Error(`External Action Home process exited (${code})`);
        rejectReady(error);
        for (const item of pending.values()) item.reject(error);
        pending.clear();
        for (const controller of dispatches.values()) controller.abort();
    });
    child.on('message', async message => {
        if (message.kind === 'ready') { resolveReady(message); return; }
        if (message.kind === 'setup-phase') {
            if (setupPhases.has(message.phase)) console.info('External Action Home setup', {
                phase: message.phase,
                ...(Number.isFinite(message.elapsedMs) && message.elapsedMs >= 0 ? { elapsedMs: message.elapsedMs } : {}),
                ...(Number.isSafeInteger(message.cpuUsage?.user) && message.cpuUsage.user >= 0
                    && Number.isSafeInteger(message.cpuUsage?.system) && message.cpuUsage.system >= 0
                    ? { cpuUsage: { user: message.cpuUsage.user, system: message.cpuUsage.system } } : {}),
            });
            return;
        }
        if (message.kind === 'failed') {
            if (setupPhases.has(message.phase)) console.info('External Action Home setup', {
                stage: 'child_failed', phase: message.phase,
                errorName: setupErrorNames.has(message.errorName) ? message.errorName : 'Error',
                errorCode: setupErrorCodes.has(message.errorCode) ? message.errorCode : 'unclassified',
                ...(message.operation === 'sqlite_migration_deploy'
                    && (message.exitStatus === null || Number.isSafeInteger(message.exitStatus))
                    ? { operation: 'sqlite_migration_deploy', exitStatus: message.exitStatus } : {}),
            });
            rejectReady(new Error(message.code));
            return;
        }
        if (message.kind === 'dispatch-cancel') { dispatches.get(message.id)?.abort(); return; }
        if (message.kind === 'dispatch') {
            const controller = new AbortController();
            dispatches.set(message.id, controller);
            try {
                const value = await options.dispatch(message.packet, { signal: controller.signal });
                if (child.connected) child.send({ kind: 'dispatch-result', id: message.id, value });
            } catch {
                if (child.connected) child.send({ kind: 'dispatch-error', id: message.id });
            } finally { dispatches.delete(message.id); }
            return;
        }
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        if (message.kind === 'request-error') item.reject(new Error('external_action_home_request_failed'));
        else item.resolve(message.value);
    });
    const control = (kind, subject) => {
        const id = ++nextId;
        const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        child.send({ kind, id, subject });
        return result;
    };
    const { dispatch: _dispatch, installationPublicKey, ...identity } = options;
    child.send({ kind: 'start', options: { ...identity, installationPublicKey: Array.from(installationPublicKey) } });
    try {
        const { token, manageGrantee } = await ready;
        return {
            token,
            ...(manageGrantee ? { manageGrantee } : {}),
            readConnectorGrantCount: subject => control('connector-grant-count', subject),
            removeConnectorGrant: async subject => { await control('connector-grant-remove', subject); },
            request: async (method, path, body, headers = {}, signal) => {
                const id = ++nextId;
                const cancel = () => { if (child.connected) child.send({ kind: 'request-cancel', id }); };
                const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
                child.send({ kind: 'request', id, method, path, body, headers });
                signal?.addEventListener('abort', cancel, { once: true });
                if (signal?.aborted) cancel();
                try { return await result; }
                finally { signal?.removeEventListener('abort', cancel); }
            },
            close: async () => {
                if (child.connected) child.send({ kind: 'close' });
                const code = await exited;
                if (code !== 0) throw new Error('external_action_home_cleanup_failed');
            },
        };
    } catch (error) {
        if (child.connected) child.send({ kind: 'close' });
        await exited;
        throw error;
    }
}

if (process.argv[2] === '--external-action-home-child') {
    const dispatches = new Map();
    const requests = new Map();
    let nextId = 0;
    let home;
    const closeChild = async (code = 0) => {
        for (const controller of requests.values()) controller.abort();
        try { await home?.close(); } catch { code = 1; }
        if (process.connected) process.disconnect();
        process.exit(code);
    };
    const handleTransportError = error => {
        if (['EPIPE', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED'].includes(error.code)) void closeChild();
        else process.exit(1);
    };
    process.on('error', handleTransportError);
    process.on('message', async message => {
        if (message.kind === 'start') {
            let phase = 'owner_import';
            const setupStartedAt = performance.now(), setupCpuStarted = process.cpuUsage();
            const observeSetup = next => {
                phase = next;
                process.send?.({ kind: 'setup-phase', phase, elapsedMs: performance.now() - setupStartedAt,
                    cpuUsage: process.cpuUsage(setupCpuStarted) });
            };
            try {
                observeSetup('owner_import');
                const { createExternalActionHomeForTests } = await import('./externalActionExecution.ts');
                home = await createExternalActionHomeForTests({ ...message.options,
                    installationPublicKey: new Uint8Array(message.options.installationPublicKey),
                    dispatch: async (packet, { signal }) => {
                        const id = ++nextId;
                        const cancel = () => process.send?.({ kind: 'dispatch-cancel', id });
                        const result = new Promise((resolve, reject) => dispatches.set(id, { resolve, reject }));
                        process.send?.({ kind: 'dispatch', id, packet });
                        signal.addEventListener('abort', cancel, { once: true });
                        if (signal.aborted) cancel();
                        try { return await result; } finally { signal.removeEventListener('abort', cancel); }
                    },
                }, observeSetup);
                process.send?.({ kind: 'ready', token: home.token,
                    ...(home.manageGrantee ? { manageGrantee: home.manageGrantee } : {}) });
            } catch (error) {
                process.send?.({ kind: 'failed', code: 'external_action_home_start_failed', phase, ...projectSetupFailure(error) },
                    error => { if (error) handleTransportError(error); else void closeChild(1); });
            }
            return;
        }
        if (message.kind === 'dispatch-result' || message.kind === 'dispatch-error') {
            const item = dispatches.get(message.id);
            dispatches.delete(message.id);
            if (message.kind === 'dispatch-error') item?.reject(new Error('remote_daemon_failed'));
            else item?.resolve(message.value);
            return;
        }
        if (message.kind === 'connector-grant-count' || message.kind === 'connector-grant-remove') {
            try {
                let value = null;
                if (message.kind === 'connector-grant-count') value = await home.readConnectorGrantCount(message.subject);
                else await home.removeConnectorGrant(message.subject);
                process.send?.({ kind: 'request-result', id: message.id, value });
            } catch { process.send?.({ kind: 'request-error', id: message.id }); }
            return;
        }
        if (message.kind === 'request-cancel') { requests.get(message.id)?.abort(); return; }
        if (message.kind === 'request') {
            const controller = new AbortController();
            requests.set(message.id, controller);
            try {
                const value = await home.request(message.method, message.path, message.body, message.headers, controller.signal);
                process.send?.({ kind: 'request-result', id: message.id, value });
            } catch { process.send?.({ kind: 'request-error', id: message.id }); }
            finally { requests.delete(message.id); }
            return;
        }
        if (message.kind === 'close') await closeChild();
    });
    process.on('disconnect', () => { void closeChild(); });
}
