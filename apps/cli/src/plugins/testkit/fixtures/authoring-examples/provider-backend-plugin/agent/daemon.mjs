export async function launch() {
    return {
        sessionId: 'examples-provider-session',
        runtime: {
            beginTurnLifecycle() {},
            async startOrLoadSession() {},
            async sendTurnPrompt() {},
            async steerInFlightTurn() {},
            async waitForTurnCompletion() {},
            subscribeRuntimeEvents() {
                return () => {};
            },
            async respondToPermission() {},
            async cancelTurn() {},
            readSessionIdentity() {
                return { sessionId: 'examples-provider-session' };
            },
            async updateSessionRuntimeConfig() {},
            async resetOrDisposeRuntime() {}
        },
	        runtimeDescriptor: {
	            backendId: 'examples.provider.backend',
	            runtimeKind: 'native',
	        },
	        runtimeCapabilities: {
	            executionRun: { supported: false },
	            sessions: { supported: true }
        }
    };
}

export async function discoverIdentity() {
    return {
        backendId: 'examples.provider.backend',
        identity: 'examples-provider'
    };
}
