import { parseSshTarget } from '@happier-dev/protocol/ssh/sshTarget';
import { SystemTaskJsonValueSchema } from '@happier-dev/protocol/system/tasks/spec';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import {
    buildRemoteBootstrapCommand,
    createOpenSshHappierJsonExecutor,
    createRemoteSshBootstrapMachineTaskKind,
    normalizeRemoteReleaseArch,
    normalizeRemoteReleaseOs,
    parseRemoteBootstrapMachineParams,
    resolveRemoteSelfDownloadFirstPartyInstallPlan,
    SystemTaskExecutionError,
    type RemoteSelfDownloadFirstPartyInstallPlan,
} from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';

import type { NativeSshModule } from '@happier-dev/ssh-native';

import { approveTerminalPairing } from '@/auth/terminal/approveTerminalPairing';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import {
    TokenStorage,
} from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import {
    buildHomeConnectionDescriptorForProfile,
    getServerProfileById,
    listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { isLoopbackHostname } from '@/sync/domains/server/url/serverUrlClassification';
import {
    NATIVE_SSH_BOOTSTRAP_TASK_KIND,
    type NativeSshTaskCredentials,
} from '../bridges/native';
import { buildNativeSystemTaskEvent } from '../bridges/events';
import { createNativeRemoteSshCommandRunner, type NativeRemoteSshCommandRunner } from './nativeCommandRunner';
export { readNativeSshBootstrapDedupeKey } from './nativeTaskIdentity';

type RemoteBootstrapMachineParams = ReturnType<typeof parseRemoteBootstrapMachineParams>;

export type NativeRemoteSshBootstrapEventSink = Readonly<{
    event: (payload: unknown) => void;
}>;

export type RunNativeRemoteSshBootstrapTaskParams = Readonly<{
    taskId: string;
    spec: Readonly<{
        kind: string;
        params: unknown;
    }>;
    nativeModule?: NativeSshModule | null;
    signal?: AbortSignal;
    events?: NativeRemoteSshBootstrapEventSink;
    commandRunner?: NativeRemoteSshCommandRunner;
    resolveInstallPlan?: (params: Readonly<{
        channel: 'stable' | 'preview' | 'publicdev';
        os: 'linux' | 'darwin';
        arch: 'x64' | 'arm64';
        remoteHomeDir?: string;
    }>) => Promise<RemoteSelfDownloadFirstPartyInstallPlan>;
    approveLocalAuthRequest?: (params: Readonly<{
        publicKey: string;
        homeServerIdentityId: string;
        pairing?: unknown;
        supportsTokenOnly?: boolean;
        endpointUrl: string;
    }>) => Promise<void>;
    prompt?: (payload: Readonly<{
        kind: string;
        stepId?: string;
        message: string;
        data?: unknown;
    }>) => Promise<unknown>;
}>;

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function buildNativeSafeRecipeParams(value: unknown): unknown {
    const params = readRecord(value);
    const ssh = readRecord(params.ssh);
    if (ssh.auth !== 'keyfile' || typeof ssh.identityPrivateKey !== 'string' || !ssh.identityPrivateKey.trim()) {
        return value;
    }
    return {
        ...params,
        ssh: {
            ...ssh,
            auth: 'agent',
        },
    };
}

function decodeTerminalPublicKey(value: string): Uint8Array {
    try {
        return decodeBase64(value, 'base64url');
    } catch {
        return decodeBase64(value, 'base64');
    }
}

function readNativePairingContext(value: unknown): Readonly<{
    secret: Uint8Array;
    createdAtMs: number;
    expiresAtMs: number;
}> {
    const record = readRecord(value);
    const keys = Object.keys(record).sort();
    if (keys.length !== 3 || keys.join(',') !== 'createdAtMs,expiresAtMs,secretB64Url') {
        throw new SystemTaskExecutionError(
            'native_ssh_terminal_pairing_context_required',
            'Native SSH pairing requires the authenticated v3 context from the remote auth request.',
        );
    }
    const secretB64Url = typeof record.secretB64Url === 'string' ? record.secretB64Url : '';
    const createdAtMs = record.createdAtMs;
    const expiresAtMs = record.expiresAtMs;
    let secret: Uint8Array;
    try {
        secret = decodeBase64(secretB64Url, 'base64url');
    } catch {
        secret = new Uint8Array();
    }
    if (
        secret.length !== 32
        || encodeBase64(secret, 'base64url') !== secretB64Url
        || typeof createdAtMs !== 'number'
        || !Number.isSafeInteger(createdAtMs)
        || createdAtMs < 0
        || typeof expiresAtMs !== 'number'
        || !Number.isSafeInteger(expiresAtMs)
        || expiresAtMs <= createdAtMs
        || Date.now() > expiresAtMs
    ) {
        throw new SystemTaskExecutionError(
            'native_ssh_terminal_pairing_context_invalid',
            'The remote authenticated terminal pairing context is malformed or expired.',
        );
    }
    return { secret, createdAtMs, expiresAtMs };
}

async function installRemoteCliViaNativeSelfDownload(params: Readonly<{
    channel?: string;
    runTextCommand: (command: string, options?: Readonly<{ execTimeoutMs?: number }>) => Promise<Readonly<{
        status: number;
        stdout: string;
        stderr: string;
    }>>;
    resolveInstallPlan?: RunNativeRemoteSshBootstrapTaskParams['resolveInstallPlan'];
}>): Promise<void> {
    const preflight = await params.runTextCommand([
        "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
        '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
        '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
    ].join(' '));
    if (preflight.status !== 0) {
        throw new SystemTaskExecutionError(
            'native_ssh_remote_preflight_failed',
            preflight.stderr.trim() || 'Native SSH bootstrap could not resolve the remote platform.',
        );
    }
    const target = readRecord(JSON.parse(preflight.stdout.trim() || '{}'));
    const os = normalizeRemoteReleaseOs(target.platform);
    const arch = normalizeRemoteReleaseArch(target.arch);
    const channel = params.channel === 'dev'
        ? 'publicdev'
        : params.channel === 'stable' || params.channel === 'preview' || params.channel === 'publicdev'
            ? params.channel
            : 'stable';
    const plan = params.resolveInstallPlan
        ? await params.resolveInstallPlan({ channel, os, arch })
        : await resolveRemoteSelfDownloadFirstPartyInstallPlan({
            componentId: 'happier-cli',
            channel,
            os,
            arch,
        });
    const installResult = await params.runTextCommand(plan.command, {
        execTimeoutMs: 600_000,
    });
    if (installResult.status !== 0) {
        throw new SystemTaskExecutionError(
            'native_ssh_remote_cli_install_failed',
            installResult.stderr.trim() || 'Native SSH bootstrap remote self-download install failed.',
        );
    }
}

function resolveNativeApprovalTarget(parsed: RemoteBootstrapMachineParams): Readonly<{
    endpointUrl: string;
    credentialUrl: string;
    profileId: string;
    homeServerIdentityId: string;
    descriptor: HomeConnectionDescriptorV1;
}> {
    if (parsed.homeTarget) {
        const descriptor = parsed.homeTarget.descriptor;
        const profileId = parsed.homeTarget.profileId;
        const homeServerIdentityId = parsed.homeTarget.homeServerIdentityId;
        if (!descriptor || !profileId || !homeServerIdentityId) {
            throw new SystemTaskExecutionError(
                'native_ssh_local_approval_target_unavailable',
                'Native SSH bootstrap requires an identity-bearing saved Home target for local approval.',
            );
        }
        const profile = getServerProfileById(profileId);
        if (!profile || profile.serverIdentityId?.trim() !== homeServerIdentityId) {
            throw new SystemTaskExecutionError(
                'native_ssh_local_approval_target_mismatch',
                'The selected Home profile no longer matches the resolved Home target.',
            );
        }
        return {
            endpointUrl: parsed.homeTarget.applicationUrl,
            credentialUrl: parsed.homeTarget.applicationUrl,
            profileId,
            homeServerIdentityId,
            descriptor,
        };
    }

    // Compatibility/manual URL tasks predate the identity-bearing target. They
    // may resolve one already-known local profile, but cannot supply identity.
    const endpointUrl = parsed.relay.relayUrl.trim();
    const credentialUrl = parsed.relay.publicRelayUrl?.trim() || endpointUrl;
    const credentialKey = createServerUrlComparableKey(credentialUrl);
    const matches = credentialKey
        ? listServerProfiles().filter((profile) => (
            createServerUrlComparableKey(profile.serverUrl) === credentialKey
            || createServerUrlComparableKey(profile.canonicalServerUrl ?? '') === credentialKey
            || createServerUrlComparableKey(profile.publicServerUrl ?? '') === credentialKey
        ))
        : [];
    const identities = [...new Set(matches.map((profile) => (
        profile.serverIdentityId?.trim()
    )).filter((identity): identity is string => Boolean(identity)))];
    if (!endpointUrl || identities.length !== 1) {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_target_unavailable',
            'Native SSH bootstrap could not resolve one exact Home credential target.',
        );
    }
    const matchedProfile = matches.find((profile) => profile.serverIdentityId?.trim() === identities[0]);
    const descriptor = matchedProfile
        ? buildHomeConnectionDescriptorForProfile(matchedProfile)
        : null;
    if (!matchedProfile || !descriptor) {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_target_unavailable',
            'Native SSH bootstrap could not resolve a verified Home connection descriptor.',
        );
    }
    return {
        endpointUrl,
        credentialUrl,
        profileId: matchedProfile.id,
        homeServerIdentityId: descriptor.homeServerIdentityId,
        descriptor,
    };
}

