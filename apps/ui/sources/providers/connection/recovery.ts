import { ProviderErrorV1Schema, type ProviderErrorV1 } from '@happier-dev/protocol';

type RecoveryRouter = Readonly<{ push: (href: string) => void }>;

export type ProviderRecoveryAvailability = Readonly<{
    retry?: boolean;
    loadModel?: boolean;
    reviewAndRestart?: boolean;
    reviewConnection?: boolean;
    reviewCurrentState?: boolean;
    configureSecret?: boolean;
    enableOnMachine?: boolean;
}>;

export function providerErrorRequestsRetry(error: ProviderErrorV1): boolean {
    return error.action === 'retry';
}

export function providerRetryRecoveryForError<TCallback>(
    error: ProviderErrorV1,
    retry: TCallback,
): Readonly<{ retry?: TCallback }> {
    return providerErrorRequestsRetry(error) ? { retry } : {};
}

export function providerModelLoadRecoveryForError<TCallback>(
    error: ProviderErrorV1,
    loadModel: TCallback,
): Readonly<{ retry?: TCallback; loadModel?: TCallback }> {
    if (providerErrorRequestsRetry(error)) return { retry: loadModel };
    if (error.action === 'load_model') return { loadModel };
    return {};
}

export function canDispatchProviderRecoveryAction(
    error: ProviderErrorV1,
    availability: ProviderRecoveryAvailability,
): boolean {
    switch (error.action) {
        case 'retry':
        case 'restart_probe':
            return availability.retry === true;
        case 'load_model':
            return availability.loadModel === true;
        case 'review_and_restart':
            return availability.reviewAndRestart === true;
        case 'review_profile_migration':
            return Boolean(error.sourceProfileId);
        case 'review_current_state':
            return availability.reviewCurrentState === true
                || Boolean(error.sourceProfileId)
                || Boolean(error.connectionId);
        case 'enable_connection':
        case 'review_account_grant':
        case 'review_machine_grant':
        case 'review_compatibility':
        case 'review_credential_transport':
        case 'choose_model':
            return Boolean(error.connectionId);
        case 'enable_on_machine':
            return availability.enableOnMachine === true || Boolean(error.connectionId);
        case 'review_connection':
            return availability.reviewConnection === true || Boolean(error.connectionId);
        case 'add_secret':
        case 'replace_secret':
            return availability.configureSecret === true || Boolean(error.connectionId);
        case 'choose_connection':
        case 'review_features':
        case 'restore_plugin':
        case 'reduce_provider_settings':
            return true;
    }
}

export async function dispatchProviderRecoveryAction(input: Readonly<{
    error: ProviderErrorV1;
    router: RecoveryRouter;
    retry?: () => void | Promise<void>;
    loadModel?: () => void | Promise<void>;
    reviewAndRestart?: () => void | Promise<void>;
    reviewConnection?: () => void | Promise<void>;
    reviewCurrentState?: () => void | Promise<void>;
    configureSecret?: () => void | Promise<void>;
    enableOnMachine?: () => void | Promise<void>;
}>): Promise<boolean> {
    const parsed = ProviderErrorV1Schema.safeParse(input.error);
    if (!parsed.success) return false;
    const error = parsed.data;
    if (!canDispatchProviderRecoveryAction(error, {
        retry: input.retry !== undefined,
        loadModel: input.loadModel !== undefined,
        reviewAndRestart: input.reviewAndRestart !== undefined,
        reviewConnection: input.reviewConnection !== undefined,
        reviewCurrentState: input.reviewCurrentState !== undefined,
        configureSecret: input.configureSecret !== undefined,
        enableOnMachine: input.enableOnMachine !== undefined,
    })) return false;
    const connectionPath = error.connectionId
        ? `/(app)/settings/providers/${encodeURIComponent(error.connectionId)}`
        : null;
    switch (error.action) {
        case 'retry':
        case 'restart_probe':
            if (!input.retry) return false;
            await input.retry();
            return true;
        case 'review_and_restart':
            if (!input.reviewAndRestart) return false;
            await input.reviewAndRestart();
            return true;
        case 'load_model':
            if (!input.loadModel) return false;
            await input.loadModel();
            return true;
        case 'choose_model':
            if (!connectionPath) return false;
            input.router.push(`${connectionPath}/models`);
            return true;
        case 'review_profile_migration':
            if (!error.sourceProfileId) return false;
            input.router.push('/(app)/settings/profiles');
            return true;
        case 'review_current_state':
            if (input.reviewCurrentState) {
                await input.reviewCurrentState();
            } else if (error.sourceProfileId) {
                input.router.push('/(app)/settings/profiles');
            } else if (connectionPath) {
                input.router.push(connectionPath);
            } else {
                return false;
            }
            return true;
        case 'choose_connection':
        case 'review_features':
        case 'restore_plugin':
        case 'reduce_provider_settings':
            input.router.push('/(app)/settings/providers');
            return true;
        case 'enable_connection':
        case 'review_account_grant':
        case 'review_machine_grant':
        case 'review_compatibility':
        case 'review_credential_transport':
            if (!connectionPath) return false;
            input.router.push(connectionPath);
            return true;
        case 'enable_on_machine':
            if (input.enableOnMachine) {
                await input.enableOnMachine();
                return true;
            }
            if (!connectionPath) return false;
            input.router.push(connectionPath);
            return true;
        case 'review_connection':
            if (input.reviewConnection) {
                await input.reviewConnection();
                return true;
            }
            if (!connectionPath) return false;
            input.router.push(connectionPath);
            return true;
        case 'replace_secret':
        case 'add_secret':
            if (input.configureSecret) {
                await input.configureSecret();
                return true;
            }
            if (!connectionPath) return false;
            input.router.push(connectionPath);
            return true;
    }
}
