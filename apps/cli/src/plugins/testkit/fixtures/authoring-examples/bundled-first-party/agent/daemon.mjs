export async function launch() {
    return {
        sessionId: 'bundled-first-party-session',
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
                return { sessionId: 'bundled-first-party-session' };
            },
            async updateSessionRuntimeConfig() {},
            async resetOrDisposeRuntime() {}
        },
        runtimeDescriptor: {
            backendId: 'examples.bundled.backend',
            runtimeKind: 'native',
            source: 'first_party'
        },
        runtimeCapabilities: {
            executionRun: { supported: false },
            sessions: { supported: true }
        }
    };
}

export async function discoverIdentity() {
    return {
        backendId: 'examples.bundled.backend',
        identity: 'bundled-first-party'
    };
}
