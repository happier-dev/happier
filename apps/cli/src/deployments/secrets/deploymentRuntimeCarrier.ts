/** Construct only inside the existing source/runtime attachment closure;
 * plugins receive neither this callback nor environment bytes.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import type { ProviderRedactionLease } from '@/providers/spawn/redaction';
import { createProtectedLocalStateDirectory, createProtectedLocalStateFileExclusive,
    writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';

export type HostRuntimeDockerTuple = Readonly<{
    command: string;
    /** Exact resolved executable prefix, distinct from the host-authored request. */
    prefix: readonly string[];
    /** Host-authored Docker request arguments, excluding the resolved prefix. */
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
}>;
export type HostRuntimeProjectedDockerInput = Readonly<{
    /** Only the native owner may losslessly rewrite an owned root flag. */
    nativePrefix?: readonly string[];
    /** Only normalization may transport colliding original host controls here.
     * Exec preserves its resolved prefix and checks these actual extra args.
     */
    prefixArguments?: readonly string[];
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    stdin?: Uint8Array;
}>;
export type HostRuntimeCarrierFiles = Readonly<{
    interpolationFile: string;
    emptyEnvironmentFile: string;
    includeFile: string;
    projectionFile: string;
}>;
export type HostDeploymentRuntimeProjectionV1 = Readonly<{
    source: DeploymentSourceMaterializationV1;
    prepare(input: Readonly<{
        host: HostRuntimeDockerTuple;
        /** Native declared-use inventory intersected with admitted bound names;
         * unbound/default semantics remain native. Never all phase rows by default.
         */
        files(selectedNames: readonly string[]): Promise<HostRuntimeCarrierFiles>;
        /** Same native --env-file control for the value-free model inventory,
         * before binding selection. No application values enter this file. */
        emptyEnvironmentFile(): Promise<string>;
        /** Same global file: only a private literal-empty native lookup, never
         * application names/values or a second persisted environment store. */
        emptyValueAlias(occupiedNames: readonly string[]): Promise<string>;
        environmentNames: readonly string[];
        redaction: ProviderRedactionLease;
        signal?: AbortSignal;
        retainBytes(bytes: Uint8Array): void;
        assertCurrent(): Promise<void>;
        /** The existing Exec finalizer admits this exact helper tuple BEFORE
         * the phase owner's existing native IO executes it. Same executable,
         * cwd/admission and attachment; not a raw pre-finalizer process escape.
         */
        admitNormalization(input: HostRuntimeProjectedDockerInput): Promise<Readonly<{
            command: string;
            args: readonly string[];
            cwd: string;
            env: Readonly<Record<string, string>>;
            stdin?: Uint8Array;
            release(): void | Promise<void>;
        }>>;
    }>): Promise<HostRuntimeProjectedDockerInput>;
}>;

/** Encoding only, never parsing/interpreting a source expression. Pinned native
 * compose-go2.9.0 dotenv/parser.go142-192/203-230 owns all decoding/expansion.
 * Native double-quoted values retain raw Unicode/control bytes; escape only
 * characters that native parsing interprets. '$' is native escaped, never eval.
 */
function encodeNativeInterpolationInputs(environment: Readonly<Record<string, string>>, names: readonly string[]): Buffer {
    const escapes: Readonly<Record<string, string>> = { '\\': '\\\\', '"': '\\"', '$': '\\$', '\r': '\\r', '\n': '\\n' };
    return Buffer.from(names.map(name => `${name}="${environment[name]!.replace(/[\\"$\r\n]/gu,
        character => escapes[character]!)}"`).join('\n') + '\n', 'utf8');
}

/** Admitted runtime projection only. Helper files are consumed by config,
 * never bind-mounted by the effect. They retire after physical CLI settlement,
 * independently of retained native uncertainty/redaction custody.
 * Public pre-consumption attachment.dispose still has zero carrier resources.
 */
