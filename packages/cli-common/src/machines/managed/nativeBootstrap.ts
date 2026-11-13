import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedNativeBootstrapIO } from '../../systemTasks/kinds/managedMachineEnrollment.js';
import type { ManagedNativeInvocation } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import type { ManagedBootstrapCarrierV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { safeBashSingleQuote } from '../../ssh/shellQuote.js';
import { buildRemoteHappierInvocationCommand } from '../../systemTasks/ssh/remoteBootstrapCommandBuilder.js';
import { normalizeRemoteReleaseArch, normalizeRemoteReleaseOs } from '../../systemTasks/ssh/remoteFirstPartyInstallPath.js';

type NativeGuestHome = NonNullable<Extract<ManagedBootstrapCarrierV1, { kind: 'native' }>['guestHome']>;

/** Enrollment and retained Start use the same namespace. */
export function buildManagedNativeGuestCommand(command: string, guestHome?: Pick<NativeGuestHome, 'homeDir' | 'happyHomeDir'>): string {
    return guestHome
        ? `export HOME=${safeBashSingleQuote(guestHome.homeDir)} HAPPIER_HOME_DIR=${safeBashSingleQuote(guestHome.happyHomeDir)}; cd ${safeBashSingleQuote(guestHome.homeDir)} && ${command}`
        : command;
}

/** Reuse the installed identity; starting a retained guest never installs or pairs. */
export async function startManagedNativeGuestDaemon(input: Readonly<{
    native: ManagedNativeBootstrapIO; binaryPath: string; channel: 'stable' | 'preview' | 'dev';
    guestHome?: NativeGuestHome; signal?: AbortSignal; timeoutMs?: number;
}>): Promise<void> {
    input.signal?.throwIfAborted();
    const detachedCommand = `exec env ${buildRemoteHappierInvocationCommand({ binaryPath: input.binaryPath,
        args: ['daemon', 'start', '--json'], channel: input.channel })}`;
    const configured = await input.native.exec({
        command: buildManagedNativeGuestCommand(input.guestHome
            ? `exec env ${buildRemoteHappierInvocationCommand({ binaryPath: input.binaryPath,
                args: ['daemon', 'start-sync'], channel: input.channel })}` : detachedCommand, input.guestHome),
        signal: input.signal, timeoutMs: input.timeoutMs,
        ...(input.guestHome ? { processConfig: {
            environment: { HOME: input.guestHome.homeDir, HAPPIER_HOME_DIR: input.guestHome.happyHomeDir },
            detachedDaemonStartArgv: ['sh', '-c', buildManagedNativeGuestCommand(detachedCommand, input.guestHome)],
        } } : {}),
    });
    if (configured.status !== 0) throw new SystemTaskExecutionError('native_boot_unconfirmed', 'The native daemon startup was not confirmed.');
    input.signal?.throwIfAborted();
}

/** Adapt the provider's native byte/exec roles to the one shared enrollment recipe. */
export function createManagedNativeBootstrapIO(correlation: Pick<ManagedEnrollmentCorrelationV1, 'resource'>, invoke: ManagedNativeInvocation): ManagedNativeBootstrapIO {
    return {
        exec: async request => {
            const result = MachineProvisionerNativeExecResultV1Schema.parse(await invoke('exec', {
                resource: correlation.resource.value, argv: ['sh', '-c', request.command],
                ...(request.allowWake === false ? { allowWake: false } : {}),
                ...(request.input === undefined ? {} : { inputBase64: encodeBase64(new TextEncoder().encode(request.input)) }),
                ...(request.processConfig ? { processConfig: request.processConfig } : {}),
            }, request));
            if ('kind' in result) {
                if (!request.processConfig) throw new SystemTaskExecutionError('provider_unavailable',
                    'Native guest command failed (process configured without completion).');
                return { status: 0, stdout: '', stderr: '' };
            }
            if (request.processConfig) throw new ManagedMachineControllerError('native_boot_unconfirmed');
            if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit'
                || result.stdoutTruncated || result.stderrTruncated) {
                const { requestedBy, observed } = result.termination;
                const facts = [`requested ${requestedBy.kind}`, `observed ${observed.kind}`,
                    ...(observed.kind === 'exit' ? [`exit ${observed.exitCode}`] : []),
                    `stdout truncated ${result.stdoutTruncated}`, `stderr truncated ${result.stderrTruncated}`];
                if (requestedBy.kind === 'dispose' && requestedBy.reason) facts.push(`dispose reason ${requestedBy.reason}`);
                if (observed.kind === 'failed') {
                    const code = readUnexpectedActionErrorDiagnosticV1({ code: observed.diagnostic.code }).errorCode;
                    if (code !== null) facts.push(`code ${code}`);
                }
                throw new SystemTaskExecutionError('provider_unavailable', `Native guest command failed (${facts.join('; ')}).`);
            }
            return { status: result.termination.observed.exitCode,
                stdout: new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(result.stdoutBase64)),
                stderr: new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(result.stderrBase64)) };
        },
        putFile: async request => {
            const result = MachineProvisionerPutFileResultV1Schema.parse(await invoke('putFile', {
                resource: correlation.resource.value, guestPath: request.path, bytesBase64: encodeBase64(request.bytes),
            }, request));
            if (result.kind !== 'confirmed') throw new ManagedMachineControllerError(result.code ?? 'provider_unavailable', undefined,
                result.nativeCause ? { kind: 'managedNative', nativeCause: result.nativeCause } : undefined);
        },
    };
}

