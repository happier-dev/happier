import type { ExecService, PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createSecureTempDirectorySync, writeAtomicFile } from '@happier-dev/plugin-sdk/fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod/mini';
import { CuaLocalNameSchema } from './schemas.js';
import { FleetNativeIdSchema } from './remoteSchemas.js';
import { decodeCuaAbortUpload, decodeCuaBeginUpload, decodeCuaGrpcWeb, decodeCuaProcess,
    decodeCuaUploadChunk, decodeCuaUploadSha256, encodeCuaAbortUpload, encodeCuaBeginUpload,
    encodeCuaCommitUpload, encodeCuaStartProcess, encodeCuaUploadChunk, frameCuaGrpcWeb } from './nativeGrpcWeb.js';

const uploadSchema = z.object({ direction: z.literal('upload'), size: z.number(), sha256: z.string() });
const privateDirectoryPattern = /^\/tmp\/happier-cua\.[A-Za-z0-9-]+$/u;
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function guestReference(value: string) {
    const [location, name, claimId, ...rest] = value.split(':');
    if (location === 'fleet' && rest.length === 0 && name !== undefined && claimId !== undefined) {
        return { kind: 'fleet' as const, namespace: FleetNativeIdSchema.parse(name), claimId: FleetNativeIdSchema.parse(claimId) };
    }
    if (!['local', 'aws', 'gcp', 'modal'].includes(location) || name === undefined || claimId !== undefined) {
        throw new Error('cua_qualified_resource_required');
    }
    CuaLocalNameSchema.parse(name);
    return { kind: 'sandbox' as const, id: value };
}
function path(value: string) {
    if (!value.startsWith('/') || value.endsWith('/') || value.includes('\0')) throw new Error('cua_invalid_guest_path');
    return value;
}
function completed(result: Awaited<ReturnType<ExecService['run']>>) {
    return result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
        && result.termination.requestedBy.kind === 'none';
}

export type CuaFleetNativeRequest = Readonly<{ method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown }>;
export type CuaFleetGuestTarget = Readonly<{ namespace: string; claimId: string }>;
export type CuaFleetGuestRoute = Readonly<{
    /** Relative native `api/svc/<namespace>/<bound-sandbox>-env` path. */
    path: string;
    headers?: Readonly<Record<string, string>>;
}>;

export type CuaNativeOutcome<T> =
    | Readonly<{ kind: 'success'; value: T }>
    | Readonly<{ kind: 'unknown'; reason: 'transport' | 'termination' | 'truncated' | 'response' }>;

