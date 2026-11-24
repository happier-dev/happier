import type { JsonValue } from '@happier-dev/protocol';
import type { ManagedNativeBootstrapIO } from '../../systemTasks/kinds/managedMachineEnrollment.js';
import type { ManagedNativeInvocation } from './reconcile.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createActionExecuteFailureError, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readGuestCliFailureOutput } from '@happier-dev/protocol/ssh/commandFailure';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { AcquireResultV1Schema, projectMachineProvisionerGuestCommandFailure, type ManagedBootstrapCarrierV1, type ManagedGuestPlatformV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { safeBashSingleQuote } from '../../ssh/shellQuote.js';
import { REMOTE_SHA256_FILE_FUNCTION } from '../../ssh/shellSha256.js';
import { buildRemoteHappierInvocationCommand } from '../../systemTasks/ssh/remoteBootstrapCommandBuilder.js';
import { normalizeRemoteReleaseArch, normalizeRemoteReleaseOs } from '../../systemTasks/ssh/remoteFirstPartyInstallPath.js';

type NativeCarrier = Extract<ManagedBootstrapCarrierV1, { kind: 'native' }>;
type NativeGuestHome = NonNullable<NativeCarrier['guestHome']>;

export const MANAGED_GUEST_PROCESS_ENV = 'HAPPIER_MANAGED_GUEST_PROCESS';

/** Pass the applied launch placement to the daemon, including across detached startup. */
export function buildManagedNativeGuestDaemonCommand(input: Parameters<typeof buildRemoteHappierInvocationCommand>[0]): string {
    return `exec env ${MANAGED_GUEST_PROCESS_ENV}=1 ${buildRemoteHappierInvocationCommand(input)}`;
}

/** Enrollment and retained Start use the same namespace. */
export function buildManagedNativeGuestCommand(command: string, guestHome?: Pick<NativeGuestHome, 'homeDir' | 'happyHomeDir'>): string {
    return guestHome
        ? `export HOME=${safeBashSingleQuote(guestHome.homeDir)} HAPPIER_HOME_DIR=${safeBashSingleQuote(guestHome.happyHomeDir)}; cd ${safeBashSingleQuote(guestHome.homeDir)} && ${command}`
        : command;
}

function readNativeDaemonStartFailure(stdout: string): string | undefined {
    try {
        const result: unknown = JSON.parse(stdout);
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== false || !('error' in result)) return;
        // The daemon start CLI emits these refusal codes. Drop its message and other guest output.
        if (result.error === 'installed_background_service_conflict' || result.error === 'owner_conflict'
            || result.error === 'start_failed') return result.error;
    } catch { /* A carrier can fail before the CLI emits JSON. */ }
}

/** Reuse the installed identity; starting a retained guest never installs or pairs. */
export async function startManagedNativeGuestDaemon(input: Readonly<{
    native: ManagedNativeBootstrapIO; binaryPath: string; channel: 'stable' | 'preview' | 'dev';
    guestHome?: NativeGuestHome; signal?: AbortSignal; timeoutMs?: number;
}>): Promise<void> {
    input.signal?.throwIfAborted();
    const detachedCommand = buildManagedNativeGuestDaemonCommand({ binaryPath: input.binaryPath,
        args: ['daemon', 'start', '--json'], channel: input.channel });
    const configured = await input.native.exec({
        command: buildManagedNativeGuestCommand(input.guestHome
            ? buildManagedNativeGuestDaemonCommand({ binaryPath: input.binaryPath,
                args: ['daemon', 'start-sync'], channel: input.channel }) : detachedCommand, input.guestHome),
        signal: input.signal, timeoutMs: input.timeoutMs,
        ...(input.guestHome ? { processConfig: {
            environment: { HOME: input.guestHome.homeDir, HAPPIER_HOME_DIR: input.guestHome.happyHomeDir },
            detachedDaemonStartArgv: ['sh', '-c', buildManagedNativeGuestCommand(detachedCommand, input.guestHome)],
        } } : {}),
    });
    input.signal?.throwIfAborted();
    if (configured.status === 0) return;
    const error = readNativeDaemonStartFailure(configured.stdout);
    if (!input.guestHome && error === 'installed_background_service_conflict') {
        // The guest CLI identified its installed owner. Start that service without changing its definition.
        const args = ['daemon', 'service', 'start', '--json'];
        const service = await input.native.exec({
            command: buildRemoteHappierInvocationCommand({ binaryPath: input.binaryPath, args, channel: input.channel }),
            signal: input.signal, timeoutMs: input.timeoutMs ?? null,
        });
        input.signal?.throwIfAborted();
        if (service.status === 0) return;
        const cause = readGuestCliFailureOutput(service.stdout, service.stderr);
        throw new SystemTaskExecutionError(cause?.guestCliCode ?? 'remote_command_failed',
            'The installed guest daemon service failed to start.');
    }
    throw new SystemTaskExecutionError(error ?? 'remote_command_failed', 'The native daemon startup was not confirmed.');
}

