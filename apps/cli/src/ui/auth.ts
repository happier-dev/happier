import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration, reloadConfiguration } from "@/configuration";
import { createHash, randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import { displayQRCode } from "./qrcode";
import { delay, delayUnrefAbortable } from "@/utils/time";
import {
    readStoredCredentials,
    readSettings,
    updateSettings,
    type StoredCredentials,
    writeCredentialsDataKey,
    writeCredentialsTokenOnly,
} from "@/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { sanitizeServerIdForFilesystem } from "@/server/serverId";
import { openBrowser, BROWSER_NOT_OPENED_NOTE, COPY_LINK_INTO_BROWSER_PROMPT } from '@/ui/openBrowser';
import type { AuthMethod } from "./ink/AuthSelector";
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import { ensureDaemonRunningForSessionCommand, shouldAutoStartDaemonAfterAuth } from '@/daemon/ensureDaemon';
import { buildConfigureServerLinks, buildTerminalConnectLinks } from '@happier-dev/cli-common/links';
import { createStepPrinter } from '@happier-dev/cli-common/output';
import { tailscaleServeHttpsUrlForInternalServerUrl } from '@/integrations/tailscale/tailscaleServe';
import { isLoopbackHttpServerUrl, isLoopbackServerHost } from '@/server/serverUrlClassification';
import { buildServerUrlReachabilityHintLines } from '@/server/reachability/serverUrlReachabilityHint';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import {
    createTerminalPairingAuthentication,
    openTerminalProvisioningResponse,
    type TerminalPairingAuthentication,
} from '@/auth/terminalProvisioningResponse';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { assertResolvedHomeTargetIdentity } from '@happier-dev/cli-common/homeTarget';
import { ApiClient } from '@/api/api';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { hasUsableAccountSettingsEncryptionMaterial } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import {
    claimTerminalAuthRequest,
    createTerminalAuthRequest,
    TerminalAuthEnrollmentVerificationError,
    readTerminalAuthRequestStatus,
    resolveAuthenticatedExactHomeConnectionDescriptorObservation,
    verifyTerminalAuthEnrollmentRuntime,
    type TerminalAuthEnrollmentRuntime,
} from '@/auth/terminalAuthEnrollmentClient';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

type InteractiveTerminalAuthContext = Readonly<{
    callerIntent: AuthCallerIntent;
    keypair: tweetnacl.BoxKeyPair;
    claimSecret: string;
    pairing: TerminalPairingAuthentication;
    serverIdentityId: string;
    target: ResolvedHomeTarget;
    runtime: TerminalAuthEnrollmentRuntime;
    signal?: AbortSignal;
    retainedCredentialForMaterialRecovery?: StoredCredentials;
    verifyClaimDestination(token: string): Promise<CliServerFeaturesSnapshot>;
}>;

export type AuthCallerIntent = 'standalone' | 'setup-managed';

export class AuthenticationCancelledError extends Error {
    readonly code = 'authentication_cancelled';

    constructor() {
        super('Authentication cancelled');
        this.name = 'AuthenticationCancelledError';
    }
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
 * Omitted means unbounded: a person directly running `happier auth login` owns
 * that terminal. Guided setup supplies a bound because it must eventually hand
 * the terminal back with a named re-entry command.
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
    // eslint-disable-next-line no-console
    console.log('Note: this mobile link does not include a server URL.');
    if (isLoopbackServerHost(params.serverUrl)) {
        // eslint-disable-next-line no-console
        console.log('Your server URL is set to localhost, which is only reachable on this machine.');
        // eslint-disable-next-line no-console
        console.log('On your phone, open Happier → Settings → Servers and add a URL your phone can reach (LAN IP/VPN/Tailscale).');
        // eslint-disable-next-line no-console
        console.log('Tip (recommended): set HAPPIER_PUBLIC_SERVER_URL to a shareable https:// URL so future QR codes include it automatically.');
    } else {
        // eslint-disable-next-line no-console
        console.log('Your phone will use its currently configured server (Happier → Settings → Servers).');
    }
    // eslint-disable-next-line no-console
    console.log('');
}

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

export async function doAuth(options: Readonly<{
    callerIntent?: AuthCallerIntent;
    signal?: AbortSignal;
    retainedCredentialForMaterialRecovery?: StoredCredentials;
    onAuthenticated?: (input: Readonly<{
        credentials: StoredCredentials;
        runtime: TerminalAuthEnrollmentRuntime;
    }>) => Promise<void>;
}> = {}): Promise<StoredCredentials | null> {
    options.signal?.throwIfAborted();
    // Ink requires raw mode support; in daemon/non-tty contexts we must never render Ink
    // (it will crash with "Raw mode is not supported on the current process.stdin").
    const hasRawMode = Boolean(process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function');
    const isInteractive = Boolean(hasRawMode && process.stdout.isTTY);
    const debugRaw = (process.env.DEBUG ?? '').toString();
    const debugEnabled = Boolean(debugRaw) && debugRaw !== '0' && debugRaw.toLowerCase() !== 'false';

    const envMethodRaw = (process.env.HAPPIER_AUTH_METHOD ?? '').toString().trim().toLowerCase();
    const envMethod = envMethodRaw === 'web' || envMethodRaw === 'browser' ? 'web' : envMethodRaw === 'mobile' ? 'mobile' : null;
    const authMethod: AuthMethod | 'both' | null = envMethod ?? (isInteractive ? await selectAuthenticationMethod(options.signal) : 'both');
    if (!authMethod) {
        console.log('\nAuthentication cancelled.\n');
        if (options.callerIntent !== 'setup-managed') {
            process.exit(0);
        }
        throw new AuthenticationCancelledError();
    }

    let target: ResolvedHomeTarget;
    try {
        const selectedTarget = await resolveCurrentCliHomeTarget();
        target = selectedTarget.descriptor
            ? selectedTarget
            : await resolveCliHomeTarget({ kind: 'https_url', url: configuration.apiServerUrl });
    } catch {
        console.log('The selected Home address is not eligible for terminal authentication. Use HTTPS or loopback HTTP.');
        return null;
    }
    // Tailscale inference is a released URL-only compatibility adapter for
    // legacy QR/deep links. A descriptor is already the route authority; adding
    // and persisting another inferred route here would compete with descriptor
    // publication/reconciliation and is unnecessary for Iroh first contact.
    if (!target.descriptor) {
        await applyAutoPublicServerUrlFromTailscaleServeBestEffort();
    }
    const acquiredRuntime = await acquireTerminalAuthEnrollmentRuntime(
        target.descriptor ?? target, target.preferredTransport, options.signal,
    );
    if (!acquiredRuntime.ok) {
        console.log('Unable to reach the selected Home through an authenticated enrollment carrier.');
        return null;
    }
    const authRuntimeOrigin = acquiredRuntime.runtime.runtimeOrigin;
    try {
    const featuresSnapshot = await fetchServerFeaturesSnapshot({
        serverUrl: authRuntimeOrigin,
        ...(options.signal ? { signal: options.signal } : {}),
    });
    let verifiedRuntime;
    try {
        verifiedRuntime = verifyTerminalAuthEnrollmentRuntime({
            target,
            runtime: acquiredRuntime.runtime,
            snapshot: featuresSnapshot,
        });
    } catch (error) {
        console.log(
            error instanceof TerminalAuthEnrollmentVerificationError
                ? `${error.code}: ${error.message} The authentication request was not created.`
                : 'Unable to verify the selected Home identity due to an unexpected verification failure; '
                    + 'the authentication request was not created.',
        );
        return null;
    }
    const serverIdentityId = verifiedRuntime.homeServerIdentityId;

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
    const claimSecret = new Uint8Array(randomBytes(32));
    const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
    const claimSecretHash = createHash('sha256').update(Buffer.from(claimSecret)).digest('base64url');
    const pairing = createTerminalPairingAuthentication({
        nowMs: Date.now(),
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });

    // Create a new authentication request
    try {
        const publicKey = encodeBase64(keypair.publicKey);
        if (debugEnabled) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${authRuntimeOrigin}/v1/auth/request`);
            console.log(`[AUTH DEBUG] Public key: ${publicKey.substring(0, 20)}...`);
        }
        await createTerminalAuthRequest({
            runtime: acquiredRuntime.runtime,
            publicKey,
            supportsV2: true,
            claimSecretHash,
            headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            ...(options.signal ? { signal: options.signal } : {}),
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
    const authenticatedExactDescriptorObservation: {
        current: ReturnType<typeof resolveAuthenticatedExactHomeConnectionDescriptorObservation> | null;
    } = { current: null };
    const authContext: InteractiveTerminalAuthContext = {
        callerIntent: options.callerIntent ?? 'standalone',
        keypair,
        claimSecret: claimSecretB64Url,
        pairing,
        serverIdentityId: verifiedRuntime.homeServerIdentityId,
        target,
        runtime: acquiredRuntime.runtime,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.retainedCredentialForMaterialRecovery
            ? { retainedCredentialForMaterialRecovery: options.retainedCredentialForMaterialRecovery }
            : {}),
        verifyClaimDestination: async (token) => {
            const snapshot = await fetchServerFeaturesSnapshot({
                serverUrl: authRuntimeOrigin,
                token,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            verifyTerminalAuthEnrollmentRuntime({ target, runtime: acquiredRuntime.runtime, snapshot });
            const exactDescriptorObservation = resolveAuthenticatedExactHomeConnectionDescriptorObservation({
                snapshot,
                expectedHomeServerIdentityId: serverIdentityId,
            });
            authenticatedExactDescriptorObservation.current = exactDescriptorObservation;
            return snapshot;
        },
    };
    const credentials = authMethod === 'mobile'
        ? await doMobileAuth(authContext)
        : authMethod === 'web'
            ? await doWebAuth(authContext)
            : await doBothAuth(authContext);
    const exactDescriptorObservation = authenticatedExactDescriptorObservation.current
        ?? { kind: 'unavailable' as const };
    if (exactDescriptorObservation.kind === 'available') {
        const descriptor = exactDescriptorObservation.descriptor;
        const target = await resolveCurrentCliHomeTarget();
        assertResolvedHomeTargetIdentity(target, serverIdentityId);
        // Env-only manual targets remain usable without manufacturing a profile.
        // Persisted targets adopt at their immutable profile/credential owner.
        if (target.profileId) {
            await adoptServerProfileHomeConnectionDescriptor({
                descriptor,
                expectedProfileId: target.profileId,
                observation: 'exact',
            });
        }
    }
    if (credentials && options.onAuthenticated) {
        await options.onAuthenticated({
            credentials,
            runtime: acquiredRuntime.runtime,
        });
    }
    return credentials;
    } finally {
        await acquiredRuntime.close();
    }
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

function buildInteractiveTerminalConnectLinks(params: InteractiveTerminalAuthContext) {
    const common = {
        webappUrl: configuration.webappUrl,
        publicKeyB64Url: encodeBase64Url(params.keypair.publicKey),
        pairing: toTerminalConnectPairingContext(params.pairing),
        supportsTokenOnly: true,
    } as const;
    return params.target.descriptor
        ? buildTerminalConnectLinks({
            ...common,
            homeConnectionDescriptor: params.target.descriptor,
        })
        : buildTerminalConnectLinks({
            ...common,
            serverUrl: configuration.serverUrl,
            serverIdentityId: params.serverIdentityId,
        });
}

async function doBothAuth(params: InteractiveTerminalAuthContext): Promise<StoredCredentials | null> {
    const terminalLinks = buildInteractiveTerminalConnectLinks(params);
    const terminalMobileEmbedsServerUrl = terminalLinks.mobileUrl.includes('server=');

    console.log('\nAuthenticate this machine\n');
    console.log(`This terminal is connected to: ${configuration.serverUrl}`);
    if (configuration.apiServerUrl !== configuration.serverUrl) {
        console.log(`API URL: ${configuration.apiServerUrl}`);
    }
    console.log(`Web app URL: ${configuration.webappUrl}`);
    console.log('');
    printServerUrlReachabilityHint(configuration.serverUrl);
    console.log('Recommended: use the mobile app first. It makes linking additional devices easier.');
    console.log('Authenticated pairing v3 is required. For protection from an untrusted relay, approve with the native mobile app; web pairing trusts the web app origin.');
    console.log('');
    console.log('Before you continue:');
    if (terminalMobileEmbedsServerUrl) {
        console.log('- Make sure your phone/browser can reach the server URL embedded in the QR/deep link');
        console.log('- The app/web UI may prompt you to switch servers automatically (because the link includes server=...)');
    } else {
        console.log('- Make sure your phone is already configured to the right server (Happier → Settings → Servers)');
        console.log('- Tip: set HAPPIER_PUBLIC_SERVER_URL to embed a shareable server URL in future QR codes');
    }
    console.log('- Sign in (or create an account)');
    console.log('- If you already have a Happier account on another device, sign in with that same account');
    console.log('');

    if (!terminalMobileEmbedsServerUrl) {
        printMobileLinkMissingServerUrlHint({ serverUrl: configuration.serverUrl, kind: 'terminalConnect' });
    }

    const printConfigureLinksRaw = String(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS ?? '').trim().toLowerCase();
    const printConfigureLinks = ['1', 'true', 'yes', 'on'].includes(printConfigureLinksRaw);
    if (printConfigureLinks) {
        const configureLinks = buildConfigureServerLinks({
            webappUrl: configuration.webappUrl,
            serverUrl: configuration.serverUrl,
        });
        console.log('Optional — Configure server in app/web (advanced)');
        console.log('Web (prefill + confirm):');
        console.log(configureLinks.webUrl);
        console.log('Mobile deep link:');
        console.log(configureLinks.mobileUrl);
        console.log('');
        if (!configureLinks.mobileUrl.includes('url=')) {
            printMobileLinkMissingServerUrlHint({ serverUrl: configuration.serverUrl, kind: 'configureServer' });
        }
    }

    console.log('Mobile (recommended)');
    console.log('Scan this QR code with your Happier mobile app:\n');
    displayQRCode(terminalLinks.mobileUrl);
    console.log('\nOr manually open this URL:');
    console.log(terminalLinks.mobileUrl);
    console.log('');

    console.log('Web (fallback)');
    console.log('Open this URL in a browser where you are signed in to Happier:');
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
async function selectAuthenticationMethod(signal?: AbortSignal): Promise<AuthMethod | null> {
    const [{ AuthSelector }, { render }, { default: React }] = await Promise.all([
        import('./ink/AuthSelector'),
        import('ink'),
        import('react'),
    ]);
    if (signal?.aborted) return null;
    return new Promise((resolve) => {
        let hasResolved = false;
        let app: ReturnType<typeof render> | null = null;

        const finish = (value: AuthMethod | null): void => {
            if (hasResolved) return;
            hasResolved = true;
            signal?.removeEventListener('abort', onAbort);
            app?.unmount();
            resolve(value);
        };

        const onSelect = (method: AuthMethod) => {
            finish(method);
        };

        const onCancel = () => {
            finish(null);
        };

        const onAbort = (): void => finish(null);

        app = render(React.createElement(AuthSelector, { onSelect, onCancel }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

/**
 * Handle mobile authentication flow
 */
async function doMobileAuth(params: InteractiveTerminalAuthContext): Promise<StoredCredentials | null> {
    console.log('\nConnect this computer\n');
    console.log(`This terminal is connected to: ${configuration.serverUrl}`);
    if (configuration.apiServerUrl !== configuration.serverUrl) {
        console.log(`API URL: ${configuration.apiServerUrl}`);
    }
    console.log(`Web app URL: ${configuration.webappUrl}\n`);
    printServerUrlReachabilityHint(configuration.serverUrl);
    console.log('Approve this computer with Happier on your phone.');
    console.log('Authenticated pairing v3 is required. For protection from an untrusted relay, approve with the native mobile app; web pairing trusts the web app origin.');
    console.log('If you already have a Happier account on another device, sign in with that same account.\n');

    const terminalLinks = buildInteractiveTerminalConnectLinks(params);
    const terminalMobileEmbedsServerUrl = terminalLinks.mobileUrl.includes('server=');

    const printConfigureLinksRaw = String(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS ?? '').trim().toLowerCase();
    const printConfigureLinks = ['1', 'true', 'yes', 'on'].includes(printConfigureLinksRaw);
    if (printConfigureLinks) {
        const configureLinks = buildConfigureServerLinks({
            webappUrl: configuration.webappUrl,
            serverUrl: configuration.serverUrl,
        });
        console.log('Optional — Configure server in app/web (advanced)');
        console.log('Web (prefill + confirm):');
        console.log(configureLinks.webUrl);
        console.log('Mobile deep link:');
        console.log(configureLinks.mobileUrl);
        console.log('');
        if (!configureLinks.mobileUrl.includes('url=')) {
            printMobileLinkMissingServerUrlHint({ serverUrl: configuration.serverUrl, kind: 'configureServer' });
        }
    }

    if (!terminalMobileEmbedsServerUrl) {
        printMobileLinkMissingServerUrlHint({ serverUrl: configuration.serverUrl, kind: 'terminalConnect' });
    }

    console.log('Scan this QR code with your Happier mobile app:\n');
    displayQRCode(terminalLinks.mobileUrl);

    console.log('\nCopy this link if you cannot scan the code:');
    console.log(terminalLinks.mobileUrl);
    console.log('');
    console.log('Prefer a browser? Cancel and run this command again, then choose Web browser.');

    return await waitForAuthentication(params);
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(params: InteractiveTerminalAuthContext): Promise<StoredCredentials | null> {
    console.log('\nConnect this computer\n');
    console.log(`This terminal is connected to: ${configuration.serverUrl}`);
    if (configuration.apiServerUrl !== configuration.serverUrl) {
        console.log(`API URL: ${configuration.apiServerUrl}`);
    }
    console.log(`Web app URL: ${configuration.webappUrl}\n`);
    printServerUrlReachabilityHint(configuration.serverUrl);
    console.log('Authenticated pairing v3 is required, but web pairing still trusts the web app origin. Use the native mobile app for protection from an untrusted relay.\n');
    console.log('If you already have a Happier account on another device, sign in with that same account.\n');

    const terminalLinks = buildInteractiveTerminalConnectLinks(params);
    const webUrl = terminalLinks.webUrl;
    const noOpenRaw = (process.env.HAPPIER_NO_BROWSER_OPEN ?? '').toString().trim();
    const noOpen = Boolean(noOpenRaw) && noOpenRaw !== '0' && noOpenRaw.toLowerCase() !== 'false';
    if (!noOpen) {
        console.log('Opening your browser...');

        const browserOpened = await openBrowser(webUrl);

        if (browserOpened) {
            console.log('✓ Browser opened');
        } else {
            console.log(BROWSER_NOT_OPENED_NOTE);
        }
    } else {
        console.log('Browser opening is disabled; use the link below from any browser.');
    }

    // I changed this to always show the URL because we got a report from
    // someone running happy inside the dev-box container image that they saw the
    // "Complete authentication in your browser window." but nothing opened.
    // https://github.com/slopus/happy/issues/19
    console.log(`\n${COPY_LINK_INTO_BROWSER_PROMPT}`);
    console.log(webUrl);
    console.log('');
    console.log('Sign in to the same Happier account you use on your other devices, then approve this computer.');
    console.log('Prefer the mobile app? Cancel and run this command again, then choose Mobile app.\n');

    return await waitForAuthentication(params, 'planet');
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(
    params: InteractiveTerminalAuthContext,
    appearance: 'compact' | 'planet' = 'compact',
): Promise<StoredCredentials | null> {
    const steps = createStepPrinter({ appearance });
    const print = (...args: unknown[]): void => {
        steps.pause();
        console.log(...args);
    };
    steps.start('Waiting for authentication');
    let cancelled = false;

    // Handle Ctrl-C during waiting
    const handleInterrupt = () => {
        cancelled = true;
        print('\n\nAuthentication cancelled.');
        if (params.callerIntent === 'standalone') {
            process.exit(0);
        }
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
            print('\n\nStopped waiting for the sign-in to be approved.');
            print('Run `happier auth login` again to create a new sign-in request.');
        };
        const throwIfCancelled = (): void => {
            if (cancelled || params.signal?.aborted) throw new AuthenticationCancelledError();
        };
        const waitForNextPoll = async (): Promise<void> => {
            if (params.signal) {
                await delayUnrefAbortable(pollIntervalMs, params.signal);
            } else {
                await delay(pollIntervalMs);
            }
            throwIfCancelled();
        };

        while (!cancelled) {
            if (waitExpired()) {
                printWaitExpired();
                return null;
            }
            try {
                const tryFinalizeWithTokenAndEncryptedResponse = async (
                    token: string,
                    responseB64: string,
                    observedServerIdentityId: unknown,
                ): Promise<StoredCredentials | null> => {
                    if (String(observedServerIdentityId ?? '').trim() !== params.serverIdentityId) {
                        print(
                            '\n\nThe authentication response came from a different Home identity. '
                            + 'Credentials were not changed; run `happier auth login` again for the intended Home.',
                        );
                        return null;
                    }
                    try {
                        await params.verifyClaimDestination(token);
                    } catch {
                        print(
                            '\n\nThe authentication response did not match the selected Home destination. '
                            + 'Credentials were not changed; run `happier auth login` again for the intended Home.',
                        );
                        return null;
                    }
                    const r = decodeBase64(responseB64);
                    const opened = openTerminalProvisioningResponse({
                        payload: r,
                        terminalSecretKey: params.keypair.secretKey,
                        terminalPublicKey: params.keypair.publicKey,
                        pairing: params.pairing,
                        nowMs: Date.now(),
                        supportsTokenOnly: true,
                    });
                    if (!opened) {
                        print('\n\nAuthenticated terminal pairing v3 is required. Update the Happier mobile app and scan a new QR code.');
                        return null;
                    }

                    if (opened.type === 'tokenOnly') {
                        if (params.retainedCredentialForMaterialRecovery) {
                            print('\n\nThe approving device did not provide the encryption material required by this Home.');
                            return null;
                        }
                        await writeCredentialsTokenOnly({ token });
                        return { encryption: null, token };
                    }

                    const publicKeyBytes = tweetnacl.box.keyPair.fromSecretKey(opened.key).publicKey;
                    const retainedCredential = params.retainedCredentialForMaterialRecovery;
                    const persistedToken = retainedCredential
                        ? (() => {
                            const retainedAccountId = readAccountIdFromToken(retainedCredential.token);
                            if (!retainedAccountId || readAccountIdFromToken(token) !== retainedAccountId) {
                                return null;
                            }
                            return retainedCredential.token;
                        })()
                        : token;
                    if (!persistedToken) {
                        print('\n\nThe approving device belongs to a different Account. Existing Home credentials were kept.');
                        return null;
                    }
                    await writeCredentialsDataKey({ publicKey: publicKeyBytes, machineKey: opened.key, token: persistedToken });
                    return { encryption: { type: 'dataKey', publicKey: publicKeyBytes, machineKey: opened.key }, token: persistedToken };
                };

                {
                    let statusRes: any;
                    try {
                        statusRes = { data: await readTerminalAuthRequestStatus({
                            runtime: params.runtime,
                            publicKey,
                            headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                            timeoutMs: remainingRequestTimeoutMs(),
                            ...(params.signal ? { signal: params.signal } : {}),
                        }) };
                        throwIfCancelled();
                    } catch (e: any) {
                        const code = e?.response?.status;
                        if (code === 404) {
                            print('\n\nAuthenticated terminal pairing v3 is required. Update Happier on the selected Home and try again.');
                            return null;
                        }
                        throw e;
                    }

                    const status = statusRes.data?.status;
                    if (status === 'not_found') {
                        print('\n\nAuthentication request expired. Please run `happier auth login` again.');
                        return null;
                    }

                    if (status === 'authorized') {
                        try {
                            const claimRes = { data: await claimTerminalAuthRequest({
                                runtime: params.runtime,
                                publicKey,
                                claimSecret: params.claimSecret,
                                headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                                timeoutMs: remainingRequestTimeoutMs(),
                                ...(params.signal ? { signal: params.signal } : {}),
                            }) };
                            throwIfCancelled();

                            const claimData = claimRes?.data;
                            if (!claimData || typeof claimData !== 'object' || Array.isArray(claimData)) {
                                print('\n\nUnexpected response from server. Please try again.');
                                return null;
                            }
                            const claim = claimData as Record<string, unknown>;
                            if (claim.state !== 'authorized') {
                                await waitForNextPoll();
                                continue;
                            }

                            if (typeof claim.token !== 'string' || typeof claim.response !== 'string') {
                                print('\n\nUnexpected response from server. Please try again.');
                                return null;
                            }

                            const token = claim.token;
                            const responseB64 = claim.response;
                            const finalized = await tryFinalizeWithTokenAndEncryptedResponse(
                                token,
                                responseB64,
                                claim.serverIdentityId,
                            );
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
                                print(`\n\n${message}`);
                                return null;
                            }
                            if (code === 404 || (code === 400 && err === 'claim_not_supported') || (code === 409 && err === 'claim_not_supported')) {
                                print('\n\nAuthenticated terminal pairing v3 is required. Update Happier on the selected Home and try again.');
                                return null;
                            }
                            throw e;
                        }
                    }
                }
            } catch (error) {
                throwIfCancelled();
                if (error instanceof AuthenticationCancelledError) throw error;
                if (waitExpired()) {
                    printWaitExpired();
                    return null;
                }
                print('\n\nFailed to check authentication status. Please try again.');
                return null;
            }

            if (waitExpired()) {
                printWaitExpired();
                return null;
            }

            await waitForNextPoll();
        }
    } finally {
        steps.pause();
        process.off('SIGINT', handleInterrupt);
    }

    if (cancelled) {
        throw new AuthenticationCancelledError();
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

        const nextMachineIdByServerId = { ...(s.machineIdByServerId ?? {}) };
        const prevMachineIdForServer = nextMachineIdByServerId[activeServerId];
        const nextLastSubByServerId = { ...(s.lastTokenSubByServerId ?? {}) };
        const nextConfirmed = { ...(s.machineIdConfirmedByServerByServerId ?? {}) };
        const hadLastSub = activeServerId in nextLastSubByServerId;
        const hadConfirmed = activeServerId in nextConfirmed;

        if (!accountId) {
            const current = prevMachineIdForServer;
            if (hadLastSub) delete nextLastSubByServerId[activeServerId];
            if (hadConfirmed) delete nextConfirmed[activeServerId];

            if (forceNew || !current) {
                const machineId = randomUUID();
                nextMachineIdByServerId[activeServerId] = machineId;
                return {
                    ...s,
                    machineIdByServerId: nextMachineIdByServerId,
                    lastTokenSubByServerId: nextLastSubByServerId,
                    machineIdConfirmedByServerByServerId: nextConfirmed,
                    // derived (not persisted in v5+)
                    machineId,
                };
            }

            if (!hadLastSub && !hadConfirmed) {
                return {
                    ...s,
                    machineId: current,
                };
            }

            return {
                ...s,
                lastTokenSubByServerId: nextLastSubByServerId,
                machineIdConfirmedByServerByServerId: nextConfirmed,
                // derived (not persisted in v5+)
                machineId: current,
            };
        }

        const previousAccountId = typeof nextLastSubByServerId[activeServerId] === 'string'
            ? String(nextLastSubByServerId[activeServerId]).trim()
            : '';

        const nextMachineIdByServerIdByAccountId = { ...(s.machineIdByServerIdByAccountId ?? {}) };
        const currentPerAccount = { ...(nextMachineIdByServerIdByAccountId[activeServerId] ?? {}) };
        const perAccountMachineId = typeof currentPerAccount[accountId] === 'string' ? String(currentPerAccount[accountId]).trim() : '';

        const didAccountSwap = Boolean(previousAccountId && previousAccountId !== accountId);

        let machineId: string | null = null;
        if (!forceNew && perAccountMachineId) {
            machineId = perAccountMachineId;
        } else if (!forceNew && !didAccountSwap && prevMachineIdForServer && typeof prevMachineIdForServer === 'string' && prevMachineIdForServer.trim()) {
            // Backfill mapping for older CLIs that only stored machineIdByServerId.
            machineId = prevMachineIdForServer.trim();
        }

        if (!machineId) {
            machineId = randomUUID();
        }

        const normalizedPrevMachineId = typeof prevMachineIdForServer === 'string' && prevMachineIdForServer.trim()
            ? prevMachineIdForServer.trim()
            : null;
        const needsServerMachineIdUpdate = normalizedPrevMachineId !== machineId;
        const needsLastSubUpdate = previousAccountId !== accountId;
        const needsPerAccountUpdate = perAccountMachineId !== machineId;

        const needsConfirmedUpdate = (needsServerMachineIdUpdate || needsLastSubUpdate) && activeServerId in nextConfirmed;

        if (!needsServerMachineIdUpdate && !needsLastSubUpdate && !needsPerAccountUpdate && !needsConfirmedUpdate) {
            return s;
        }

        nextMachineIdByServerId[activeServerId] = machineId;
        nextLastSubByServerId[activeServerId] = accountId;
        currentPerAccount[accountId] = machineId;
        nextMachineIdByServerIdByAccountId[activeServerId] = currentPerAccount;

        if (needsConfirmedUpdate) delete nextConfirmed[activeServerId];

        return {
            ...s,
            machineIdByServerId: nextMachineIdByServerId,
            lastTokenSubByServerId: nextLastSubByServerId,
            machineIdByServerIdByAccountId: nextMachineIdByServerIdByAccountId,
            machineIdConfirmedByServerByServerId: nextConfirmed,
            // derived (not persisted in v5+)
            machineId,
        };
    });

    if (!settings.machineId) throw new Error('Failed to ensure machine id in settings');
    return { machineId: settings.machineId };
}

export async function ensureMachineIdForCredentials(
    credentials: StoredCredentials,
    opts?: { forceNew?: boolean },
): Promise<{ machineId: string }> {
    const accountId = readAccountIdFromToken(credentials.token);

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


type AuthAndMachineSetupOptions = Readonly<{
    callerIntent?: AuthCallerIntent;
    requireAccountMaterial?: boolean;
    signal?: AbortSignal;
}>;

type MachineRegistrationMode = 'immediate' | 'deferred-to-daemon-runtime';

async function authAndPrepareMachineIfNeeded(
    opts: AuthAndMachineSetupOptions,
    machineRegistrationMode: MachineRegistrationMode,
): Promise<{
    credentials: StoredCredentials;
    machineId: string;
}> {
    opts.signal?.throwIfAborted();
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials: StoredCredentials | null = await readStoredCredentials();
    let machineSetup: Readonly<{ machineId: string }> | null = null;
    let accountMaterialRecoveryRequired = false;

    if (credentials && opts.requireAccountMaterial === true) {
        const authenticatedCredentials = credentials;
        const target = await resolveCurrentCliHomeTarget();
        const acquired = target.descriptor
            ? await acquireTerminalAuthEnrollmentRuntime(target.descriptor, target.preferredTransport, opts.signal)
            : null;
        if (acquired && !acquired.ok) {
            throw new Error('Unable to reach the selected Home through an authenticated enrollment carrier');
        }
        try {
            const runtimeOrigin = acquired?.runtime.runtimeOrigin ?? resolveServerHttpBaseUrl();
            if (acquired) {
                const snapshot = await fetchServerFeaturesSnapshot({
                    serverUrl: runtimeOrigin,
                    token: authenticatedCredentials.token,
                    ...(opts.signal ? { signal: opts.signal } : {}),
                });
                verifyTerminalAuthEnrollmentRuntime({ target, runtime: acquired.runtime, snapshot });
            }
            const mode = await readAccountEncryptionModeOnce({
                request: async () => {
                    const response = await fetch(`${runtimeOrigin.replace(/\/+$/u, '')}/v1/account/encryption`, {
                        headers: { Authorization: `Bearer ${authenticatedCredentials.token}` },
                        ...(opts.signal ? { signal: opts.signal } : {}),
                    });
                    return { status: response.status, data: await response.json().catch(() => null) };
                },
            });
            if (mode.kind !== 'resolved') {
                throw new Error('Selected Home encryption mode is unavailable');
            }
            accountMaterialRecoveryRequired = mode.mode === 'e2ee'
                && !hasUsableAccountSettingsEncryptionMaterial(authenticatedCredentials);
        } finally {
            if (acquired) await acquired.close();
        }
    }

    if (!credentials || accountMaterialRecoveryRequired) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const retainedCredentialForMaterialRecovery = credentials && opts.requireAccountMaterial === true
            ? credentials
            : null;
        const authResult = await doAuth({
            callerIntent: opts.callerIntent,
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(retainedCredentialForMaterialRecovery ? { retainedCredentialForMaterialRecovery } : {}),
            onAuthenticated: async ({ credentials: issuedCredentials, runtime }) => {
                machineSetup = machineRegistrationMode === 'immediate'
                    ? await registerMachineWithAuthenticatedHomeRuntime({
                        credentials: issuedCredentials,
                        forceNew: true,
                        runtimeOrigin: runtime.runtimeOrigin,
                    })
                    : await ensureMachineIdForCredentials(issuedCredentials, { forceNew: true });
            },
        });
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
    } else {
        logger.debug('[AUTH] Using existing credentials');
        const authenticatedCredentials = credentials;
        if (machineRegistrationMode === 'deferred-to-daemon-runtime') {
            machineSetup = await ensureMachineIdForCredentials(authenticatedCredentials);
        } else {
            const target = await resolveCurrentCliHomeTarget().catch(() => null);
            if (target?.descriptor) {
                const acquired = await acquireTerminalAuthEnrollmentRuntime(
                    target.descriptor,
                    target.preferredTransport,
                    opts.signal,
                );
                if (!acquired.ok) {
                    throw new Error('Unable to reach the selected Home through an authenticated enrollment carrier');
                }
                try {
                    const snapshot = await fetchServerFeaturesSnapshot({
                        serverUrl: acquired.runtime.runtimeOrigin,
                        token: authenticatedCredentials.token,
                        ...(opts.signal ? { signal: opts.signal } : {}),
                    });
                    verifyTerminalAuthEnrollmentRuntime({
                        target,
                        runtime: acquired.runtime,
                        snapshot,
                    });
                    machineSetup = await registerMachineWithAuthenticatedHomeRuntime({
                        credentials: authenticatedCredentials,
                        runtimeOrigin: acquired.runtime.runtimeOrigin,
                    });
                } finally {
                    await acquired.close();
                }
            } else {
                machineSetup = await registerMachineWithAuthenticatedHomeRuntime({
                    credentials: authenticatedCredentials,
                    runtimeOrigin: resolveServerHttpBaseUrl(),
                });
            }
        }
    }

    if (!machineSetup) {
        throw new Error(
            machineRegistrationMode === 'immediate'
                ? 'Machine registration did not complete'
                : 'Machine identity preparation did not complete',
        );
    }

    if (machineRegistrationMode === 'deferred-to-daemon-runtime') {
        rehydrateRelayScopeEnvFromConfiguration();
    }

    if (
      machineRegistrationMode === 'immediate'
      &&
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

    return { credentials, machineId: machineSetup.machineId };
}

/**
 * Ensure terminal authentication and synchronous machine registration.
 * This replaces the onboarding flow and ensures everything is ready.
 */
export async function authAndSetupMachineIfNeeded(opts: AuthAndMachineSetupOptions = {}): Promise<{
    credentials: StoredCredentials;
    machineId: string;
}> {
    return await authAndPrepareMachineIfNeeded(opts, 'immediate');
}

/**
 * Prepare local daemon identity without registering it over the network.
 * Daemon registration and retry ownership begins after bootstrap state is published.
 */
export async function authAndPrepareDaemonMachineIfNeeded(): Promise<{
    credentials: StoredCredentials;
    machineId: string;
}> {
    return await authAndPrepareMachineIfNeeded({}, 'deferred-to-daemon-runtime');
}

export async function registerMachineWithAuthenticatedHomeRuntime(input: Readonly<{
    credentials: StoredCredentials;
    forceNew?: boolean;
    runtimeOrigin: string;
}>): Promise<Readonly<{ machineId: string }>> {
    return await runWithServerHttpBaseUrl(input.runtimeOrigin, async () => {
        const { machineId } = await ensureMachineIdForCredentials(input.credentials, {
            forceNew: input.forceNew,
        });
        logger.debug(`[AUTH] Machine ID: ${machineId}`);
        rehydrateRelayScopeEnvFromConfiguration();
        const api = await ApiClient.create(input.credentials);
        const registration = await ensureMachineRegistered({
            api,
            machineId,
            metadata: initialMachineMetadata,
            caller: 'auth.login',
        });
        return { machineId: registration.machineId };
    });
}
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