export function createAttachmentRuntimeCarrierForHost(input: Readonly<{
    source: DeploymentSourceMaterializationV1;
    environment: Readonly<Record<string, string>>;
    redaction: ProviderRedactionLease;
    assertCurrent(): Promise<void>;
}>) {
    let disposed = false;
    let directory: string | undefined;
    let creatingDirectory: Promise<string> | undefined;
    let files: Promise<HostRuntimeCarrierFiles> | undefined;
    let declaredNames: readonly string[] | undefined;
    let emptyEnvironmentFile: Promise<string> | undefined;
    let emptyAlias: Promise<string> | undefined;
    const buffers = new Set<Uint8Array>();
    // Only this attachment's actual in-progress fs operations; not a queue or
    // shared registry. Cleanup joins them before removing their owned directory.
    const pendingFiles: Promise<unknown>[] = [];
    let preparation: Promise<HostRuntimeProjectedDockerInput> | undefined;
    let cleanup: Promise<void> | undefined;
    const unavailable = (): never => { throw new PluginError({ code: 'service_admission_unavailable',
        message: 'The admitted runtime carrier is unavailable', details: { reason: 'deployment_attachment_unavailable' } }); };
    const retireFiles = (): Promise<void> => {
        if (cleanup) return cleanup;
        disposed = true;
        cleanup = (async () => {
            // preparation is the original work promise, NOT the catch wrapper
            // that awaits dispose; no self-await on failure/cancellation.
            await preparation?.catch(() => undefined);
            await Promise.allSettled(pendingFiles);
            try { for (const bytes of buffers) bytes.fill(0); }
            finally { buffers.clear(); if (directory) await rm(directory, { recursive: true, force: true }); }
        })();
        return cleanup;
    };
    const retainBytes = (bytes: Uint8Array) => {
        if (disposed) { bytes.fill(0); return unavailable(); }
        buffers.add(bytes);
    };
    const ensureDirectory = (): Promise<string> => {
        if (disposed) return unavailable();
        return creatingDirectory ??= (async () => {
            directory = await createProtectedLocalStateDirectory(join(tmpdir(), 'happier-runtime-carrier-'));
            if (disposed) return unavailable();
            return directory;
        })();
    };
    const allocateEmptyEnvironmentFile = (): Promise<string> => {
        if (disposed) return unavailable();
        if (!emptyEnvironmentFile) {
            emptyEnvironmentFile = (async () => {
                const path = join(await ensureDirectory(), 'empty.env');
                await createProtectedLocalStateFileExclusive(path, '');
                if (disposed) return unavailable();
                return path;
            })();
            pendingFiles.push(emptyEnvironmentFile);
        }
        return emptyEnvironmentFile;
    };
    const allocateFiles = (selectedNames: readonly string[]): Promise<HostRuntimeCarrierFiles> => {
        if (disposed) return unavailable();
        const names = [...new Set(selectedNames)].sort();
        if (names.some(name => !Object.hasOwn(input.environment, name))) return unavailable();
        if (files) {
            if (names.length !== declaredNames?.length || names.some((name, index) => name !== declaredNames![index])) return unavailable();
            return files;
        }
        declaredNames = Object.freeze(names);
        files = (async () => {
            const owned = await ensureDirectory();
            const interpolationFile = join(owned, 'interpolation.env');
            const emptyEnvironmentFile = await allocateEmptyEnvironmentFile();
            const includeFile = join(owned, 'include.json');
            const projectionFile = join(owned, 'phase.json');
            const encoded = encodeNativeInterpolationInputs(input.environment, names);
            try { await createProtectedLocalStateFileExclusive(interpolationFile, encoded); }
            finally { encoded.fill(0); }
            if (disposed) return unavailable();
            return Object.freeze({ interpolationFile, emptyEnvironmentFile, includeFile, projectionFile });
        })();
        pendingFiles.push(files);
        return files;
    };
    const emptyValueAlias = (occupiedNames: readonly string[]): Promise<string> => {
        if (disposed || !files) return unavailable();
        return emptyAlias ??= (() => {
            const writing = (async () => {
                const occupied = new Set([...occupiedNames, ...Object.keys(input.environment)].map(name => name.toUpperCase()));
                let name = 'HAPPIER_NATIVE_EMPTY_VALUE';
                let ordinal = 0;
                while (occupied.has(name)) name = `HAPPIER_NATIVE_EMPTY_VALUE_${++ordinal}`;
                const owned = await files;
                if (!owned || disposed) return unavailable();
                // No new file/resource. Native dotenv obtains a literal empty
                // Project.Environment value without putting it into OS env.
                await writeProtectedLocalStateFileAtomic(owned.emptyEnvironmentFile, `${name}=\n`);
                if (disposed) return unavailable();
                return name;
            })();
            pendingFiles.push(writing);
            return writing;
        })();
    };
    // Native config emits '$$' in reloadable JSON. The SAME redactor must
    // hide both native encoded review/output bytes and actual app output.
    input.redaction.add(input.redaction.values().map(value => value.replaceAll('$', () => '$$')));
    return {
        dispose: retireFiles,
        retireFiles,
        retainBytes,
        async project(projection: HostDeploymentRuntimeProjectionV1, host: HostRuntimeDockerTuple,
            admitNormalization: Parameters<HostDeploymentRuntimeProjectionV1['prepare']>[0]['admitNormalization'], signal?: AbortSignal) {
            if (preparation || disposed || signal?.aborted || projection.source !== input.source) return unavailable();
            preparation = (async () => {
                await input.assertCurrent();
                if (disposed || signal?.aborted) return unavailable();
                const projected = await projection.prepare({ host, files: allocateFiles, emptyEnvironmentFile: allocateEmptyEnvironmentFile,
                    emptyValueAlias, admitNormalization,
                    environmentNames: Object.freeze(Object.keys(input.environment)), redaction: input.redaction,
                    retainBytes, assertCurrent: input.assertCurrent, ...(signal ? { signal } : {}) });
                if (projected.stdin) retainBytes(projected.stdin);
                await input.assertCurrent();
                if (disposed || signal?.aborted) return unavailable();
                return projected;
            })();
            try {
                return await preparation;
            } catch (error) { await retireFiles(); throw error; }
        },
    };
}