/** Adapt the provider's native byte/exec roles to the one shared enrollment recipe. */
export function createManagedNativeBootstrapIO(correlation: Readonly<{ resource: Readonly<{ value: JsonValue }> }>, invoke: ManagedNativeInvocation): ManagedNativeBootstrapIO {
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

export type ManagedGuestPlatform = Readonly<ManagedGuestPlatformV1>;

export async function resolveManagedNativeGuestStartup(carrier: NativeCarrier, exec: ManagedNativeBootstrapIO['exec'], signal?: AbortSignal):
    Promise<Readonly<{ home?: NativeGuestHome; platform?: ManagedGuestPlatform }>> {
    if (carrier.guestHome) return { home: carrier.guestHome };
    if (carrier.daemonStartup !== 'native-process') return {};
    const platform = await probeManagedNativeGuestPlatform(exec, signal);
    return { platform, home: { homeDir: platform.home, happyHomeDir: platform.home.replace(/\/$/u, '') + '/.happier',
        daemonStartup: carrier.daemonStartup } };
}

export const MANAGED_NATIVE_GUEST_PLATFORM_COMMAND = 'uname -s; uname -m; printf "%s\\n" "$HOME"';

/** The one guest platform probe (enrollment and Session holder bootstrap). */
export async function probeManagedNativeGuestPlatform(
    exec: ManagedNativeBootstrapIO['exec'],
    signal?: AbortSignal,
    forSessionHolder?: 'session-holder',
): Promise<ManagedGuestPlatform> {
    const platform = await exec({ command: MANAGED_NATIVE_GUEST_PLATFORM_COMMAND, signal });
    if (platform.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native guest platform could not be observed.');
    const [os, arch, home] = platform.stdout.trim().split(/\r?\n/u);
    let platformIdentity: Omit<ManagedGuestPlatform, 'home'>;
    try {
        platformIdentity = { os: normalizeRemoteReleaseOs(os), arch: normalizeRemoteReleaseArch(arch) };
    } catch (error) {
        if (!forSessionHolder) throw error;
        throw new SystemTaskExecutionError('session_holder_unavailable', 'This guest platform does not support a Session holder.');
    }
    if (!home?.startsWith('/')) throw new SystemTaskExecutionError('provider_unavailable', 'Native guest home could not be observed.');
    return { ...platformIdentity, home };
}

/** Prepares an existing guest for Home admission without starting it or delivering artifacts. */
export async function prepareManagedWorkspaceAttachment(input: Readonly<{
    managedId: string;
    launch: Pick<ValidatedLaunchSnapshotV1, 'provider' | 'schemaVersion' | 'choices'>;
    invoke: ManagedNativeInvocation;
    signal?: AbortSignal;
}>) {
    const { launch, signal, invoke } = input;
    signal?.throwIfAborted();
    const result = AcquireResultV1Schema.parse(await invoke('acquire', { managedId: input.managedId, launch: launch.choices }, { signal }));
    if (result.kind === 'rejected') throw new ManagedMachineControllerError(result.code, undefined,
        result.nativeCause ? { kind: 'managedNative', nativeCause: result.nativeCause } : undefined);
    if (result.kind !== 'bound' || result.startPending || result.resource.origin === 'created'
        || result.resource.contributionRef.pluginId !== launch.provider.pluginId
        || result.resource.contributionRef.localId !== launch.provider.localId
        || result.resource.schemaVersion !== launch.schemaVersion) throw new ManagedMachineControllerError('resource_mismatch');
    const { resource } = result;
    const io = createManagedNativeBootstrapIO({ resource }, invoke);
    const platform = await probeManagedNativeGuestPlatform(request => io.exec({ ...request, allowWake: false }), signal, 'session-holder')
        .catch((error: unknown) => {
            if (!(error instanceof SystemTaskExecutionError) || error.code !== 'session_holder_unavailable') throw error;
            throw ManagedMachineControllerError.fromActionFailure({ ok: false, errorCode: error.code, error: error.message },
                MANAGED_ACQUIRE_ACTION_ID_V1);
        });
    signal?.throwIfAborted();
    return { resource, platform };
}

export type SessionHolderArtifact = Readonly<{ bytes: Uint8Array; sha256: string }>;
export type ManagedGuestSessionHolder = Readonly<{ holderPath: string; helperPath: string; socketDirectory: string; platform: ManagedGuestPlatform }>;

/** Portable (this barrel is also bundled for the web UI): Web Crypto, no `node:` import. */
function stagingSuffix(): string {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('');
}

const SESSION_HOLDER_FILES = { holder: 'happier-session-holder', helper: 'happier-process-custody' } as const;

/**
 * Places the Session holder and the process-custody helper in a guest
 * that runs no Happier daemon (placement "target"), through the provider's
 * `exec` and `putFile` roles: `~/.happier/holder/<version>/`, each file verified
 * by sha256 inside the guest before it is promoted. Files already present with
 * the expected digest are reused. The architecture comes from the shared probe;
 * Linux binaries are static; Darwin binaries use the platform's libSystem.
 */
export async function ensureManagedGuestSessionHolder(input: Readonly<{
    io: Pick<ManagedNativeBootstrapIO, 'exec' | 'putFile'>;
    version: string;
    platform?: ManagedGuestPlatform;
    resolveArtifacts(platform: ManagedGuestPlatform): Promise<Readonly<{ holder: SessionHolderArtifact; helper: SessionHolderArtifact }>>;
    signal?: AbortSignal;
}>): Promise<ManagedGuestSessionHolder> {
    if (!/^[A-Za-z0-9._+-]+$/u.test(input.version)) throw new SystemTaskExecutionError('invalid_request', 'Session holder version is not a plain name.');
    const platform = input.platform ?? await probeManagedNativeGuestPlatform(input.io.exec, input.signal, 'session-holder');
    const artifacts = await input.resolveArtifacts(platform);
    const q = safeBashSingleQuote;
    const directory = `${platform.home}/.happier/holder/${input.version}`;
    const socketDirectory = `${platform.home}/.happier/holder/run`;
    const run = async (command: string) => {
        const result = await input.io.exec({ command, signal: input.signal });
        if (result.status !== 0) throw createActionExecuteFailureError({
            ok: false, errorCode: 'remote_command_failed', error: 'Session holder placement command failed in the guest.',
            details: { kind: 'managedNative', nativeCause: projectMachineProvisionerGuestCommandFailure({
                command: 'run', exitCode: result.status, stderr: result.stderr,
            }) },
        });
        return result.stdout;
    };
    await run(`umask 077; mkdir -p ${q(directory)} ${q(socketDirectory)} && chmod 700 ${q(socketDirectory)}`);
    const present = new Map((await input.io.exec({ command: `${REMOTE_SHA256_FILE_FUNCTION}; cd ${q(directory)} && sha256_files ${Object.values(SESSION_HOLDER_FILES).map(q).join(' ')} 2>/dev/null`, signal: input.signal }))
        .stdout.split('\n').map(line => line.trim().split(/\s+/u)).filter(parts => parts.length === 2).map(([digest, name]) => [name!, digest!]));
    for (const [key, name] of Object.entries(SESSION_HOLDER_FILES) as [keyof typeof SESSION_HOLDER_FILES, string][]) {
        const artifact = artifacts[key];
        if (present.get(name) === artifact.sha256) continue;
        const staged = `${directory}/.${name}.${stagingSuffix()}`;
        await input.io.putFile({ path: staged, bytes: artifact.bytes, signal: input.signal });
        const verified = await run(`${REMOTE_SHA256_FILE_FUNCTION}; if [ "$(sha256_file ${q(staged)})" = ${q(artifact.sha256)} ]; then chmod 755 ${q(staged)} && mv -f ${q(staged)} ${q(`${directory}/${name}`)} && echo promoted; else rm -f ${q(staged)}; echo mismatch; fi`);
        if (verified.trim() !== 'promoted') {
            throw Object.assign(new Error(`The ${name} payload did not verify in the guest`), { code: 'session_holder_digest_mismatch' });
        }
    }
    return { holderPath: `${directory}/${SESSION_HOLDER_FILES.holder}`, helperPath: `${directory}/${SESSION_HOLDER_FILES.helper}`, socketDirectory, platform };
}
