import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import type { HappierService } from '@happier-dev/cli-common/happierRuntime';
import { selectServingDaemonService } from '@happier-dev/cli-common/systemTasks';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import type { CliAuthState } from '@/capabilities/cliAuth/types';
import { configuration } from '@/configuration';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveDaemonServiceCliRuntimeFromEnv, type DaemonServiceListEntry } from '@/daemon/service/cli';
import {
    resolveInstalledDaemonServiceInventoryForCurrentRelay,
} from '@/daemon/ownership/daemonServiceInventory';

import { promptInput, runCliAction } from './server/commandUtilities';

type BackgroundServiceFollowUpMode = 'user' | 'system';
type ServerChangeCredentialState = 'authenticated' | 'authentication-required' | 'unknown';

export type ServerSelectionMutationMode = 'standalone' | 'mutation-only';

type BackgroundServiceInventoryEntry = HappierService | DaemonServiceListEntry;

function isInstalledDefaultFollowingDaemonService(service: BackgroundServiceInventoryEntry): boolean {
    return (!('serviceType' in service) || service.serviceType === 'daemon')
        && service.verification === 'verified'
        && service.targetMode === 'default-following'
        && service.installed;
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

function restartCommand(mode: BackgroundServiceFollowUpMode): string {
    return mode === 'system'
        ? 'happier service restart --mode system'
        : 'happier service restart';
}

function renderRestartCommand(mode: BackgroundServiceFollowUpMode): string {
    return `  ${restartCommand(mode)}`;
}

function repairCommand(modes: readonly BackgroundServiceFollowUpMode[] | undefined): string {
    return modes?.includes('system') ? 'sudo happier service repair --yes' : 'happier service repair --yes';
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
    return [
        'Multiple default-following background services are installed. Repair them before restarting a background service for this change:',
        `  ${repairCommand(params.modes)}`,
    ];
}

function renderMissingHomeRepairGuidance(params: Readonly<{ modes?: readonly BackgroundServiceFollowUpMode[] }>): readonly string[] {
    return [
        'Detected default-following background services with missing Happier home metadata. Automatic restart guidance will not replace or remove them; remove the legacy service(s) from the owning installation first:',
        `  ${repairCommand(params.modes)}`,
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
    /** Replaces the default "so it now follows <subject>" question. */
    question?: string;
}>): Promise<boolean> {
    if (!params.interactive) {
        return false;
    }

    const answer = String(
        await params.promptInput(`${params.question ?? `Restart the background service so it now follows ${params.subject}?`} [Y/n]: `),
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

/**
 * The selected relay already has this home's own pinned background service: it serves that relay,
 * and the default-following service stands by rather than compete for the per-server lock (its
 * daemon startup yields — `evaluateDefaultFollowingServiceStartup`). Restarting the default one is
 * then only how it stops serving the relay the terminal left; it never follows the new one.
 */
const STAND_BY_RESTART = 'Restart the default background service so it stops serving the relay you left';

function renderStandingByFollowUp(params: Readonly<{
    targetServerUrl: string;
    pinnedServices: readonly DaemonServiceListEntry[];
}>): readonly string[] {
    return [
        `${params.targetServerUrl} has its own background service, so the default background service stands by:`,
        ...params.pinnedServices.map((service) => `  ${service.label} (${service.releaseChannel}, pinned)`),
        'To keep the default background service on another relay, select that relay again:',
        '  happier server use <relay>',
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
    /** This home's installed pin selected for the target relay by the shared selector. */
    pinnedServices?: readonly DaemonServiceListEntry[];
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

    const pinnedServices = params.pinnedServices ?? [];
    if (pinnedServices.length > 0) {
        for (const line of renderStandingByFollowUp({ targetServerUrl: params.targetServerUrl, pinnedServices })) {
            params.log(line);
        }
        const manualRestart = [`${STAND_BY_RESTART}:`, ...modes.map(renderRestartCommand)];
        if (!params.interactive) {
            for (const line of manualRestart) params.log(line);
            return;
        }
        try {
            await promptForDefaultFollowingBackgroundServiceRestart({
                interactive: params.interactive,
                promptInput: params.promptInput,
                runCliAction: params.runCliAction,
                subject: params.targetServerUrl,
                modes,
                question: `${STAND_BY_RESTART}?`,
            });
        } catch {
            params.log('Background service follow-up failed after the primary change was already applied.');
            for (const line of manualRestart) params.log(line);
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

/** The installed services of the relay the terminal now selects, and this home's pinned ones among them. */
async function readSelectedRelayServices(): Promise<Readonly<{
    services: readonly DaemonServiceListEntry[];
    pinnedServices: readonly DaemonServiceListEntry[];
}>> {
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
    const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);
    const serving = selectServingDaemonService(services);
    return {
        services,
        pinnedServices: serving?.targetMode === 'pinned' ? [serving] : [],
    };
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
    const { services, pinnedServices } = await readSelectedRelayServices();
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
        pinnedServices,
    });
}

/** The server-selection follow-up for a caller that cannot be prompted (`--json`). */
export type ServerSelectionBackgroundServiceFollowUp = Readonly<{
    /** This home's pinned service that serves the selected relay; the default one stands by. */
    servedByPinnedService: string | null;
    /** What brings the default-following service in line with the selection. */
    commands: readonly string[];
}>;

/**
 * The same decision as the interactive follow-up, as data: `null` when no default-following
 * service is installed. Nothing is restarted and no credential is probed.
 */
export async function readServerSelectionBackgroundServiceFollowUp(): Promise<ServerSelectionBackgroundServiceFollowUp | null> {
    const { services, pinnedServices } = await readSelectedRelayServices();
    const modes = resolveInstalledDefaultFollowingDaemonServiceModes(services);
    if (modes.length === 0) {
        return null;
    }
    const servedByPinnedService = pinnedServices[0]?.label ?? null;
    if (hasMissingHomeMetadataDefaultFollowingService(services) || hasDuplicateDefaultFollowingModes(modes)) {
        return { servedByPinnedService, commands: [repairCommand(modes)] };
    }
    return { servedByPinnedService, commands: modes.map(restartCommand) };
}

/**
 * Completes a server-selection mutation according to the caller's explicit
 * orchestration role. Standalone server/relay commands reconcile immediately;
 * guided setup selects `mutation-only`, authenticates once itself, and then
 * reaches the existing service setup owner once.
 */
export async function completeServerSelectionMutation(params: Readonly<{
    mode: ServerSelectionMutationMode;
    interactive: boolean;
    targetServerUrl: string;
}>): Promise<void> {
    if (params.mode === 'mutation-only') {
        return;
    }
    await runServerSelectionBackgroundServiceFollowUp({
        interactive: params.interactive,
        targetServerUrl: params.targetServerUrl,
    });
}