export type ManagedGuestPlatform = Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64'; home: string }>;

/** The one guest platform probe (enrollment and Session holder bootstrap). */
export async function probeManagedNativeGuestPlatform(exec: ManagedNativeBootstrapIO['exec'], signal?: AbortSignal): Promise<ManagedGuestPlatform> {
    const platform = await exec({ command: 'uname -s; uname -m; printf "%s\\n" "$HOME"', signal });
    if (platform.status !== 0) throw new SystemTaskExecutionError('provider_unavailable', 'Native guest platform could not be observed.');
    const [os, arch, home] = platform.stdout.trim().split(/\r?\n/u);
    if (!home?.startsWith('/')) throw new SystemTaskExecutionError('provider_unavailable', 'Native guest home could not be observed.');
    return { os: normalizeRemoteReleaseOs(os), arch: normalizeRemoteReleaseArch(arch), home };
}

export type SessionHolderArtifact = Readonly<{ bytes: Uint8Array; sha256: string }>;
export type ManagedGuestSessionHolder = Readonly<{ holderPath: string; helperPath: string; socketDirectory: string; platform: ManagedGuestPlatform }>;

/** Portable (this barrel is also bundled for the web UI): Web Crypto, no `node:` import. */
function stagingSuffix(): string {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('');
}

const SESSION_HOLDER_FILES = { holder: 'happier-session-holder', helper: 'happier-process-custody' } as const;

/**
 * Places the static Session holder and the process-custody helper in a guest
 * that runs no Happier daemon (placement "target"), through the provider's
 * `exec` and `putFile` roles: `~/.happier/holder/<version>/`, each file verified
 * by sha256 inside the guest before it is promoted. Files already present with
 * the expected digest are reused. The architecture comes from the shared probe;
 * the binaries are static, so no libc probe is needed.
 */
export async function ensureManagedGuestSessionHolder(input: Readonly<{
    io: Pick<ManagedNativeBootstrapIO, 'exec' | 'putFile'>;
    version: string;
    resolveArtifacts(platform: ManagedGuestPlatform): Promise<Readonly<{ holder: SessionHolderArtifact; helper: SessionHolderArtifact }>>;
    signal?: AbortSignal;
}>): Promise<ManagedGuestSessionHolder> {
    if (!/^[A-Za-z0-9._+-]+$/u.test(input.version)) throw new SystemTaskExecutionError('invalid_request', 'Session holder version is not a plain name.');
    const platform = await probeManagedNativeGuestPlatform(input.io.exec, input.signal);
    if (platform.os !== 'linux') {
        throw Object.assign(new Error('Session holder targets are Linux guests'), { code: 'session_holder_target_unsupported' });
    }
    const artifacts = await input.resolveArtifacts(platform);
    const q = safeBashSingleQuote;
    const directory = `${platform.home}/.happier/holder/${input.version}`;
    const socketDirectory = `${platform.home}/.happier/holder/run`;
    const run = async (command: string) => {
        const result = await input.io.exec({ command, signal: input.signal });
        if (result.status !== 0) throw new SystemTaskExecutionError('provider_unavailable', 'Session holder placement command failed in the guest.');
        return result.stdout;
    };
    await run(`umask 077; mkdir -p ${q(directory)} ${q(socketDirectory)} && chmod 700 ${q(socketDirectory)}`);
    const present = new Map((await input.io.exec({ command: `cd ${q(directory)} && sha256sum ${Object.values(SESSION_HOLDER_FILES).map(q).join(' ')} 2>/dev/null`, signal: input.signal }))
        .stdout.split('\n').map(line => line.trim().split(/\s+/u)).filter(parts => parts.length === 2).map(([digest, name]) => [name!, digest!]));
    for (const [key, name] of Object.entries(SESSION_HOLDER_FILES) as [keyof typeof SESSION_HOLDER_FILES, string][]) {
        const artifact = artifacts[key];
        if (present.get(name) === artifact.sha256) continue;
        const staged = `${directory}/.${name}.${stagingSuffix()}`;
        await input.io.putFile({ path: staged, bytes: artifact.bytes, signal: input.signal });
        const verified = await run(`if [ "$(sha256sum ${q(staged)} | cut -d' ' -f1)" = ${q(artifact.sha256)} ]; then chmod 755 ${q(staged)} && mv -f ${q(staged)} ${q(`${directory}/${name}`)} && echo promoted; else rm -f ${q(staged)}; echo mismatch; fi`);
        if (verified.trim() !== 'promoted') {
            throw Object.assign(new Error(`The ${name} payload did not verify in the guest`), { code: 'session_holder_digest_mismatch' });
        }
    }
    return { holderPath: `${directory}/${SESSION_HOLDER_FILES.holder}`, helperPath: `${directory}/${SESSION_HOLDER_FILES.helper}`, socketDirectory, platform };
}