async function approveNativeLocalAuthRequest(params: Readonly<{
    publicKey: string;
    homeServerIdentityId: string;
    pairing?: unknown;
    supportsTokenOnly?: boolean;
    parsed: RemoteBootstrapMachineParams;
}>): Promise<void> {
    const target = resolveNativeApprovalTarget(params.parsed);
    if (params.homeServerIdentityId.trim() !== target.homeServerIdentityId) {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_target_mismatch',
            'The remote authentication request belongs to a different Home identity.',
        );
    }
    const credentials = await TokenStorage.getCredentialsForServerUrl(
        target.credentialUrl,
        { serverId: target.profileId },
    );
    if (!credentials) {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_unauthenticated',
            'Native SSH bootstrap cannot approve remote account pairing because this device is not signed in.',
        );
    }

    const publicKey = decodeTerminalPublicKey(params.publicKey);
    const pairing = readNativePairingContext(params.pairing);
    const transportResolution = await resolveHomeEnrollmentTransport(target.descriptor);
    if (!transportResolution.ok) {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_target_unavailable',
            `Native SSH bootstrap could not acquire its Home transport: ${transportResolution.reason}`,
        );
    }
    let result: Awaited<ReturnType<typeof approveTerminalPairing>>;
    try {
        result = await approveTerminalPairing({
            target: transportResolution.transport,
            requesterPublicKey: publicKey,
            pairingContext: pairing,
            targetCredentials: credentials,
            supportsTokenOnly: params.supportsTokenOnly === true,
        });
    } finally {
        await transportResolution.transport.close();
    }
    if (result === 'not_found') {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_not_found',
            'Native SSH bootstrap could not find the remote account pairing request.',
        );
    }
}

