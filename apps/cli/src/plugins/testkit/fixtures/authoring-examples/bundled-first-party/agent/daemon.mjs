export async function launch() {
    return {
        sessionId: 'bundled-first-party-session',
        runtime: {
            beginTurnLifecycle() {},
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
    };
}

export async function discoverIdentity() {
    return {
        agentId: 'examples.bundled.backend',
        identity: 'bundled-first-party'
    };
}
