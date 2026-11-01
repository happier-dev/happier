import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService, PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import { createSecureTempDirectorySync, writeAtomicFile } from '@happier-dev/plugin-sdk/fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/mini';
import { CuaLocalNameSchema } from './schemas.js';

const uploadSchema = z.object({ direction: z.literal('upload'), size: z.number(), sha256: z.string() });
const daemonStartSchema = z.object({ ok: z.literal(true), status: z.enum(['started', 'already_running']) });
const privateDirectoryPattern = /^\/tmp\/happier-cua\.[A-Za-z0-9-]+$/u;
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function qualifiedSandboxId(value: string) {
    const [location, name, ...rest] = value.split(':');
    if (!['local', 'aws', 'gcp', 'modal'].includes(location) || name === undefined || rest.length > 0) {
        throw new Error('cua_qualified_resource_required');
    }
    CuaLocalNameSchema.parse(name);
    return value;
}
function path(value: string) {
    if (!value.startsWith('/') || value.endsWith('/') || value.includes('\0')) throw new Error('cua_invalid_guest_path');
    return value;
}
function completed(result: Awaited<ReturnType<ExecService['run']>>) {
    return result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
        && result.termination.requestedBy.kind === 'none';
}
function confirmedDaemonStart(result: Awaited<ReturnType<ExecService['run']>>) {
    if (!completed(result) || result.stdoutTruncated) return false;
    try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout));
        return daemonStartSchema.safeParse(value).success;
    } catch { return false; }
}

export type CuaNativeOutcome<T> =
    | Readonly<{ kind: 'success'; value: T }>
    | Readonly<{ kind: 'unknown'; reason: 'transport' | 'termination' | 'truncated' | 'response' }>
    // Native exit 3 is Cua's typed NotFound for the exact id the command named.
    | Readonly<{ kind: 'unknown'; reason: 'not_found' }>;

