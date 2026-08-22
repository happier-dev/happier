import { deriveAccountMachineKeyFromRecoverySecret, parseSshTarget, SystemTaskJsonValueSchema } from '@happier-dev/protocol';
import {
    buildRemoteBootstrapCommand,
    createRemoteSshBootstrapMachineTaskKind,
    normalizeRemoteReleaseArch,
    normalizeRemoteReleaseOs,
    parseRemoteBootstrapMachineParams,
    resolveRemoteSelfDownloadFirstPartyInstallPlan,
    SystemTaskExecutionError,
    type RemoteSelfDownloadFirstPartyInstallPlan,
} from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';

import type { NativeSshModule } from '@happier-dev/ssh-native';

import { authApprove } from '@/auth/flows/approve';
import {
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    TokenStorage,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { buildTerminalResponseV1, buildTerminalResponseV2 } from '@/auth/terminal/terminalProvisioning';
import { decodeBase64 } from '@/encryption/base64';
import { storage } from '@/sync/domains/state/storageStore';
import { isLoopbackHostname } from '@/sync/domains/server/url/serverUrlClassification';
import {
    NATIVE_SSH_BOOTSTRAP_TASK_KIND,
    type NativeSshTaskCredentials,
} from '../bridges/native';
import { buildNativeSystemTaskEvent } from '../bridges/events';
import { createNativeRemoteSshCommandRunner, type NativeRemoteSshCommandRunner } from './nativeCommandRunner';

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
    approveLocalAuthRequest?: (publicKey: string) => Promise<void>;
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

function resolveTerminalProvisioningContentPrivateKey(credentials: AuthCredentials): Uint8Array {
    if (isDataKeyAuthCredentials(credentials)) {
        const machineKey = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (machineKey.length !== 32) {
            throw new Error('native_ssh_invalid_terminal_key_material');
        }
        return machineKey;
    }

    if (!isLegacyAuthCredentials(credentials)) {
        throw new SystemTaskExecutionError(
            'native_ssh_token_only_terminal_approval_upgrade_required',
            'Token-only native SSH pairing requires a newer authenticated remote-pairing protocol.',
        );
    }

    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error('native_ssh_invalid_terminal_key_material');
    }
    return deriveAccountMachineKeyFromRecoverySecret(secretKey);
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

async function approveNativeLocalAuthRequest(publicKeyText: string): Promise<void> {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_unauthenticated',
            'Native SSH bootstrap cannot approve remote account pairing because this device is not signed in.',
        );
    }

    const publicKey = decodeTerminalPublicKey(publicKeyText);
    const contentPrivateKey = resolveTerminalProvisioningContentPrivateKey(credentials);
    const responseV2 = buildTerminalResponseV2({
        contentPrivateKey,
        terminalEphemeralPublicKey: publicKey,
    });
    const allowLegacySecretExportEnabled = Boolean(
        storage.getState().settings?.terminalConnectLegacySecretExportEnabled,
    );
    const responseV1 =
        allowLegacySecretExportEnabled && isLegacyAuthCredentials(credentials)
            ? () => buildTerminalResponseV1({
                legacySecretB64Url: credentials.secret,
                terminalEphemeralPublicKey: publicKey,
            })
            : new Uint8Array();

    const result = await authApprove(credentials.token, publicKey, responseV1, responseV2);
    if (result === 'not_found') {
        throw new SystemTaskExecutionError(
            'native_ssh_local_approval_not_found',
            'Native SSH bootstrap could not find the remote account pairing request.',
        );
    }
}

export function readNativeSshBootstrapDedupeKey(spec: Readonly<{
    kind: string;
    params: unknown;
}>): string {
    const params = readRecord(spec.params);
    const remoteHostId = typeof params.remoteHostId === 'string' && params.remoteHostId.trim()
        ? params.remoteHostId.trim()
        : JSON.stringify(params.ssh ?? {});
    return `${remoteHostId}:${spec.kind}`;
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
        approveLocalAuthRequest: async ({ publicKey }) => {
            await (params.approveLocalAuthRequest ?? approveNativeLocalAuthRequest)(publicKey);
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
                    data: label === 'auth.wait'
                        ? { publicKey: data?.publicKey }
                        : label === 'relay.runtime.install'
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
