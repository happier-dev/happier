import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { createHash, randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { delay } from "@/utils/time";
import { writeCredentialsLegacy, readCredentials, updateSettings, Credentials, writeCredentialsDataKey } from "@/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { sanitizeServerIdForFilesystem } from "@/server/serverId";
import { openBrowser } from '@/ui/openBrowser';
import { AuthSelector, AuthMethod } from "./ink/AuthSelector";
import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import { ensureDaemonRunningForSessionCommand, shouldAutoStartDaemonAfterAuth } from '@/daemon/ensureDaemon';
import { buildConfigureServerLinks, buildTerminalConnectLinks } from '@happier-dev/cli-common/links';

export type PostTerminalAuthRequestCompatibleResponse =
    | { state: 'requested' }
    | { state: 'authorized' }
    | { state: 'authorized'; token: string; response: string };

function isAuthorizedWithTokenAndResponse(
    value: PostTerminalAuthRequestCompatibleResponse,
): value is Extract<PostTerminalAuthRequestCompatibleResponse, { state: 'authorized'; token: string; response: string }> {
    if (value.state !== 'authorized') return false;
    return (
        'token' in value &&
        typeof (value as any).token === 'string' &&
        'response' in value &&
        typeof (value as any).response === 'string'
    );
}

export async function doAuth(): Promise<Credentials | null> {
    // Ink requires raw mode support; in daemon/non-tty contexts we must never render Ink
    // (it will crash with "Raw mode is not supported on the current process.stdin").
    const hasRawMode = Boolean(process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function');
    const isInteractive = Boolean(hasRawMode && process.stdout.isTTY);
    if (isInteractive) {
        console.clear();
    }
    const debugRaw = (process.env.DEBUG ?? '').toString();
    const debugEnabled = Boolean(debugRaw) && debugRaw !== '0' && debugRaw.toLowerCase() !== 'false';

    const envMethodRaw = (process.env.HAPPIER_AUTH_METHOD ?? '').toString().trim().toLowerCase();
    const envMethod = envMethodRaw === 'web' || envMethodRaw === 'browser' ? 'web' : envMethodRaw === 'mobile' ? 'mobile' : null;
    const authMethod: AuthMethod | 'both' | null = envMethod ?? (isInteractive ? await selectAuthenticationMethod() : 'both');
    if (!authMethod) {
        console.log('\nAuthentication cancelled.\n');
        process.exit(0);
    }

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
    const claimSecret = new Uint8Array(randomBytes(32));
    const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
    const claimSecretHash = createHash('sha256').update(Buffer.from(claimSecret)).digest('base64url');

    // Create a new authentication request
    try {
        const publicKey = encodeBase64(keypair.publicKey);
        if (debugEnabled) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${configuration.serverUrl}/v1/auth/request`);
            console.log(`[AUTH DEBUG] Public key: ${publicKey.substring(0, 20)}...`);
        }
        await postTerminalAuthRequestCompatible({
            publicKey,
            supportsV2: true,
            claimSecretHash,
        });
        if (debugEnabled) {
            console.log(`[AUTH DEBUG] Auth request sent successfully`);
        }
    } catch (error) {
        if (debugEnabled) {
            console.log(`[AUTH DEBUG] Failed to send auth request:`, error);
        }
        console.log('Failed to create authentication request, please try again later.');
        return null;
    }

    // Handle authentication based on selected method
    if (authMethod === 'mobile') {
        return await doMobileAuth({ keypair, claimSecret: claimSecretB64Url });
    }
    if (authMethod === 'web') {
        return await doWebAuth({ keypair, claimSecret: claimSecretB64Url });
    }
    return await doBothAuth({ keypair, claimSecret: claimSecretB64Url });
}

async function doBothAuth(params: Readonly<{ keypair: tweetnacl.BoxKeyPair; claimSecret: string }>): Promise<Credentials | null> {
    if (process.stdout.isTTY) {
        console.clear();
    }

    const publicKeyB64Url = encodeBase64Url(params.keypair.publicKey);
    const configureLinks = buildConfigureServerLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.publicServerUrl,
    });
    const terminalLinks = buildTerminalConnectLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.publicServerUrl,
        publicKeyB64Url,
    });

    console.log('\nAuthenticate this machine\n');
    console.log(`This terminal is connected to: ${configuration.serverUrl}`);
    console.log(`Web app URL: ${configuration.webappUrl}`);
    console.log('');
    console.log('Recommended: use the mobile app first. It makes linking additional devices easier.');
    console.log('');
    console.log('Before you continue:');
    console.log('- Make sure your phone/browser can reach your server over HTTPS');
    console.log('- In the Happier mobile app, set the Server URL to the same public URL you use to reach the web UI (often the Web app URL above)');
    console.log('- Sign in (or create an account)');
    console.log('- If you already have a Happier account on another device, sign in with that same account');
    console.log('');

    console.log('Step 0 — Configure your app/web (self-host only)');
    console.log('If you are using Happier Cloud, you can skip this.');
    console.log('');
    console.log('Web (prefill + confirm):');
    console.log(configureLinks.webUrl);
    console.log('');
    console.log('Mobile deep link (scan QR or open manually):\n');
    displayQRCode(configureLinks.mobileUrl);
    console.log('\n' + configureLinks.mobileUrl);
    console.log('');

    console.log('Option A — Web');
    console.log('Open this URL in a browser where you are signed in to Happier:');
    console.log(terminalLinks.webUrl);
    console.log('');

    console.log('Option B — Mobile');
    console.log('Scan this QR code with your Happier mobile app:\n');
    displayQRCode(terminalLinks.mobileUrl);
    console.log('\nOr manually open this URL:');
    console.log(terminalLinks.mobileUrl);
    console.log('');

    return await waitForAuthentication({ keypair: params.keypair, claimSecret: params.claimSecret });
}

async function postTerminalAuthRequestCompatible(params: Readonly<{
    publicKey: string;
    supportsV2?: boolean;
    claimSecretHash?: string;
}>): Promise<PostTerminalAuthRequestCompatibleResponse> {
    try {
        const res = await axios.post<PostTerminalAuthRequestCompatibleResponse>(`${configuration.serverUrl}/v1/auth/request`, {
            publicKey: params.publicKey,
            ...(typeof params.supportsV2 === 'boolean' ? { supportsV2: params.supportsV2 } : {}),
            ...(typeof params.claimSecretHash === 'string' ? { claimSecretHash: params.claimSecretHash } : {}),
        });
        return res.data;
    } catch (error: any) {
        const code = error?.response?.status;
        if (code === 400 || code === 422) {
            // Some legacy servers validate request bodies strictly and reject unknown keys.
            // Retry with the minimal legacy payload.
            const res = await axios.post<PostTerminalAuthRequestCompatibleResponse>(`${configuration.serverUrl}/v1/auth/request`, {
                publicKey: params.publicKey,
            });
            return res.data;
        }
        throw error;
    }
}

/**
 * Display authentication method selector and return user choice
 */
function selectAuthenticationMethod(): Promise<AuthMethod | null> {
    return new Promise((resolve) => {
        let hasResolved = false;

        const onSelect = (method: AuthMethod) => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(method);
            }
        };

        const onCancel = () => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(null);
            }
        };

        const app = render(React.createElement(AuthSelector, { onSelect, onCancel }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    });
}

/**
 * Handle mobile authentication flow
 */
async function doMobileAuth(params: Readonly<{ keypair: tweetnacl.BoxKeyPair; claimSecret: string }>): Promise<Credentials | null> {
    if (process.stdout.isTTY) {
        console.clear();
    }
    console.log('\nMobile Authentication\n');
    console.log(`This terminal is connected to: ${configuration.serverUrl}`);
    console.log(`Web app URL: ${configuration.webappUrl}\n`);
    console.log('Recommended: use the mobile app first. It makes linking additional devices easier.');
    console.log('If you already have a Happier account on another device, sign in with that same account.\n');

    const configureLinks = buildConfigureServerLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.publicServerUrl,
    });
    console.log('Step 0 — Configure your app/web (self-host only)');
    console.log('Web (prefill + confirm):');
    console.log(configureLinks.webUrl);
    console.log('');
    console.log('Mobile deep link (scan QR or open manually):\n');
    displayQRCode(configureLinks.mobileUrl);
    console.log('\n' + configureLinks.mobileUrl);
    console.log('');

    console.log('Scan this QR code with your Happier mobile app:\n');

    const publicKeyB64Url = encodeBase64Url(params.keypair.publicKey);
    const authUrl = buildTerminalConnectLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.publicServerUrl,
        publicKeyB64Url,
    }).mobileUrl;
    displayQRCode(authUrl);

    console.log('\nOr manually enter this URL:');
    console.log(authUrl);
    console.log('');

    return await waitForAuthentication({ keypair: params.keypair, claimSecret: params.claimSecret });
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(params: Readonly<{ keypair: tweetnacl.BoxKeyPair; claimSecret: string }>): Promise<Credentials | null> {
    if (process.stdout.isTTY) {
        console.clear();
    }
    console.log('\nWeb Authentication\n');
    console.log(`This terminal is connected to: ${configuration.serverUrl}`);
    console.log(`Web app URL: ${configuration.webappUrl}\n`);
    console.log('If you already have a Happier account on another device, sign in with that same account.\n');

    const configureLinks = buildConfigureServerLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.publicServerUrl,
    });
    console.log('Step 0 — Configure your app/web (self-host only)');
    console.log('Web (prefill + confirm):');
    console.log(configureLinks.webUrl);
    console.log('');
    console.log('Mobile deep link (scan QR or open manually):\n');
    displayQRCode(configureLinks.mobileUrl);
    console.log('\n' + configureLinks.mobileUrl);
    console.log('');

    const webUrl = generateWebAuthUrl(params.keypair.publicKey);
    const noOpenRaw = (process.env.HAPPIER_NO_BROWSER_OPEN ?? '').toString().trim();
    const noOpen = Boolean(noOpenRaw) && noOpenRaw !== '0' && noOpenRaw.toLowerCase() !== 'false';
    if (!noOpen) {
        console.log('Opening your browser...');

        const browserOpened = await openBrowser(webUrl);

        if (browserOpened) {
            console.log('✓ Browser opened\n');
            console.log('Complete authentication in your browser window.');
        } else {
            console.log('Could not open browser automatically.');
        }
    } else {
        console.log('Browser opening is disabled (HAPPIER_NO_BROWSER_OPEN is set).');
        console.log('Open the URL below in the browser profile/account you want to authenticate.');
    }

    // I changed this to always show the URL because we got a report from
    // someone running happy inside the dev-box container image that they saw the
    // "Complete authentication in your browser window." but nothing opened.
    // https://github.com/slopus/happy/issues/19
    console.log('\nIf the browser did not open, please copy and paste this URL:');
    console.log(webUrl);
    console.log('');

    return await waitForAuthentication({ keypair: params.keypair, claimSecret: params.claimSecret });
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(params: Readonly<{ keypair: tweetnacl.BoxKeyPair; claimSecret: string }>): Promise<Credentials | null> {
    process.stdout.write('Waiting for authentication');
    let dots = 0;
    let cancelled = false;

    // Handle Ctrl-C during waiting
    const handleInterrupt = () => {
        cancelled = true;
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };

    process.on('SIGINT', handleInterrupt);

    try {
        const pollIntervalMsRaw = Number(process.env.HAPPIER_AUTH_POLL_INTERVAL_MS ?? '');
        const pollIntervalMs = Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0 ? pollIntervalMsRaw : 1000;
        const publicKey = encodeBase64(params.keypair.publicKey);

        let mode: 'status-claim' | 'legacy-post' = 'status-claim';

        while (!cancelled) {
            try {
                const tryFinalizeWithTokenAndEncryptedResponse = async (token: string, responseB64: string): Promise<Credentials | null> => {
                    const r = decodeBase64(responseB64);
                    const decrypted = decryptWithEphemeralKey(r, params.keypair.secretKey);
                    if (!decrypted) {
                        console.log('\n\nFailed to decrypt response. Please try again.');
                        return null;
                    }

                    if (decrypted.length === 32) {
                        await writeCredentialsLegacy({ secret: decrypted, token });
                        console.log('\n\n✓ Authentication successful\n');
                        return { encryption: { type: 'legacy', secret: decrypted }, token };
                    }

                    if (decrypted[0] === 0) {
                        const machineKey = decrypted.slice(1, 33);
                        const publicKeyBytes = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
                        await writeCredentialsDataKey({ publicKey: publicKeyBytes, machineKey, token });
                        console.log('\n\n✓ Authentication successful\n');
                        return { encryption: { type: 'dataKey', publicKey: publicKeyBytes, machineKey }, token };
                    }

                    console.log('\n\nFailed to decrypt response. Please try again.');
                    return null;
                };

                const legacyPollOnce = async (): Promise<
                    PostTerminalAuthRequestCompatibleResponse
                > => {
                    const data = await postTerminalAuthRequestCompatible({ publicKey, supportsV2: true });
                    return data;
                };

                if (mode === 'legacy-post') {
                    const legacy = await legacyPollOnce();
                    if (isAuthorizedWithTokenAndResponse(legacy)) {
                        const finalized = await tryFinalizeWithTokenAndEncryptedResponse(legacy.token, legacy.response);
                        if (finalized) return finalized;
                        return null;
                    }
                } else {
                    let statusRes: any;
                    try {
                        statusRes = await axios.get(`${configuration.serverUrl}/v1/auth/request/status`, {
                            params: { publicKey },
                        });
                    } catch (e: any) {
                        const code = e?.response?.status;
                        if (code === 404) {
                            mode = 'legacy-post';
                            const legacy = await legacyPollOnce();
                            if (isAuthorizedWithTokenAndResponse(legacy)) {
                                const finalized = await tryFinalizeWithTokenAndEncryptedResponse(legacy.token, legacy.response);
                                if (finalized) return finalized;
                                return null;
                            }
                            await delay(pollIntervalMs);
                            continue;
                        }
                        throw e;
                    }

                    const status = statusRes.data?.status;
                    if (status === 'not_found') {
                        console.log('\n\nAuthentication request expired. Please run `happier auth login` again.');
                        return null;
                    }

                    if (status === 'authorized') {
                        try {
                            const claimRes = await axios.post(`${configuration.serverUrl}/v1/auth/request/claim`, {
                                publicKey,
                                claimSecret: params.claimSecret,
                            });

                            const claimData = claimRes?.data;
                            if (claimData?.state !== 'authorized') {
                                await delay(pollIntervalMs);
                                continue;
                            }

                            if (typeof claimData.token !== 'string' || typeof claimData.response !== 'string') {
                                console.log('\n\nUnexpected response from server. Please try again.');
                                return null;
                            }

                            const token = claimData.token;
                            const responseB64 = claimData.response;
                            const finalized = await tryFinalizeWithTokenAndEncryptedResponse(token, responseB64);
                            if (finalized) return finalized;
                            return null;
                        } catch (e: any) {
                            const code = e?.response?.status;
                            const err = e?.response?.data?.error;
                            if (code === 410 && (err === 'expired' || err === 'consumed')) {
                                const message =
                                    err === 'consumed'
                                        ? 'Authentication request was already claimed. Please run `happier auth login` again.'
                                        : 'Authentication request expired. Please run `happier auth login` again.';
                                console.log(`\n\n${message}`);
                                return null;
                            }
                            if (code === 404 || (code === 400 && err === 'claim_not_supported') || (code === 409 && err === 'claim_not_supported')) {
                                mode = 'legacy-post';
                                const legacy = await legacyPollOnce();
                                if (isAuthorizedWithTokenAndResponse(legacy)) {
                                    const finalized = await tryFinalizeWithTokenAndEncryptedResponse(legacy.token, legacy.response);
                                    if (finalized) return finalized;
                                    return null;
                                }
                                await delay(pollIntervalMs);
                                continue;
                            }
                            throw e;
                        }
                    }
                }
            } catch (error) {
                console.log('\n\nFailed to check authentication status. Please try again.');
                return null;
            }

            // Animate waiting dots
            process.stdout.write('\rWaiting for authentication' + '.'.repeat((dots % 3) + 1) + '   ');
            dots++;

            await delay(pollIntervalMs);
        }
    } finally {
        process.off('SIGINT', handleInterrupt);
    }

    return null;
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    // Extract components from bundle: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);

    const decrypted = tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted) {
        return null;
    }

    return decrypted;
}

export async function ensureMachineIdInSettings(opts?: { forceNew?: boolean }): Promise<{ machineId: string }> {
    const forceNew = opts?.forceNew ?? false;
    const settings = await updateSettings(async s => {
        const activeServerId = sanitizeServerIdForFilesystem(
            configuration.activeServerId ?? s.activeServerId ?? 'cloud',
            'cloud',
        );
        const currentMap = { ...(s.machineIdByServerId ?? {}) };
        const current = currentMap[activeServerId];

        if (forceNew || !current) {
            const machineId = randomUUID();
            currentMap[activeServerId] = machineId;
            return {
                ...s,
                machineIdByServerId: currentMap,
                // derived (not persisted in v5+)
                machineId,
            };
        }
        return s;
    });

    if (!settings.machineId) {
        throw new Error('Failed to ensure machine id in settings');
    }
    return { machineId: settings.machineId };
}


/**
 * Ensure authentication and machine setup
 * This replaces the onboarding flow and ensures everything is ready
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials = await readCredentials();
    let newAuth = false;

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }

    // Make sure we have a machine ID.
    // Server machine entity will be created either by the daemon or by the CLI.
    const { machineId } = await ensureMachineIdInSettings({ forceNew: newAuth });

    logger.debug(`[AUTH] Machine ID: ${machineId}`);

    if (shouldAutoStartDaemonAfterAuth({ env: process.env, isDaemonProcess: configuration.isDaemonProcess })) {
        try {
            await ensureDaemonRunningForSessionCommand();
        } catch (e) {
            // Non-fatal: the session can still run without daemon, but remote spawn/control will be degraded.
            logger.debug('[AUTH] Failed to auto-start daemon (non-fatal)', e);
        }
    }

    return { credentials, machineId };
}
