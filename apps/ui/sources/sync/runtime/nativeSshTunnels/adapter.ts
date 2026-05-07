import { parseSshTarget } from '@happier-dev/protocol';
import {
    startNativeSshLoopbackTunnel,
    stopNativeSshLoopbackTunnel,
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

export function createNativeSshTunnelAdapter(params: Readonly<{
    nativeModule?: NativeSshModule | null;
    resolveCredentials: NativeSshTunnelCredentialResolver;
    promptHostKey?: NativeSshTunnelHostKeyPromptResolver;
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
            const nativeModule = params.nativeModule;
            const hostKeySubscription: NativeSshSubscription | null = nativeModule?.addListener
                && nativeModule.respondToHostKeyPrompt
                && params.promptHostKey
                ? nativeModule.addListener('hostKeyPrompt', (event) => {
                    if (!('status' in event) || event.requestId !== requestId || event.status !== 'unknown') {
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
            }
        },
        async stopLoopbackTunnel(nativeTunnelId) {
            await stopNativeSshLoopbackTunnel({
                nativeModule: params.nativeModule,
                nativeTunnelId,
            });
        },
    };
}