export function createCuaNativeClient(options: {
    exec: Pick<ExecService, 'run'>;
    executable: PluginExecSpawnRequest['executable'];
    /** Captured operation credentials; never copied into native arguments. */
    environment?: PluginExecSpawnRequest['env'];
}) {
    // Plugin Exec is an explicit environment boundary and intentionally does
    // not inherit the daemon process environment. Cua resolves its embedded
    // state below HOME; provide the daemon user's real home so Happier and the
    // user's own `cua` CLI share one sandbox registry and image cache.
    const environment = { ...options.environment, HOME: homedir() };
    // Pinned trycua/cua@2bce4442: sandbox.rs Cp/cp/env_of uses the exact
    // qualified sandbox and native SHA256-verified upload. Shell's noninteractive
    // branch calls shell::exec with raw buffered bytes and stdin:false. Private
    // stdin therefore travels as a file inside mktemp's 0700 guest directory;
    // neither payload bytes nor native credentials enter argv or JSON results.
    async function shell(sandboxId: string, command: string, signal?: AbortSignal, guestProcess = false, timeoutMs?: number | null) {
        signal?.throwIfAborted();
        const qualified = qualifiedSandboxId(sandboxId);
        try {
            return await options.exec.run({ executable: options.executable,
                args: ['--embedded', 'sandbox', 'shell', qualified, command], env: environment,
                ...(timeoutMs == null ? {} : { timeoutMs }) }, { signal,
                ...(guestProcess ? { outputDelivery: 'invocation' as const } : {}) });
        } catch { throw new Error('cua_native_exec_unavailable'); }
    }
    async function privateDirectory(sandboxId: string, signal?: AbortSignal) {
        const made = await shell(sandboxId, 'mktemp -d /tmp/happier-cua.XXXXXXXXXX', signal);
        if (!completed(made) || made.stdoutTruncated) throw new Error('cua_private_input_unavailable');
        const directory = new TextDecoder('utf-8', { fatal: true }).decode(made.stdout).trim();
        // Bound cleanup to a directory created by this exact native template.
        if (!privateDirectoryPattern.test(directory)) throw new Error('cua_private_input_unavailable');
        return directory;
    }
    async function removePrivateDirectory(sandboxId: string, directory: string) {
        if (!privateDirectoryPattern.test(directory)) throw new Error('cua_private_input_cleanup_unknown');
        // Native partial-upload siblings also belong to this exact private
        // directory. An aborted/retired host invocation may forbid cleanup.
        try {
            const cleaned = await shell(sandboxId, `rm -rf -- ${quote(directory)}`);
            if (!completed(cleaned)) throw new Error('cleanup failed');
        } catch { throw new Error('cua_private_input_cleanup_unknown'); }
    }
    async function uploadPrivateFile(sandboxId: string, guestPath: string, bytes: Uint8Array, signal?: AbortSignal) {
        signal?.throwIfAborted();
        qualifiedSandboxId(sandboxId);
        const temporary = createSecureTempDirectorySync({ prefix: 'happier-cua-bootstrap' });
        try {
            const source = join(temporary.path, 'payload');
            await writeAtomicFile({ path: source, contents: bytes, mode: 0o600 });
            // AtomicWriter creates a 0644 temporary sibling before preserving
            // destination permissions. Its target must remain inside the
            // caller's private 0700 directory throughout the native transfer.
            const copied = await run(['--embedded', 'sandbox', 'cp', source, `${sandboxId}:${guestPath}`], signal);
            if (copied.kind !== 'success' || copied.value.stdoutTruncated) return { kind: 'unknown' as const };
            let value: unknown;
            try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copied.value.stdout)); }
            catch { return { kind: 'unknown' as const }; }
            const parsed = uploadSchema.safeParse(value);
            if (!parsed.success || parsed.data.size !== bytes.byteLength
                || parsed.data.sha256 !== createHash('sha256').update(bytes).digest('hex')) return { kind: 'unknown' as const };
            return { kind: 'confirmed' as const };
        } finally { temporary.cleanup(); }
    }
    async function putGuestFile(sandboxId: string, guestPath: string, bytes: Uint8Array, mode = 0o600, signal?: AbortSignal) {
        qualifiedSandboxId(sandboxId);
        path(guestPath);
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('cua_invalid_guest_mode');
        const directory = await privateDirectory(sandboxId, signal);
        const staged = `${directory}/payload`;
        try {
            const copied = await uploadPrivateFile(sandboxId, staged, bytes, signal);
            if (copied.kind !== 'confirmed') return { kind: 'unknown' as const };
            const published = await shell(sandboxId, `chmod ${mode.toString(8)} ${quote(staged)} && mv -- ${quote(staged)} ${quote(guestPath)}`, signal);
            return { kind: completed(published) ? 'confirmed' as const : 'unknown' as const };
        } finally {
            try { await removePrivateDirectory(sandboxId, directory); }
            catch { return { kind: 'unknown' as const }; }
        }
    }
    async function run(args: readonly string[], signal?: AbortSignal) {
        signal?.throwIfAborted();
        // trycua/cua@2bce4442 cua-vmm/qemu/mod.rs backgrounds QEMU from
        // embedded local launches. The native runtime owns those descendants.
        const startsLocalRuntime = args[0] === '--embedded'
            && ((args[1] === 'sandbox' && args[2] === 'resume' && args[3]?.startsWith('local:'))
                || ((args[1] === 'sandbox' || args[1] === 'spaces') && args[2] === 'create' && args.includes('--on=local')));
        try {
            const result = await options.exec.run({ executable: options.executable, args: ['--json', ...args], env: environment }, {
                signal, ...(startsLocalRuntime ? { descendantDisposition: 'preserve-on-success' as const } : {}),
            });
            if (result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 3
                && result.termination.requestedBy.kind === 'none') {
                return { kind: 'unknown', reason: 'not_found' } as const;
            }
            if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0
                || result.termination.requestedBy.kind !== 'none') {
                return { kind: 'unknown', reason: 'termination' } as const;
            }
            return { kind: 'success', value: result } as const;
        } catch {
            // Native failures may carry credentials or service URLs. The durable
            // host owner keeps recovery identity; never project native error text.
            return { kind: 'unknown', reason: 'transport' } as const;
        }
    }
    return {
        putGuestFile,
        async configureGuestProcess(sandboxId: string, detachedArgv: readonly string[], signal?: AbortSignal) {
            qualifiedSandboxId(sandboxId);
            if (!detachedArgv.length || detachedArgv.some((arg) => arg.includes('\0'))) throw new Error('cua_invalid_guest_argv');
            const command = detachedArgv.map(quote).join(' ');
            try {
                // The finite guest command delegates detachment to Happier's
                // canonical daemon-start owner and does not return until that
                // detached daemon answers. cua-spacesd, not this carrier or the
                // controller operation, then owns the guest process lifetime.
                const started = await shell(sandboxId, command, signal, true);
                if (!confirmedDaemonStart(started)) throw new Error('cua_guest_daemon_start_unconfirmed');
            } catch (error) {
                throw new PluginError({ code: 'cua_guest_daemon_hold_unavailable',
                    message: 'Cua could not confirm the detached guest daemon start.' }, { cause: error });
            }
        },
        async execGuest(sandboxId: string, argv: readonly string[], input?: Uint8Array, signal?: AbortSignal, timeoutMs?: number | null) {
            qualifiedSandboxId(sandboxId);
            if (!argv.length || argv.some((arg) => arg.includes('\0'))) throw new Error('cua_invalid_guest_argv');
            const command = argv.map(quote).join(' ');
            if (input === undefined) return shell(sandboxId, command, signal, true, timeoutMs);
            const directory = await privateDirectory(sandboxId, signal);
            const guestPath = `${directory}/stdin`;
            try {
                const copied = await uploadPrivateFile(sandboxId, guestPath, input, signal);
                if (copied.kind !== 'confirmed') throw new Error('cua_private_input_unavailable');
                return await shell(sandboxId, `${command} < ${quote(guestPath)}`, signal, true, timeoutMs);
            } finally {
                await removePrivateDirectory(sandboxId, directory);
            }
        },
        async json(args: readonly string[], signal?: AbortSignal): Promise<CuaNativeOutcome<unknown>> {
            const result = await run(args, signal);
            if (result.kind !== 'success') return result;
            if (result.value.stdoutTruncated) return { kind: 'unknown', reason: 'truncated' };
            try {
                return { kind: 'success', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.value.stdout)) };
            } catch {
                return { kind: 'unknown', reason: 'response' };
            }
        },
        async effect(args: readonly string[], signal?: AbortSignal): Promise<CuaNativeOutcome<undefined>> {
            const result = await run(args, signal);
            return result.kind === 'success' ? { kind: 'success', value: undefined } : result;
        },
    };
}
export type CuaNativeClient = ReturnType<typeof createCuaNativeClient>;
