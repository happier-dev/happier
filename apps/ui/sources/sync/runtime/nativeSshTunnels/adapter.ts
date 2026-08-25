import { parseSshTarget } from '@happier-dev/protocol';
import {
    getOptionalHappierSshNativeModule,
    startNativeSshLoopbackTunnel,
    stopNativeSshLoopbackTunnel,
    type NativeSshAuthPromptEvent,
    type NativeSshAuthPromptResponse,
    type NativeSshAuthRequest,
    type NativeSshHostKeyPromptEvent,
    type NativeSshHostKeyVerification,
    type NativeSshModule,
    type NativeSshSubscription,
} from '@happier-dev/ssh-native';

import type {
    NativeSshCredentialsRef,
    NativeSshTunnelAdapter,
    NativeSshTunnelRequest,
} from './types';
import { buildNativeSshTunnelKey } from './store';

export type NativeSshTunnelCredentialResolution = Readonly<{
    auth: NativeSshAuthRequest;
    hostKeyVerification?: NativeSshHostKeyVerification;
}>;

export type NativeSshTunnelCredentialResolver = (
    credentialsRef: NativeSshCredentialsRef,
    request: NativeSshTunnelRequest,
) => Promise<NativeSshTunnelCredentialResolution>;

export type NativeSshTunnelHostKeyPromptResolver = (
    event: NativeSshHostKeyPromptEvent,
    request: NativeSshTunnelRequest,
) => Promise<NativeSshHostKeyVerification>;

export type NativeSshTunnelAuthPromptResolver = (
    event: NativeSshAuthPromptEvent,
    request: NativeSshTunnelRequest,
) => Promise<NativeSshAuthPromptResponse>;

function isNativeSshAuthPromptEvent(value: unknown): value is NativeSshAuthPromptEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const event = value as Partial<NativeSshAuthPromptEvent>;
    if (typeof event.requestId !== 'string' || typeof event.promptId !== 'string') {
        return false;
    }
    return event.kind === 'private-key-passphrase' || event.kind === 'keyboard-interactive';
}

/**
 * `undefined` means "resolve the optional Expo module", `null` means "explicitly none" — the same
 * rule `startNativeSshLoopbackTunnel` already applies. Applying it here too is what makes the
 * host-key and auth prompt bridges register against the module the tunnel actually starts on;
 * without it the sole production caller (`runtime.ts`) skipped both subscriptions and every host
 * needing trust or credentials timed out (§7.1).
 */
function resolveNativeModule(nativeModule?: NativeSshModule | null): NativeSshModule | null {
    return nativeModule === undefined ? getOptionalHappierSshNativeModule() : nativeModule;
}

export function createNativeSshTunnelAdapter(params: Readonly<{
    nativeModule?: NativeSshModule | null;
    resolveCredentials: NativeSshTunnelCredentialResolver;
    promptHostKey?: NativeSshTunnelHostKeyPromptResolver;
    promptAuth?: NativeSshTunnelAuthPromptResolver;
    connectTimeoutMs?: number;
    authTimeoutMs?: number;
}>): NativeSshTunnelAdapter {
    return {
        async startLoopbackTunnel(request) {
            const parsedTarget = parseSshTarget(request.sshTarget);
            const host = parsedTarget.host.trim();
            const username = parsedTarget.username.trim();
            if (!host || !username) {
                throw new Error('native_ssh_tunnel_invalid_target');
            }
            const credentials = await params.resolveCredentials(request.credentialsRef, request);
            const requestId = `native-ssh-tunnel:${buildNativeSshTunnelKey(request)}`;
            const nativeModule = resolveNativeModule(params.nativeModule);
            const hostKeySubscription: NativeSshSubscription | null = nativeModule?.addListener
                && nativeModule.respondToHostKeyPrompt
                && params.promptHostKey
                ? nativeModule.addListener('hostKeyPrompt', (event) => {
                    if (!('status' in event) || event.requestId !== requestId) {
                        return;
                    }
                    const promptHostKey = params.promptHostKey;
                    const respondToHostKeyPrompt = nativeModule.respondToHostKeyPrompt;
                    if (!promptHostKey || !respondToHostKeyPrompt) {
                        return;
                    }
                    void promptHostKey(event, request)
                        .then((response) => respondToHostKeyPrompt(event.promptId, response))
                        .catch(() => respondToHostKeyPrompt(event.promptId, {
                            decision: 'reject',
                            reason: 'SSH host trust was declined.',
                        }));
                })
                : null;
            const authPromptSubscription: NativeSshSubscription | null = nativeModule?.addListener
                && nativeModule.respondToAuthPrompt
                && params.promptAuth
                ? nativeModule.addListener('authPrompt', (event) => {
                    if (!isNativeSshAuthPromptEvent(event) || event.requestId !== requestId) {
                        return;
                    }
                    const promptAuth = params.promptAuth;
                    const respondToAuthPrompt = nativeModule.respondToAuthPrompt;
                    if (!promptAuth || !respondToAuthPrompt) {
                        return;
                    }
                    void promptAuth(event, request)
                        .then((response) => respondToAuthPrompt(event.promptId, response))
                        .catch(() => respondToAuthPrompt(event.promptId, {
                            decision: 'cancel',
                            reason: 'Native SSH authentication prompt was cancelled.',
                        }));
                })
                : null;
            try {
                return await startNativeSshLoopbackTunnel({
                    nativeModule,
                    request: {
                        requestId,
                        host,
                        port: request.sshPort ?? 22,
                        username,
                        auth: credentials.auth,
                        hostKeyVerification: credentials.hostKeyVerification ?? {
                            decision: 'prompt',
                        },
                        destinationHost: request.destinationHost,
                        destinationPort: request.destinationPort,
                        ...(request.requestedLocalPort ? { requestedLocalPort: request.requestedLocalPort } : {}),
                        connectTimeoutMs: params.connectTimeoutMs ?? 15_000,
                        authTimeoutMs: params.authTimeoutMs ?? 15_000,
                    },
                });
            } finally {
                hostKeySubscription?.remove();
                authPromptSubscription?.remove();
            }
        },
        async stopLoopbackTunnel(nativeTunnelId) {
            await stopNativeSshLoopbackTunnel({
                nativeModule: resolveNativeModule(params.nativeModule),
                nativeTunnelId,
            });
        },
    };
}
