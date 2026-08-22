import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import type { HappierService } from '@happier-dev/cli-common/happierRuntime';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import type { CliAuthState } from '@/capabilities/cliAuth/types';
import { configuration } from '@/configuration';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveDaemonServiceCliRuntimeFromEnv, type DaemonServiceListEntry } from '@/daemon/service/cli';
import { resolveInstalledDaemonServiceInventoryForCurrentRelay } from '@/daemon/ownership/daemonServiceInventory';

import { promptInput, runCliAction } from './server/commandUtilities';

type BackgroundServiceFollowUpMode = 'user' | 'system';
type ServerChangeCredentialState = 'authenticated' | 'authentication-required' | 'unknown';

type BackgroundServiceInventoryEntry = HappierService | DaemonServiceListEntry;

/**
 * Child relay-selection commands set this only while `happier setup` owns the
 * larger relay → auth → service sequence. Reconciliation still has one owner
 * here; the child merely defers it until setup reaches the service step.
 */
export const DEFER_SERVER_SELECTION_FOLLOW_UP_ENV = 'HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP';

function shouldDeferServerSelectionFollowUp(): boolean {
    const raw = String(process.env[DEFER_SERVER_SELECTION_FOLLOW_UP_ENV] ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function isInstalledDefaultFollowingDaemonService(service: BackgroundServiceInventoryEntry): boolean {
    if ('serviceType' in service) {
        return (
            service.serviceType === 'daemon'
            && service.verification === 'verified'
            && (service.targetMode ?? 'pinned') === 'default-following'
            && service.installed
        );
    }
    return service.targetMode === 'default-following' && service.installed;
}

function resolveBackgroundServiceMode(service: BackgroundServiceInventoryEntry): BackgroundServiceFollowUpMode {
    if ('scope' in service) {
        return service.scope === 'system' ? 'system' : 'user';
    }
    if ('mode' in service && service.mode != null) {
        return service.mode === 'system' ? 'system' : 'user';
    }
    return String(service.path ?? '').includes('/etc/systemd/system/') ? 'system' : 'user';
}

async function readServerChangeCredentialState(
    credentials: StoredCredentials | null,
    targetServerUrl: string,
): Promise<ServerChangeCredentialState> {
    if (!credentials) {
        return 'authentication-required';
    }

    try {
        const response = await axios.get(`${resolveLoopbackHttpUrl(targetServerUrl).replace(/\/+$/, '')}/v1/account/profile`, {
            headers: {
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                Authorization: `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 5_000,
        });
        void response;
        return 'authenticated';
    } catch (error) {
        return isAuthenticationError(error) ? 'authentication-required' : 'unknown';
    }
}

async function resolveServerChangeCredentialState(params: Readonly<{
    authState: CliAuthState;
    targetServerUrl: string;
}>): Promise<ServerChangeCredentialState> {
    if (params.authState === 'logged_out') {
        return 'authentication-required';
    }

    const credentials = await readStoredCredentials().catch(() => null);
    return readServerChangeCredentialState(credentials, params.targetServerUrl);
}

export function resolveInstalledDefaultFollowingDaemonServiceModes(
    services: readonly BackgroundServiceInventoryEntry[],
): readonly BackgroundServiceFollowUpMode[] {
    const modes = new Set<BackgroundServiceFollowUpMode>();

    for (const service of services) {
        if (!isInstalledDefaultFollowingDaemonService(service)) {
            continue;
        }
        modes.add(resolveBackgroundServiceMode(service));
    }

    return [...modes].sort((left, right) => {
        if (left === right) {
            return 0;
        }
        return left === 'system' ? -1 : 1;
    });
}

function resolveRestartModes(
    modes: readonly BackgroundServiceFollowUpMode[] | undefined,
): readonly BackgroundServiceFollowUpMode[] {
    return modes != null && modes.length > 0 ? modes : ['user'];
}

function resolveRestartArgs(mode: BackgroundServiceFollowUpMode): string[] {
    return mode === 'system'
        ? ['service', 'restart', '--mode', 'system']
        : ['service', 'restart'];
}

function renderRestartCommand(mode: BackgroundServiceFollowUpMode): string {
    return mode === 'system'
        ? '  happier service restart --mode system'
        : '  happier service restart';
}

function hasDuplicateDefaultFollowingModes(
    modes: readonly BackgroundServiceFollowUpMode[] | undefined,
): boolean {
    return (modes?.length ?? 0) > 1;
}

function hasMissingHomeMetadataDefaultFollowingService(services: readonly BackgroundServiceInventoryEntry[]): boolean {
    return services.some((service) =>
        isInstalledDefaultFollowingDaemonService(service)
        && !service.happierHomeDir
        && String(('ring' in service ? service.ring : service.releaseChannel) ?? '').trim() !== String(configuration.publicReleaseRing ?? '').trim(),
    );
}

function renderRepairGuidance(params: Readonly<{ modes?: readonly BackgroundServiceFollowUpMode[] }>): readonly string[] {
    const requiresSudo = params.modes?.includes('system') ?? false;
    return [
        'Multiple default-following background services are installed. Repair them before restarting a background service for this change:',
        requiresSudo ? '  sudo happier service repair --yes' : '  happier service repair --yes',
    ];
}

function renderMissingHomeRepairGuidance(params: Readonly<{ modes?: readonly BackgroundServiceFollowUpMode[] }>): readonly string[] {
    const requiresSudo = params.modes?.includes('system') ?? false;
    return [
        'Detected default-following background services with missing Happier home metadata. Automatic restart guidance will not replace or remove them; remove the legacy service(s) from the owning installation first:',
        requiresSudo ? '  sudo happier service repair --yes' : '  happier service repair --yes',
    ];
}

async function restartDefaultFollowingBackgroundServices(params: Readonly<{
    modes?: readonly BackgroundServiceFollowUpMode[];
    runCliAction: (args: string[]) => Promise<void>;
}>): Promise<void> {
    for (const mode of resolveRestartModes(params.modes)) {
        await params.runCliAction(resolveRestartArgs(mode));
    }
}

export async function promptForDefaultFollowingBackgroundServiceRestart(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    subject: string;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): Promise<boolean> {
    if (!params.interactive) {
        return false;
    }

    const answer = String(
        await params.promptInput(`Restart the background service so it now follows ${params.subject}? [Y/n]: `),
    ).trim().toLowerCase();
    const shouldRestart = answer === '' || answer === 'y' || answer === 'yes';
    if (!shouldRestart) {
        return false;
    }

    await restartDefaultFollowingBackgroundServices({
        modes: params.modes,
        runCliAction: params.runCliAction,
    });
    return true;
}

export async function promptToAuthenticateForServerChange(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    targetServerUrl: string;
    needsAuthentication: boolean;
}>): Promise<'not-needed' | 'authenticated' | 'declined'> {
    if (!params.needsAuthentication) {
        return 'not-needed';
    }
    if (!params.interactive) {
        return 'declined';
    }

    const answer = String(
        await params.promptInput(`Authenticate Happier against ${params.targetServerUrl} now? [Y/n]: `),
    ).trim().toLowerCase();
    const shouldAuthenticate = answer === '' || answer === 'y' || answer === 'yes';
    if (!shouldAuthenticate) {
        return 'declined';
    }

    await params.runCliAction(['auth', 'login']);
    return 'authenticated';
}

function renderManualRestartFollowUp(params: Readonly<{
    subject: string;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): readonly string[] {
    return [
        `Restart the background service so it now follows ${params.subject}:`,
        ...resolveRestartModes(params.modes).map(renderRestartCommand),
    ];
}

function renderManualServerChangeFollowUp(params: Readonly<{
    targetServerUrl: string;
    credentialState: ServerChangeCredentialState;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): readonly string[] {
    if (params.credentialState !== 'authentication-required') {
        return renderManualRestartFollowUp({
            subject: params.targetServerUrl,
            modes: params.modes,
        });
    }

    return [
        `Authenticate Happier against ${params.targetServerUrl} and then restart the background service so it follows that server:`,
        '  happier auth login',
        ...resolveRestartModes(params.modes).map(renderRestartCommand),
    ];
}

export async function runDefaultFollowingBackgroundServiceRestartFollowUp(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    subject: string;
    log: (message: string) => void;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): Promise<boolean> {
    if (hasDuplicateDefaultFollowingModes(params.modes)) {
        for (const line of renderRepairGuidance({ modes: params.modes })) {
            params.log(line);
        }
        return false;
    }

    if (!params.interactive) {
        for (const line of renderManualRestartFollowUp({
            subject: params.subject,
            modes: params.modes,
        })) {
            params.log(line);
        }
        return false;
    }

    try {
        return await promptForDefaultFollowingBackgroundServiceRestart(params);
    } catch {
        params.log('Background service follow-up failed after the primary change was already applied.');
        for (const line of renderManualRestartFollowUp({
            subject: params.subject,
            modes: params.modes,
        })) {
            params.log(line);
        }
        return false;
    }
}

export async function runDefaultFollowingBackgroundServiceServerChangeFollowUp(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    targetServerUrl: string;
    authState: CliAuthState;
    log: (message: string) => void;
    services: readonly DaemonServiceListEntry[];
}>): Promise<void> {
    const modes = resolveInstalledDefaultFollowingDaemonServiceModes(params.services);
    if (modes.length === 0) {
        return;
    }

    if (hasMissingHomeMetadataDefaultFollowingService(params.services)) {
        for (const line of renderMissingHomeRepairGuidance({ modes })) {
            params.log(line);
        }
        return;
    }

    if (hasDuplicateDefaultFollowingModes(modes)) {
        for (const line of renderRepairGuidance({ modes })) {
            params.log(line);
        }
        return;
    }

    let credentialState: ServerChangeCredentialState = await resolveServerChangeCredentialState({
        authState: params.authState,
        targetServerUrl: params.targetServerUrl,
    });

    if (!params.interactive) {
        for (const line of renderManualServerChangeFollowUp({
            targetServerUrl: params.targetServerUrl,
            credentialState,
            modes,
        })) {
            params.log(line);
        }
        return;
    }

    try {
        const authOutcome = await promptToAuthenticateForServerChange({
            ...params,
            needsAuthentication: credentialState !== 'authenticated',
        });
        if (authOutcome === 'declined') {
            params.log(`Background service was not restarted because ${params.targetServerUrl} is not authenticated yet.`);
            for (const line of renderManualServerChangeFollowUp({
                targetServerUrl: params.targetServerUrl,
                credentialState: 'authentication-required',
                modes,
            })) {
                params.log(line);
            }
            return;
        }

        if (authOutcome === 'authenticated') {
            credentialState = 'authenticated';
        }

        await promptForDefaultFollowingBackgroundServiceRestart({
            interactive: params.interactive,
            promptInput: params.promptInput,
            runCliAction: params.runCliAction,
            subject: params.targetServerUrl,
            modes,
        });
    } catch {
        params.log('Background service follow-up failed after the primary change was already applied.');
        for (const line of renderManualServerChangeFollowUp({
            targetServerUrl: params.targetServerUrl,
            credentialState,
            modes,
        })) {
            params.log(line);
        }
    }
}

/**
 * Canonical reconciliation for "the active relay just changed".
 *
 * A default-following background service resolves the active relay once, at
 * start. Every command that switches the active relay has to come back through
 * here, or the daemon keeps talking to the relay it was started against while
 * the CLI reports success against the new one.
 */
export async function runServerSelectionBackgroundServiceFollowUp(params: Readonly<{
    interactive: boolean;
    targetServerUrl: string;
}>): Promise<void> {
    if (shouldDeferServerSelectionFollowUp()) {
        return;
    }

    const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
    const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);
    if (resolveInstalledDefaultFollowingDaemonServiceModes(services).length === 0) {
        return;
    }

    const credentials = await readStoredCredentials().catch(() => null);
    await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
        interactive: params.interactive,
        promptInput,
        runCliAction,
        targetServerUrl: params.targetServerUrl,
        authState: credentials ? 'logged_in' : 'logged_out',
        log: console.log,
        services,
    });
}
