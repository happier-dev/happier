import { selectMachineIdentityInSettings } from '@/auth/machineIdentitySettings';
import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration, reloadConfiguration } from "@/configuration";
import { createHash, randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { delay } from "@/utils/time";
import { writeCredentialsLegacy, readCredentials, readSettings, updateSettings, Credentials, writeCredentialsDataKey, writeCredentialsTokenOnly } from "@/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { sanitizeServerIdForFilesystem } from "@/server/serverId";
import { openBrowser } from '@/ui/openBrowser';
import type { AuthMethod } from "./ink/authSelectorInput";
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import { ensureDaemonRunningForSessionCommand, shouldAutoStartDaemonAfterAuth } from '@/daemon/ensureDaemon';
import { buildConfigureServerLinks, buildTerminalConnectLinks } from '@happier-dev/cli-common/links';
import { bullets, cmd, createStepPrinter, definitionList, errorFrame, info, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';
import chalk from 'chalk';
import { tailscaleServeHttpsUrlForInternalServerUrl } from '@/integrations/tailscale/tailscaleServe';
import { isLoopbackHttpServerUrl, isLoopbackServerHost } from '@/server/serverUrlClassification';
import { buildServerUrlReachabilityHintLines } from '@/server/reachability/serverUrlReachabilityHint';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import {
    createTerminalPairingAuthentication,
    applyTerminalAuthRequestExpiry,
    formatTerminalPairingExpiryNotice,
    openTerminalProvisioningResponse,
    readTerminalPairingRequirement,
    type TerminalPairingAuthentication,
    type TerminalPairingRequirement,
} from '@/auth/terminalProvisioningResponse';

import { postTerminalAuthRequestCompatible, type PostTerminalAuthRequestCompatibleResponse } from '@/auth/terminalAuthRequest';

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

function shouldAutoInferPublicServerUrl(): boolean {
    const raw = String(process.env.HAPPIER_TAILSCALE_AUTO_PUBLIC_URL ?? '').trim().toLowerCase();
    if (!raw) return true;
    return ['1', 'true', 'yes', 'on'].includes(raw);
}

function resolveTailscaleServeStatusTimeoutMs(): number {
    const raw = Number.parseInt(String(process.env.HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS ?? ''), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 750;
}

/**
 * How long this terminal will wait for the sign-in to be approved.
 *
 * Unbounded by default, because a person watching a QR code on their desk is
 * not a hung process. Callers that hand this flow a terminal they have to give
 * back — `happier setup`, which runs `auth login` with inherited stdio — ask for
 * a bound with `happier auth login --wait-timeout <seconds>`, which arrives here
 * the same way the poll interval and the auth method already do.
 */
function resolveTerminalAuthWaitTimeoutMs(): number | null {
    const raw = Number.parseInt(String(process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS ?? ''), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function printServerUrlReachabilityHint(serverUrl: string): void {
    const lines = buildServerUrlReachabilityHintLines(serverUrl);
    if (lines.length === 0) return;
    for (const line of lines) {
        console.log(line);
    }
    console.log('');
}

function printMobileLinkMissingServerUrlHint(params: Readonly<{ serverUrl: string; kind: 'terminalConnect' | 'configureServer' }>): void {
    const details = isLoopbackServerHost(params.serverUrl)
        ? [
            'Your relay URL is set to localhost, which is only reachable on this machine.',
            'On your phone, open Happier → Settings → Relays and add a URL your phone can reach (LAN IP/VPN/Tailscale).',
            'Tip (recommended): set HAPPIER_PUBLIC_SERVER_URL to a shareable https:// URL so future QR codes include it automatically.',
        ]
        : ['Your phone will use its currently configured relay (Happier → Settings → Relays).'];
    // eslint-disable-next-line no-console
    console.log(warn('This mobile link does not include a relay URL.'));
    // eslint-disable-next-line no-console
    for (const line of details) console.log(chalk.gray(`  ${line}`));
    // eslint-disable-next-line no-console
    console.log('');
}

/** The heading every sign-in method starts with: where this computer connects, then what to do. */
function printConnectIntro(notes: readonly string[]): void {
    const rows = [{ label: 'Relay URL', value: configuration.serverUrl }];
    if (configuration.apiServerUrl !== configuration.serverUrl) {
        rows.push({ label: 'API URL', value: configuration.apiServerUrl });
    }
    rows.push({ label: 'Web app URL', value: configuration.webappUrl });
    console.log('');
    console.log(sectionTitle('Connect this computer'));
    console.log(definitionList(rows));
    console.log('');
    printServerUrlReachabilityHint(configuration.serverUrl);
    for (const note of notes) console.log(note);
    if (notes.length > 0) console.log('');
}

function printConfigureServerLinks(): void {
    const configureLinks = buildConfigureServerLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.serverUrl,
    });
    console.log(sectionTitle('Configure the relay in the app (optional)'));
    console.log(definitionList([
        { label: 'Web', value: configureLinks.webUrl },
        { label: 'Mobile', value: configureLinks.mobileUrl },
    ]));
    console.log('');
    if (!configureLinks.mobileUrl.includes('url=')) {
        printMobileLinkMissingServerUrlHint({ serverUrl: configuration.serverUrl, kind: 'configureServer' });
    }
}

const SAME_ACCOUNT_NOTE = chalk.gray('If you already have a Happier account on another device, sign in with that same account.');

async function applyAutoPublicServerUrlFromTailscaleServeBestEffort(): Promise<void> {
    if (!shouldAutoInferPublicServerUrl()) return;
    if (String(process.env.HAPPIER_PUBLIC_SERVER_URL ?? '').trim()) return;

    const serverUrl = String(configuration.serverUrl ?? '').trim();
    const publicServerUrl = String(configuration.publicServerUrl ?? '').trim();
    if (!serverUrl) return;
    if (publicServerUrl && publicServerUrl !== serverUrl) return;
    if (!isLoopbackHttpServerUrl(serverUrl)) return;

    const inferred = await tailscaleServeHttpsUrlForInternalServerUrl({
        internalServerUrl: serverUrl,
        timeoutMs: resolveTailscaleServeStatusTimeoutMs(),
        env: process.env,
    });
    if (!inferred) return;

    process.env.HAPPIER_PUBLIC_SERVER_URL = inferred;
    reloadConfiguration();

    const serverId = String(configuration.activeServerId ?? '').trim();
    if (!serverId) return;

    try {
        await updateSettings((current: any) => {
            const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
            const existing = servers[serverId];
            if (!existing || typeof existing !== 'object') return current;

            const existingServerUrl = String((existing as any).serverUrl ?? '').trim();
            if (!existingServerUrl || existingServerUrl !== serverUrl) return current;

            const existingPublic = String((existing as any).publicServerUrl ?? '').trim();
            // Don't override an explicit non-loopback public URL.
            if (existingPublic && existingPublic !== existingServerUrl) return current;

            const now = Date.now();
            return {
                ...current,
                servers: {
                    ...servers,
                    [serverId]: {
                        ...existing,
                        publicServerUrl: inferred,
                        updatedAt: now,
                    },
                },
            };
        });
    } catch {
        // best-effort
    }
}

function rehydrateRelayScopeEnvFromConfiguration(): void {
    const activeServerId = sanitizeServerIdForFilesystem(configuration.activeServerId ?? '', '');
    if (activeServerId) {
        process.env.HAPPIER_ACTIVE_SERVER_ID = activeServerId;
    }

    const serverUrl = String(configuration.serverUrl ?? '').trim();
    if (serverUrl) {
        process.env.HAPPIER_SERVER_URL = serverUrl;
    }

    const publicServerUrl = String(configuration.publicServerUrl ?? '').trim();
    if (publicServerUrl) {
        process.env.HAPPIER_PUBLIC_SERVER_URL = publicServerUrl;
    }

    const webappUrl = String(configuration.webappUrl ?? '').trim();
    if (webappUrl) {
        process.env.HAPPIER_WEBAPP_URL = webappUrl;
    }
}

export async function doAuth(): Promise<Credentials | null> {
    // Ink requires raw mode support; in daemon/non-tty contexts we must never render Ink
    // (it will crash with "Raw mode is not supported on the current process.stdin").
    const hasRawMode = Boolean(process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function');
    const isInteractive = Boolean(hasRawMode && process.stdout.isTTY);
    const debugRaw = (process.env.DEBUG ?? '').toString();
    const debugEnabled = Boolean(debugRaw) && debugRaw !== '0' && debugRaw.toLowerCase() !== 'false';

    const envMethodRaw = (process.env.HAPPIER_AUTH_METHOD ?? '').toString().trim().toLowerCase();
    const envMethod = envMethodRaw === 'web' || envMethodRaw === 'browser' ? 'web' : envMethodRaw === 'mobile' ? 'mobile' : null;
    const authMethod: AuthMethod | 'both' | null = envMethod ?? (isInteractive ? await selectAuthenticationMethod() : 'both');
    if (!authMethod) {
        console.log(`\n${warn('Sign-in cancelled')}\n`);
        process.exit(0);
    }

    await applyAutoPublicServerUrlFromTailscaleServeBestEffort();

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
    const claimSecret = new Uint8Array(randomBytes(32));
    const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
    const claimSecretHash = createHash('sha256').update(Buffer.from(claimSecret)).digest('base64url');
    const pairingRequirement = readTerminalPairingRequirement();
    let pairing = createTerminalPairingAuthentication({
        nowMs: Date.now(),
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });

    // Create a new authentication request
    try {
        const publicKey = encodeBase64(keypair.publicKey);
        if (debugEnabled) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${configuration.apiServerUrl}/v1/auth/request`);
            console.log(`[AUTH DEBUG] Public key: ${publicKey.substring(0, 20)}...`);
        }
        const response = await postTerminalAuthRequestCompatible({
            serverUrl: configuration.apiServerUrl,
            publicKey,
            supportsV2: true,
            supportsTokenOnly: true,
            claimSecretHash,
        });
        pairing = applyTerminalAuthRequestExpiry(pairing, response);
        if (debugEnabled) {
            console.log(`[AUTH DEBUG] Auth request sent successfully`);
        }
    } catch (error) {
        if (debugEnabled) {
            console.log(`[AUTH DEBUG] Failed to send auth request:`, error);
        }
        console.log(errorFrame("Couldn't reach the relay to start signing in", [
            configuration.apiServerUrl,
            error instanceof Error ? error.message : String(error),
            'Check the relay is running and reachable, then try again.',
        ]));
        return null;
    }

    console.log(chalk.gray(formatTerminalPairingExpiryNotice(pairing)));

    // Handle authentication based on selected method
    if (authMethod === 'mobile') {
        return await doMobileAuth({ keypair, claimSecret: claimSecretB64Url, pairing, pairingRequirement });
    }
    if (authMethod === 'web') {
        return await doWebAuth({ keypair, claimSecret: claimSecretB64Url, pairing, pairingRequirement });
    }
    return await doBothAuth({ keypair, claimSecret: claimSecretB64Url, pairing, pairingRequirement });
}

function toTerminalConnectPairingContext(pairing: TerminalPairingAuthentication): Readonly<{
    secretB64Url: string;
    createdAtMs: number;
    expiresAtMs: number;
}> {
    return {
        secretB64Url: Buffer.from(pairing.secret).toString('base64url'),
        createdAtMs: pairing.createdAtMs,
        expiresAtMs: pairing.expiresAtMs,
    };
}

async function doBothAuth(params: Readonly<{
    keypair: tweetnacl.BoxKeyPair;
    claimSecret: string;
    pairing: TerminalPairingAuthentication;
    pairingRequirement: TerminalPairingRequirement | null;
}>): Promise<Credentials | null> {
    const publicKeyB64Url = encodeBase64Url(params.keypair.publicKey);
    const terminalLinks = buildTerminalConnectLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.serverUrl,
        publicKeyB64Url,
        pairing: toTerminalConnectPairingContext(params.pairing),
    });
    const terminalMobileEmbedsServerUrl = terminalLinks.mobileUrl.includes('server=');

    printConnectIntro([
        info('Recommended: use the mobile app first. It makes linking additional devices easier.'),
        ...(params.pairingRequirement === 'v3'
            ? [warn('Authenticated pairing v3 is required. For protection from an untrusted relay, approve with the native mobile app; web pairing trusts the web app origin.')]
            : []),
    ]);
    console.log(sectionTitle('Before you continue'));
    console.log(chalk.gray(bullets([
        ...(terminalMobileEmbedsServerUrl
            ? [
                'Make sure your phone/browser can reach the relay URL embedded in the QR/deep link',
                'The app/web UI may prompt you to switch relays automatically (because the link includes server=...)',
            ]
            : [
                'Make sure your phone is already configured to the right relay (Happier → Settings → Relays)',
                'Tip: set HAPPIER_PUBLIC_SERVER_URL to embed a shareable relay URL in future QR codes',
            ]),
        'Sign in (or create an account)',
        'If you already have a Happier account on another device, sign in with that same account',
    ])));
    console.log('');

    if (!terminalMobileEmbedsServerUrl) {
        printMobileLinkMissingServerUrlHint({ serverUrl: configuration.serverUrl, kind: 'terminalConnect' });
    }

    const printConfigureLinksRaw = String(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(printConfigureLinksRaw)) printConfigureServerLinks();

    console.log(sectionTitle('Mobile app (recommended)'));
    console.log('Scan this QR code with your Happier mobile app:\n');
    displayQRCode(terminalLinks.mobileUrl);
    console.log(chalk.gray('\nOr open this link on your phone:'));
    console.log(terminalLinks.mobileUrl);
    console.log('');

    console.log(sectionTitle('Web browser'));
    console.log(chalk.gray('Open this link in a browser where you are signed in to Happier:'));
    console.log(terminalLinks.webUrl);
    console.log('');

    const noOpenRaw = (process.env.HAPPIER_NO_BROWSER_OPEN ?? '').toString().trim();
    const noOpen = Boolean(noOpenRaw) && noOpenRaw !== '0' && noOpenRaw.toLowerCase() !== 'false';
    if (!noOpen && process.stdout.isTTY) {
        try {
            await openBrowser(terminalLinks.webUrl);
        } catch {
            // best-effort
        }
    }

    return await waitForAuthentication(params);
}

/**
 * Display authentication method selector and return user choice
 */
async function selectAuthenticationMethod(): Promise<AuthMethod | null> {
    // Ink and React load only for this interactive prompt, keeping them out of every session runner.
    const [{ render }, { default: React }, { AuthSelector }] = await Promise.all([
        import('ink'),
        import('react'),
        import('./ink/AuthSelector'),
    ]);
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
async function doMobileAuth(params: Readonly<{
    keypair: tweetnacl.BoxKeyPair;
    claimSecret: string;
    pairing: TerminalPairingAuthentication;
    pairingRequirement: TerminalPairingRequirement | null;
}>): Promise<Credentials | null> {
    printConnectIntro([
        info('Approve this computer with Happier on your phone.'),
        ...(params.pairingRequirement === 'v3'
            ? [warn('Authenticated pairing v3 is required. For protection from an untrusted relay, approve with the native mobile app; web pairing trusts the web app origin.')]
            : []),
        SAME_ACCOUNT_NOTE,
    ]);

    const publicKeyB64Url = encodeBase64Url(params.keypair.publicKey);
    const terminalLinks = buildTerminalConnectLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.serverUrl,
        publicKeyB64Url,
        pairing: toTerminalConnectPairingContext(params.pairing),
    });
    const terminalMobileEmbedsServerUrl = terminalLinks.mobileUrl.includes('server=');

    const printConfigureLinksRaw = String(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(printConfigureLinksRaw)) printConfigureServerLinks();

    if (!terminalMobileEmbedsServerUrl) {
        printMobileLinkMissingServerUrlHint({ serverUrl: configuration.serverUrl, kind: 'terminalConnect' });
    }

    console.log('Scan this QR code with your Happier mobile app:\n');
    displayQRCode(terminalLinks.mobileUrl);

    console.log(chalk.gray('\nCopy this link if you cannot scan the code:'));
    console.log(terminalLinks.mobileUrl);
    console.log('');
    console.log(chalk.gray('Prefer a browser? Cancel and run this command again, then choose Web browser.'));

    return await waitForAuthentication(params);
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(params: Readonly<{
    keypair: tweetnacl.BoxKeyPair;
    claimSecret: string;
    pairing: TerminalPairingAuthentication;
    pairingRequirement: TerminalPairingRequirement | null;
}>): Promise<Credentials | null> {
    printConnectIntro([
        ...(params.pairingRequirement === 'v3'
            ? [warn('Authenticated pairing v3 is required, but web pairing still trusts the web app origin. Use the native mobile app for protection from an untrusted relay.')]
            : []),
        SAME_ACCOUNT_NOTE,
    ]);

    const publicKeyB64Url = encodeBase64Url(params.keypair.publicKey);
    const terminalLinks = buildTerminalConnectLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.serverUrl,
        publicKeyB64Url,
        pairing: toTerminalConnectPairingContext(params.pairing),
    });
    const webUrl = terminalLinks.webUrl;
    const noOpenRaw = (process.env.HAPPIER_NO_BROWSER_OPEN ?? '').toString().trim();
    const noOpen = Boolean(noOpenRaw) && noOpenRaw !== '0' && noOpenRaw.toLowerCase() !== 'false';
    if (!noOpen) {
        const browserOpened = await openBrowser(webUrl);

        if (browserOpened) {
            console.log(ok('Opened your browser'));
        } else {
            console.log(info('No browser opened. This is normal on a headless or remote computer.'));
        }
    } else {
        console.log(info('Browser opening is disabled; use the link below from any browser.'));
    }

    // I changed this to always show the URL because we got a report from
    // someone running happy inside the dev-box container image that they saw the
    // "Complete authentication in your browser window." but nothing opened.
    // https://github.com/slopus/happy/issues/19
    console.log(chalk.gray('\nCopy this link into any browser:'));
    console.log(webUrl);
    console.log('');
    console.log('Sign in to the same Happier account you use on your other devices, then approve this computer.');
    console.log(chalk.gray('Prefer the mobile app? Cancel and run this command again, then choose Mobile app.\n'));

    return await waitForAuthentication(params, 'planet');
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(
    params: Readonly<{
        keypair: tweetnacl.BoxKeyPair;
        claimSecret: string;
        pairing: TerminalPairingAuthentication;
        pairingRequirement: TerminalPairingRequirement | null;
    }>,
    appearance: 'compact' | 'planet' = 'compact',
): Promise<Credentials | null> {
    const steps = createStepPrinter({ appearance });
    // The wait is one step: it ends as ✓ Approved, or as x/! with what happened and what to do next.
    const end = (result: 'x' | '!', title: string, details: readonly string[] = []): void => {
        steps.stop(result, title);
        for (const detail of details) console.log(chalk.gray(`  ${detail}`));
    };
    const signInAgain = `Run ${cmd('happier auth login')} again to create a new sign-in request.`;
    steps.start('Waiting for authentication');
    let cancelled = false;

    // Handle Ctrl-C during waiting
    const handleInterrupt = () => {
        cancelled = true;
        end('!', 'Sign-in cancelled');
        process.exit(0);
    };

    process.on('SIGINT', handleInterrupt);

    try {
        const pollIntervalMsRaw = Number(process.env.HAPPIER_AUTH_POLL_INTERVAL_MS ?? '');
        const pollIntervalMs = Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0 ? pollIntervalMsRaw : 1000;
        const waitTimeoutMs = resolveTerminalAuthWaitTimeoutMs();
        const waitDeadlineMs = waitTimeoutMs === null ? null : Date.now() + waitTimeoutMs;
        const publicKey = encodeBase64(params.keypair.publicKey);

        const remainingRequestTimeoutMs = (): number | undefined => {
            if (waitDeadlineMs === null) return undefined;
            return Math.max(1, waitDeadlineMs - Date.now());
        };
        const waitExpired = (): boolean => waitDeadlineMs !== null && Date.now() >= waitDeadlineMs;
        const printWaitExpired = (): void => {
            end('!', 'Stopped waiting for the sign-in to be approved', [signInAgain]);
        };

        let mode: 'status-claim' | 'legacy-post' = 'status-claim';

        while (!cancelled) {
            if (waitExpired()) {
                printWaitExpired();
                return null;
            }
            try {
                const tryFinalizeWithTokenAndEncryptedResponse = async (token: string, responseB64: string): Promise<Credentials | null> => {
                    const r = decodeBase64(responseB64);
                    const opened = openTerminalProvisioningResponse({
                        payload: r,
                        terminalSecretKey: params.keypair.secretKey,
                        terminalPublicKey: params.keypair.publicKey,
                        pairing: params.pairing,
                        requirement: params.pairingRequirement,
                        nowMs: Date.now(),
                    });
                    if (!opened) {
                        if (params.pairingRequirement === 'v3') {
                            end('x', 'Authenticated terminal pairing v3 is required', ['Update the Happier mobile app and scan a new QR code.']);
                        } else {
                            end('x', "Couldn't decrypt the relay's response", ['Please try again.']);
                        }
                        return null;
                    }

                    if (opened.type === 'tokenOnly') {
                        const credentials = await writeCredentialsTokenOnly({ token });
                        steps.stop('✓', 'Approved');
                        return credentials;
                    }

                    if (opened.type === 'legacy') {
                        await writeCredentialsLegacy({ secret: opened.key, token });
                        steps.stop('✓', 'Approved');
                        return { encryption: { type: 'legacy', secret: opened.key }, token };
                    }

                    const publicKeyBytes = tweetnacl.box.keyPair.fromSecretKey(opened.key).publicKey;
                    await writeCredentialsDataKey({ publicKey: publicKeyBytes, machineKey: opened.key, token });
                    steps.stop('✓', 'Approved');
                    return { encryption: { type: 'dataKey', publicKey: publicKeyBytes, machineKey: opened.key }, token };
                };

                const legacyPollOnce = async (): Promise<
                    PostTerminalAuthRequestCompatibleResponse
                > => {
                    const data = await postTerminalAuthRequestCompatible({
                        serverUrl: configuration.apiServerUrl,
                        publicKey,
                        supportsV2: true,
                        supportsTokenOnly: true,
                        timeoutMs: remainingRequestTimeoutMs(),
                    });
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
                        statusRes = await axios.get(`${configuration.apiServerUrl}/v1/auth/request/status`, {
                            params: { publicKey },
                            timeout: remainingRequestTimeoutMs(),
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
                        end('x', 'The sign-in request expired', [signInAgain]);
                        return null;
                    }

                    if (status === 'authorized') {
                        try {
                            const claimRes = await axios.post(`${configuration.apiServerUrl}/v1/auth/request/claim`, {
                                publicKey,
                                claimSecret: params.claimSecret,
                            }, { timeout: remainingRequestTimeoutMs() });

                            const claimData = claimRes?.data;
                            if (claimData?.state !== 'authorized') {
                                await delay(pollIntervalMs);
                                continue;
                            }

                            if (typeof claimData.token !== 'string' || typeof claimData.response !== 'string') {
                                end('x', 'Unexpected response from the relay', ['Please try again.']);
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
                                end('x', err === 'consumed' ? 'The sign-in request was already claimed' : 'The sign-in request expired', [signInAgain]);
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
                if (waitExpired()) {
                    printWaitExpired();
                    return null;
                }
                end('x', "Couldn't check whether the sign-in was approved", [
                    error instanceof Error ? error.message : String(error),
                    'Please try again.',
                ]);
                return null;
            }

            if (waitExpired()) {
                printWaitExpired();
                return null;
            }

            await delay(pollIntervalMs);
        }
    } finally {
        steps.pause();
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

export async function ensureMachineIdInSettings(opts?: {
    forceNew?: boolean;
    accountId?: string | null;
}): Promise<{ machineId: string }> {
    const forceNew = opts?.forceNew ?? false;
    const accountId = typeof opts?.accountId === 'string' ? opts.accountId.trim() : '';

    const settings = await updateSettings(async s => {
        const activeServerId = sanitizeServerIdForFilesystem(
            configuration.activeServerId ?? s.activeServerId ?? 'cloud',
            'cloud',
        );

        return selectMachineIdentityInSettings(s, {
            serverId: activeServerId,
            accountId,
            forceNew,
            createMachineId: randomUUID,
        });
    });

    if (!settings.machineId) throw new Error('Failed to ensure machine id in settings');
    return { machineId: settings.machineId };
}

export async function ensureMachineIdForCredentials(
    credentials: Credentials,
    opts?: { forceNew?: boolean },
): Promise<{ machineId: string }> {
    let tokenPayload: Record<string, unknown> | null = null;
    try {
        tokenPayload = decodeJwtPayload(credentials.token);
    } catch {
        tokenPayload = null;
    }
    const accountId = typeof tokenPayload?.sub === 'string' ? tokenPayload.sub.trim() : null;

    let previousAccountId: string | null = null;
    let activeServerIdForLog: string | null = null;
    if (accountId) {
        try {
            const settings = await readSettings();
            const activeServerId = sanitizeServerIdForFilesystem(
                configuration.activeServerId ?? settings.activeServerId ?? 'cloud',
                'cloud',
            );
            activeServerIdForLog = activeServerId;
            const prev = settings.lastTokenSubByServerId?.[activeServerId];
            previousAccountId = typeof prev === 'string' ? prev.trim() : null;
        } catch {
            // best-effort only
        }
    }

    const ensured = await ensureMachineIdInSettings({
        accountId,
        forceNew: Boolean(opts?.forceNew) && !accountId,
    });
    if (accountId && previousAccountId && previousAccountId !== accountId) {
        logger.info(
            `[AUTH] tokenSub changed for server=${activeServerIdForLog ?? 'unknown'} machineId=${ensured.machineId} (account ids redacted)`,
        );
    }

    return ensured;
}


/**
 * Ensure authentication and machine setup
 * This replaces the onboarding flow and ensures everything is ready
 */
export async function authAndSetupMachineIfNeeded(opts: Readonly<{
    callerIntent?: 'standalone' | 'setup-managed';
}> = {}): Promise<{
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
    const { machineId } = await ensureMachineIdForCredentials(credentials, { forceNew: newAuth });

    logger.debug(`[AUTH] Machine ID: ${machineId}`);
    rehydrateRelayScopeEnvFromConfiguration();

    if (
      shouldAutoStartDaemonAfterAuth({
        env: process.env,
        isDaemonProcess: configuration.isDaemonProcess,
        startedBy: 'terminal',
        callerIntent: opts.callerIntent,
      })
    ) {
      try {
        await ensureDaemonRunningForSessionCommand();
      } catch (e) {
        // Non-fatal: the session can still run without daemon, but remote spawn/control will be degraded.
        logger.debug('[AUTH] Failed to auto-start daemon (non-fatal)', e);
      }
    }

    return { credentials, machineId };
}
