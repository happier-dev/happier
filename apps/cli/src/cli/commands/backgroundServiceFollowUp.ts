import type { HappierService } from '@happier-dev/cli-common/happierRuntime';

export function hasInstalledDefaultFollowingDaemonService(services: readonly HappierService[]): boolean {
    return services.some((service) => (
        service.serviceType === 'daemon'
        && service.verification === 'verified'
        && (service.targetMode ?? 'pinned') === 'default-following'
        && service.installed
    ));
}

export async function promptForDefaultFollowingBackgroundServiceRestart(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    subject: string;
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

    await params.runCliAction(['service', 'restart']);
    return true;
}

export async function promptToAuthenticateForServerChange(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    targetServerUrl: string;
    hasCredentials: boolean;
}>): Promise<'not-needed' | 'authenticated' | 'declined'> {
    if (params.hasCredentials) {
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

function renderManualRestartFollowUp(subject: string): readonly string[] {
    return [
        `Restart the background service so it now follows ${subject}:`,
        '  happier service restart',
    ];
}

function renderManualServerChangeFollowUp(targetServerUrl: string, hasCredentials: boolean): readonly string[] {
    if (hasCredentials) {
        return renderManualRestartFollowUp(targetServerUrl);
    }

    return [
        `Authenticate Happier against ${targetServerUrl} and then restart the background service so it follows that server:`,
        '  happier auth login',
        '  happier service restart',
    ];
}

export async function runDefaultFollowingBackgroundServiceRestartFollowUp(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    subject: string;
    log: (message: string) => void;
}>): Promise<boolean> {
    if (!params.interactive) {
        for (const line of renderManualRestartFollowUp(params.subject)) {
            params.log(line);
        }
        return false;
    }

    return promptForDefaultFollowingBackgroundServiceRestart(params);
}

export async function runDefaultFollowingBackgroundServiceServerChangeFollowUp(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    targetServerUrl: string;
    hasCredentials: boolean;
    log: (message: string) => void;
}>): Promise<void> {
    if (!params.interactive) {
        for (const line of renderManualServerChangeFollowUp(params.targetServerUrl, params.hasCredentials)) {
            params.log(line);
        }
        return;
    }

    const authOutcome = await promptToAuthenticateForServerChange(params);
    if (authOutcome === 'declined') {
        params.log(`Background service was not restarted because ${params.targetServerUrl} is not authenticated yet.`);
        for (const line of renderManualServerChangeFollowUp(params.targetServerUrl, false)) {
            params.log(line);
        }
        return;
    }

    await promptForDefaultFollowingBackgroundServiceRestart({
        interactive: params.interactive,
        promptInput: params.promptInput,
        runCliAction: params.runCliAction,
        subject: params.targetServerUrl,
    });
}
