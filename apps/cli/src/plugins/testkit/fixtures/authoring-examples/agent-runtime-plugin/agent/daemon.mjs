export async function launch() {
    return {
        sessionId: 'examples-agent-runtime-session',
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
                return { sessionId: 'examples-agent-runtime-session' };
            },
            async updateSessionRuntimeConfig() {},
            async resetOrDisposeRuntime() {}
        },
    };
}

export async function discoverIdentity() {
    return {
        agentId: 'examples.agent.runtime',
        identity: 'examples-agent-runtime'
    };
}