export function readNativeSshTaskCredentials(spec: Readonly<{
    kind: string;
    params: unknown;
}>): NativeSshTaskCredentials {
    if (spec.kind !== NATIVE_SSH_BOOTSTRAP_TASK_KIND) {
        throw new Error('native_ssh_task_not_allowed');
    }
    parseRemoteBootstrapMachineParams(spec.params);
    const params = readRecord(spec.params);
    const ssh = readRecord(params.ssh);
    const parsedTarget = parseSshTarget(String(ssh.target ?? ''));
    const host = parsedTarget.host.trim();
    const username = parsedTarget.username.trim();
    const port = typeof ssh.port === 'number' && Number.isInteger(ssh.port) && ssh.port > 0
        ? ssh.port
        : 22;
    if (!host || !username) {
        throw new Error('native_ssh_missing_credentials');
    }

    const authMode = ssh.auth;
    const password = typeof ssh.password === 'string' ? ssh.password : undefined;
    const privateKeyPem = typeof ssh.identityPrivateKey === 'string' ? ssh.identityPrivateKey : undefined;
    if (authMode === 'password' && !password) {
        throw new Error('native_ssh_missing_credentials');
    }
    if (authMode === 'keyfile' && !privateKeyPem) {
        throw new Error('native_ssh_missing_credentials');
    }
    if (authMode !== 'password' && authMode !== 'keyfile') {
        throw new Error('native_ssh_missing_credentials');
    }
    return {
        host,
        port,
        username,
        auth: {
            username,
            ...(authMode === 'password' && password ? { password } : {}),
            ...(authMode === 'keyfile' && privateKeyPem ? { privateKeyPem } : {}),
        },
    };
}

