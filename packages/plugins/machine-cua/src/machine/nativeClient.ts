import { projectMachineProvisionerActionFailure, MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1, type MachineProvisionerNativeCauseV1, type ManagedGuestCliBuildInputV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectPluginFailureText, PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService, PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import { createSecureTempDirectorySync, writeAtomicFile } from '@happier-dev/plugin-sdk/fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import * as z from 'zod/mini';
import { CuaLocalNameSchema, type CuaLocalLaunchV1 } from './schemas.js';

const checkpointSchema = z.object({ name: z.string(), source: z.string(), runtime_type: z.string(),
    pinned: z.boolean(), host: z.string() });
export const CUA_PREPARATION_HOME = '/opt/happier';
export function cuaPreparedNames(operationId: string) {
    CuaLocalNameSchema.parse(operationId);
    return { builder: `happier-prepared-build-${operationId}`, checkpoint: `happier-prepared-${operationId}` };
}
export function cuaLocalNativeImage(launch: CuaLocalLaunchV1, kind: 'sandbox' | 'space') {
    return kind === 'space' && launch.runtimeId === 'qemu' && launch.preparedOperationId !== undefined
        ? `checkpoint:${cuaPreparedNames(launch.preparedOperationId).checkpoint}` : launch.imageId;
}

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
    | Readonly<{ kind: 'unknown'; reason: 'transport' | 'termination' | 'truncated' | 'response'; nativeCause?: MachineProvisionerNativeCauseV1 }>
    // Native exit 3 is Cua's typed NotFound for the exact id the command named.
    | Readonly<{ kind: 'unknown'; reason: 'not_found'; nativeCause?: MachineProvisionerNativeCauseV1 }>;

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
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => { throw new Error('cua_native_exec_unavailable'); }); }
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
        } catch (error) { return projectMachineProvisionerActionFailure(error, () => { throw new Error('cua_private_input_cleanup_unknown'); }); }
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
            catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const })); }
        }
    }
    async function run(args: readonly string[], signal?: AbortSignal) {
        signal?.throwIfAborted();
        // trycua/cua@2bce4442 cua-vmm/qemu/mod.rs backgrounds QEMU from
        // embedded local launches. The native runtime owns those descendants.
        const startsLocalRuntime = args[0] === '--embedded'
            && ((args[1] === 'sandbox' && args[2] === 'resume' && args[3]?.startsWith('local:'))
                || ((args[1] === 'sandbox' || args[1] === 'spaces') && args[2] === 'create' && args.includes('--on=local')));
        let nativeCause: MachineProvisionerNativeCauseV1 | undefined;
        try {
            const result = await options.exec.run({ executable: options.executable, args: ['--json', ...args], env: environment }, {
                signal, ...(startsLocalRuntime ? { descendantDisposition: 'preserve-on-success' as const } : {}),
            });
            const success = completed(result);
            if (args.includes('create') && !success) {
                const observed = result.termination.observed;
                const stderr = projectPluginFailureText(new Error(new TextDecoder().decode(result.stderr))).trim();
                nativeCause = { localCause: 'native_command_failed', command: 'create',
                    exitCode: observed.kind === 'exit' && result.termination.requestedBy.kind === 'none' ? observed.exitCode : null,
                    ...(stderr ? { stderr: stderr.slice(-MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1) } : {}),
                    ...(result.stderrTruncated || stderr.length > MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 ? { stderrTruncated: true } : {}),
                };
            }
            if (result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 3
                && result.termination.requestedBy.kind === 'none') {
                return { kind: 'unknown', reason: 'not_found', ...(nativeCause ? { nativeCause } : {}) } as const;
            }
            if (!success) {
                return { kind: 'unknown', reason: 'termination', ...(nativeCause ? { nativeCause } : {}) } as const;
            }
            return { kind: 'success', value: result } as const;
        } catch (error) {
            // Thrown transport errors can carry private input; retain only the
            // command classification, never their message.
            return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', reason: 'transport', ...(args.includes('create') ? { nativeCause: {
                localCause: 'native_command_failed' as const, command: 'create' as const, exitCode: null,
            } } : {}) } as const));
        }
    }
    return {
        /** v0.27.5 CheckpointSummary: embedded local records only, never a remote host or another source. */
        async preparedCheckpoint(operationId: string, launch: CuaLocalLaunchV1, signal?: AbortSignal) {
            const names = cuaPreparedNames(operationId);
            const response = await this.json(['--embedded', 'sandbox', 'checkpoints'], signal);
            const parsed = response.kind === 'success' ? z.array(checkpointSchema).safeParse(response.value) : undefined;
            if (!parsed?.success) return { kind: 'unknown' as const };
            const matches = parsed.data.filter(row => row.name === names.checkpoint);
            if (!matches.length) return { kind: 'absent' as const };
            const row = matches[0];
            // Space VM checkpoints need not retain a registry image. Source is
            // the exact operation-owned builder; S1 owns its retained launch choices.
            if (matches.length !== 1 || row.source !== names.builder || row.runtime_type !== launch.runtimeId
                || row.host !== '') return { kind: 'unknown' as const };
            return { kind: 'present' as const, pinned: row.pinned };
        },
        /** cua-sdk-v0.27.5 shell::stream preserves argv/bytes, forwards signals and kills on disconnect. */
        async streamGuest(sandboxId: string, argv: readonly string[], exec: Pick<ExecService, 'spawn'>, signal?: AbortSignal) {
            signal?.throwIfAborted();
            return exec.spawn({ executable: options.executable,
                args: ['--embedded', 'sandbox', 'exec', '-i', '--timeout', '0', qualifiedSandboxId(sandboxId), '--', ...argv],
                env: environment }, { signal, outputDelivery: 'invocation' });
        },
        putGuestFile,
        async prepareGuest(sandboxId: string, cli: ManagedGuestCliBuildInputV1, setupScript?: string, signal?: AbortSignal) {
            const directory = await privateDirectory(sandboxId, signal);
            try {
                for (const file of cli.files) {
                    const relative = posix.normalize(file.path);
                    if (relative === '.' || relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)
                        || relative.includes('\\') || relative.includes('\0')) throw new Error('cua_invalid_guest_path');
                    const destination = `${directory}/${relative}`;
                    const made = await shell(sandboxId, `mkdir -p -- ${quote(posix.dirname(destination))}`, signal);
                    if (!completed(made) || (await uploadPrivateFile(sandboxId, destination, Buffer.from(file.contentsBase64, 'base64'), signal)).kind !== 'confirmed') {
                        throw new Error('cua_private_input_unavailable');
                    }
                }
                // Only this build effect needs root. Preserve the image's user;
                // missing passwordless sudo fails visibly before a checkpoint.
                const script = `set -eu\ncd -- ${quote(directory)}\nsh -c ${quote(cli.installScript)}\nchmod -R a+rX ${quote(CUA_PREPARATION_HOME)}\nsh -c ${quote(setupScript ?? '')}\n`;
                return await this.execGuest(sandboxId, ['sh', '-c',
                    'if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi', 'happier-prepare', 'sh', '-s'],
                new TextEncoder().encode(script), signal);
            } finally { await removePrivateDirectory(sandboxId, directory); }
        },
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
                return projectMachineProvisionerActionFailure(error, () => {
                    throw new PluginError({ code: 'cua_guest_daemon_hold_unavailable',
                        message: 'Cua could not confirm the detached guest daemon start.' }, { cause: error });
                });
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
