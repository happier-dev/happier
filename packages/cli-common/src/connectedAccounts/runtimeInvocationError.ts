export class ConnectedAccountAuthenticationModeUnavailableError extends Error {
    readonly code = 'connected_account_authentication_mode_unavailable';

    constructor() {
        super('The selected runtime does not implement this authentication mode');
        this.name = 'ConnectedAccountAuthenticationModeUnavailableError';
    }
}

export class ConnectedAccountRuntimeInvocationNotStartedError extends Error {
    readonly code = 'connected_account_runtime_generation_changed';

    constructor() {
        super(
            'Connected-account runtime occurrence is no longer current before provider entry',
        );
        this.name = 'ConnectedAccountRuntimeInvocationNotStartedError';
    }
}