export function createCuaNativeClient(options: {
    exec: Pick<ExecService, 'run'>;
    executable: PluginExecSpawnRequest['executable'];
    /** Captured operation credentials; never copied into native arguments. */
    environment?: PluginExecSpawnRequest['env'];
    /** Exact controller-local gateway base (including a path prefix); never Home-visible. */
    fleet?: Readonly<{ http: Pick<HttpService, 'request'>; origin: string; headers?: Readonly<Record<string, string>>;
        /** Private custody resolves the exact bound claim and both gateway and guest authorization. */
        guest?: (target: CuaFleetGuestTarget, signal?: AbortSignal) => Promise<CuaFleetGuestRoute | undefined>;
    }>;
}) {
    const environment = options.environment === undefined ? undefined : { ...options.environment };
    function fleetUrl(path: string) {
        const origin = new URL(options.fleet?.origin ?? '');
        if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
            || path.startsWith('//')) throw new Error('cua_native_gateway_invalid');
        if (!origin.pathname.endsWith('/')) origin.pathname += '/';
        const url = new URL(path, origin);
        if (url.origin !== origin.origin || url.username || url.password || url.hash) throw new Error('cua_native_gateway_invalid');
        return url;
    }
    async function fleetRpc(target: CuaFleetGuestTarget, service: 'ProcessService' | 'FilesystemService',
        method: string, message: Uint8Array, signal?: AbortSignal, timeoutMs?: number | null) {
        signal?.throwIfAborted();
        const fleet = options.fleet;
        if (!fleet?.guest) throw new Error('cua_native_exec_unavailable');
        try {
            const guest = await fleet.guest(target, signal);
            if (!guest) throw new Error('guest unavailable');
            const prefix = `api/svc/${target.namespace}/`;
            const nativeService = guest.path.slice(prefix.length);
            if (!guest.path.startsWith(prefix) || !nativeService.endsWith('-env')
                || !FleetNativeIdSchema.safeParse(nativeService).success) throw new Error('guest route invalid');
            const url = fleetUrl(`${guest.path}/cua.env.v1.${service}/${method}`);
            const headers = Object.fromEntries(Object.entries({ ...fleet.headers, ...guest.headers })
                .map(([name, value]) => [name.toLowerCase(), value] as const));
            if (!/^Bearer \S+$/u.test(headers.authorization ?? '')
                || !/^Bearer \S+$/u.test(headers['x-cua-env-authorization'] ?? '')) throw new Error('guest authorization unavailable');
            const response = await fleet.http.request({ url: url.href, method: 'POST',
                headers: { ...headers, 'x-cua-fleet-claim': target.claimId,
                    'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
                body: frameCuaGrpcWeb(message), redirect: 'error',
                ...(timeoutMs == null ? {} : { timeoutMs }) }, { signal });
            if (response.status !== 200 || response.finalUrl !== url.href) throw new Error('native response unavailable');
            return decodeCuaGrpcWeb(response.body);
        } catch { throw new Error('cua_native_exec_unavailable'); }
    }
    // Pinned trycua/cua@2bce4442: sandbox.rs Cp/cp/env_of uses the exact
    // qualified sandbox and native SHA256-verified upload. Shell's noninteractive
    // branch calls shell::exec with raw buffered bytes and stdin:false. Private
    // stdin therefore travels as a file inside mktemp's 0700 guest directory;
    // neither payload bytes nor native credentials enter argv or JSON results.
    async function shell(sandboxId: string, command: string, signal?: AbortSignal, guestProcess = false, timeoutMs?: number | null) {
        signal?.throwIfAborted();
        const reference = guestReference(sandboxId);
        if (reference.kind === 'fleet') {
            return decodeCuaProcess(await fleetRpc(reference, 'ProcessService', 'StartProcess',
                encodeCuaStartProcess(['/bin/sh', '-c', command]), signal, timeoutMs));
        }
        try {
            return await options.exec.run({ executable: options.executable,
                args: ['--embedded', 'sandbox', 'shell', reference.id, command], env: environment,
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
        const reference = guestReference(sandboxId);
        if (reference.kind === 'fleet') {
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            // Native upload identity allows abort even if BeginUpload's reply is lost.
            const uploadId = `happier-${randomUUID()}`;
            try {
                const began = decodeCuaBeginUpload(await fleetRpc(reference, 'FilesystemService', 'BeginUpload',
                    encodeCuaBeginUpload(guestPath, bytes.length, sha256, uploadId), signal));
                if (began.uploadId !== uploadId || began.received > bytes.length) throw new Error('upload identity or offset invalid');
                let offset = began.received;
                while (offset < bytes.length) {
                    const chunk = bytes.subarray(offset, offset + began.maxChunkBytes);
                    const received = decodeCuaUploadChunk(await fleetRpc(reference, 'FilesystemService', 'UploadChunk',
                        encodeCuaUploadChunk(uploadId, offset, chunk), signal));
                    if (received !== offset + chunk.length) throw new Error('upload acknowledgement invalid');
                    offset = received;
                }
                const confirmedSha256 = decodeCuaUploadSha256(await fleetRpc(reference, 'FilesystemService', 'CommitUpload',
                    encodeCuaCommitUpload(uploadId, sha256), signal));
                if (confirmedSha256 !== sha256) throw new Error('upload checksum invalid');
                return { kind: 'confirmed' as const };
            } catch {
                try {
                    // Cleanup has its own uncancelled call; an uncertain abort is
                    // never success. The containing owner also removes the exact
                    // private directory, including native partial-upload siblings.
                    decodeCuaAbortUpload(await fleetRpc(reference, 'FilesystemService', 'AbortUpload', encodeCuaAbortUpload(uploadId)));
                } catch { /* The failed transfer remains unknown. */ }
                return { kind: 'unknown' as const };
            }
        }
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
        guestReference(sandboxId);
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
        try {
            const result = await options.exec.run({ executable: options.executable, args: ['--json', ...args], env: environment }, { signal });
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
        async execGuest(sandboxId: string, argv: readonly string[], input?: Uint8Array, signal?: AbortSignal, timeoutMs?: number | null) {
            guestReference(sandboxId);
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
        async fleetJson(request: CuaFleetNativeRequest, signal?: AbortSignal): Promise<CuaNativeOutcome<{ status: number; value: unknown }>> {
            signal?.throwIfAborted();
            const fleet = options.fleet;
            if (!fleet) return { kind: 'unknown', reason: 'transport' };
            try {
                let url: URL;
                try { url = fleetUrl(request.path); }
                catch { return { kind: 'unknown', reason: 'response' }; }
                const response = await fleet.http.request({ url: url.href, method: request.method,
                    headers: { ...fleet.headers, ...(request.body !== undefined && { 'content-type': 'application/json' }) },
                    ...(request.body !== undefined && { body: new TextEncoder().encode(JSON.stringify(request.body)) }),
                    redirect: 'error' }, { signal });
                // Do not send a controller bearer to a redirected gateway.
                if (response.finalUrl !== url.href) return { kind: 'unknown', reason: 'response' };
                try {
                    const value: unknown = response.body.length === 0 ? null
                        : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
                    return { kind: 'success', value: { status: response.status, value } };
                } catch { return { kind: 'unknown', reason: 'response' }; }
            } catch {
                // HTTP/native errors can contain credentials and service URLs.
                return { kind: 'unknown', reason: 'transport' };
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