export async function runNativeRemoteSshBootstrapTask(
    params: RunNativeRemoteSshBootstrapTaskParams,
): Promise<unknown> {
    const credentials = readNativeSshTaskCredentials(params.spec);
    params.events?.event(buildNativeSystemTaskEvent({
        taskId: params.taskId,
        tsMs: Date.now(),
        input: {
            type: 'started',
            stepId: 'native.ssh.bootstrap.prepare',
            message: 'Preparing native SSH bootstrap.',
        },
    }));
    if (params.signal?.aborted) {
        throw new Error('native_ssh_task_cancelled');
    }
    if (!params.nativeModule) {
        throw new Error('native_ssh_engine_unavailable');
    }
    const parsed = parseRemoteBootstrapMachineParams(params.spec.params);
    const commandRunner = params.commandRunner ?? createNativeRemoteSshCommandRunner();
    const runTextCommand = async (
        command: string,
        options: Readonly<{ execTimeoutMs?: number }> = {},
    ) => await commandRunner.runTextCommand({
        nativeModule: params.nativeModule!,
        credentials,
        command,
        signal: params.signal,
        requestIdPrefix: params.taskId,
        ...(options.execTimeoutMs ? { execTimeoutMs: options.execTimeoutMs } : {}),
    });
    const taskKind = createRemoteSshBootstrapMachineTaskKind({
        resolveHostTrust: async () => ({ status: 'trusted' }),
        installRemoteCli: async () => {
            await installRemoteCliViaNativeSelfDownload({
                channel: parsed.channel,
                runTextCommand,
                resolveInstallPlan: params.resolveInstallPlan,
            });
        },
        createRemoteEnrollmentExecutor: ({ parsed: enrollmentTarget, auth, knownHostsMode, signal }) => (
            createOpenSshHappierJsonExecutor({
                ssh: enrollmentTarget.ssh,
                auth,
                knownHostsMode,
                channel: enrollmentTarget.channel === 'dev' ? 'publicdev' : enrollmentTarget.channel,
                runRemoteText: async ({ remoteCommand, timeoutMs, onStdoutChunk, input, signal: commandSignal }) => (
                    await commandRunner.runTextCommand({
                        nativeModule: params.nativeModule!,
                        credentials,
                        command: remoteCommand,
                        signal: commandSignal ?? signal ?? params.signal,
                        requestIdPrefix: params.taskId,
                        ...(timeoutMs ? { execTimeoutMs: timeoutMs } : {}),
                        ...(input !== undefined ? { input } : {}),
                        ...(onStdoutChunk ? { onStdoutChunk } : {}),
                    })
                ),
            })
        ),
        approveLocalAuthRequest: async ({ publicKey, homeServerIdentityId, pairing, supportsTokenOnly, parsed: approvalTarget }) => {
            if (params.approveLocalAuthRequest) {
                await params.approveLocalAuthRequest({
                    publicKey,
                    homeServerIdentityId,
                    ...(pairing !== undefined ? { pairing } : {}),
                    ...(supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
                    endpointUrl: approvalTarget.relay.relayUrl,
                });
                return;
            }
            await approveNativeLocalAuthRequest({
                publicKey,
                homeServerIdentityId,
                ...(pairing !== undefined ? { pairing } : {}),
                ...(supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
                // The native entry point owns the original strict target. Keep
                // that identity-bearing projection intact even when the shared
                // recipe derives a relay-adjusted approval view.
                parsed,
            });
        },
        runRemoteCommand: async ({ label, data }) => {
            const localServerUrl = typeof data?.localServerUrl === 'string' ? data.localServerUrl.trim() : '';
            const output = await commandRunner.runJsonCommand({
                nativeModule: params.nativeModule!,
                credentials,
                command: buildRemoteBootstrapCommand({
                    label,
                    channel: parsed.channel,
                    serverUrl: parsed.relay.relayUrl,
                    localServerUrl: localServerUrl || undefined,
                    webappUrl: isLoopbackUrl(parsed.relay.webappUrl) ? undefined : parsed.relay.webappUrl,
                    daemonServiceMode: parsed.serviceMode,
                    data: label === 'relay.runtime.install'
                        ? {
                            relayRuntimeMode: parsed.relayRuntime?.mode ?? 'user',
                            relayRuntimeEnv: parsed.relayRuntime?.env,
                        }
                        : undefined,
                }),
                signal: params.signal,
                requestIdPrefix: params.taskId,
                ...(label === 'relay.runtime.install' ? { execTimeoutMs: 600_000 } : {}),
            });
            return normalizeNativeRemoteCommandResult(output, label);
        },
    });

    return await taskKind.run({
        params: SystemTaskJsonValueSchema.parse(buildNativeSafeRecipeParams(params.spec.params)),
        signal: params.signal ?? new AbortController().signal,
        emit: (event) => {
            params.events?.event(buildNativeSystemTaskEvent({
                taskId: params.taskId,
                tsMs: Date.now(),
                input: event,
            }));
        },
        prompt: async (prompt) => {
            params.events?.event(buildNativeSystemTaskEvent({
                taskId: params.taskId,
                tsMs: Date.now(),
                input: {
                    type: 'prompt',
                    stepId: prompt.stepId,
                    message: prompt.message,
                    data: {
                        kind: prompt.kind,
                        ...(typeof prompt.data === 'object' && prompt.data !== null && !Array.isArray(prompt.data)
                            ? prompt.data
                            : {}),
                    },
                },
            }));
            if (!params.prompt) {
                throw new SystemTaskExecutionError('native_ssh_prompt_unhandled', 'Native SSH bootstrap prompt was not handled.');
            }
            return await params.prompt(prompt);
        },
    });
}

function normalizeNativeRemoteCommandResult(output: unknown, label: string): Readonly<{
    ok: boolean;
    data: Record<string, unknown>;
}> {
    const record = readRecord(output);
    if (typeof record.ok === 'boolean') {
        if (label === 'auth.status' && record.ok === false) {
            return {
                ok: true,
                data: { authenticated: false },
            };
        }
        return {
            ok: record.ok,
            data: readRecord(record.data),
        };
    }
    return {
        ok: true,
        data: record,
    };
}

function isLoopbackUrl(value: unknown): boolean {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
        return false;
    }
    try {
        return isLoopbackHostname(new URL(text).hostname);
    } catch {
        return false;
    }
}
