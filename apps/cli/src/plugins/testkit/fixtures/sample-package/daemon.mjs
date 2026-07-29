export default async function resolveTranscriptBinding() {
    return 'integration-bound';
}

export { resolveTranscriptBinding };

export function activate(api) {
    api.agents.register('sample-provider', () => ({
        sessions: {
            async open(request) {
                let listener = null;
                return {
                    async send(input) {
                        listener?.({
                            kind: 'input-accepted',
                            turnId: input.delivery.turnId,
                        });
                        return { status: 'admitted' };
                    },
                    watch(nextListener) {
                        listener = nextListener;
                        return {
                            dispose() {
                                if (listener === nextListener) listener = null;
                            }
                        };
                    },
                    async dispose() {
                        listener = null;
                    },
                    sessionId: request.sessionId
                };
            }
        }
    }));
    api.hooks.register('resolve-prerequisites', resolveTranscriptBinding);
}

function createRuntimeTurnOperations() {
    let handler = null;
    let sessionId = null;

    return {
        beginTurnLifecycle() {},
        async sendTurnPrompt(prompt) {
            if (handler) {
                handler({ type: 'model-output', fullText: `integration:${prompt}` });
            }
        },
        async steerInFlightTurn(prompt) {
            if (handler) {
                handler({ type: 'model-output', fullText: `steer:${prompt}` });
            }
        },
        async waitForTurnCompletion() {},
        subscribeRuntimeEvents(nextHandler) {
            handler = nextHandler;
            return () => {
                if (handler === nextHandler) {
                    handler = null;
                }
            };
        },
        async respondToPermission() {},
        async cancelTurn() {},
        readSessionIdentity() {
            return { sessionId };
        },
        async updateSessionRuntimeConfig() {},
        async resetOrDisposeRuntime() {
            handler = null;
            sessionId = null;
        },
    };
}

export async function launch() {
    return {
        sessionId: 'integration-session',
	        runtime: createRuntimeTurnOperations(),
	        runtimeDescriptor: {
	            backendId: 'acme.sample.backend',
	            runtimeKind: 'native',
	            source: 'plugin',
	        },
	        runtimeCapabilities: {
	            executionRun: { supported: true },
	            sessions: { supported: true },
	        },
    };
}

export async function discoverIdentity() {
    return { backendId: 'acme.sample.backend', identity: 'integration-identity' };
}

export async function validateSource() {
    return { ok: true, value: { source: 'codex' } };
}

export async function listCandidates() {
    return { ok: true, value: { candidates: [], nextCursor: null } };
}

export async function pageTranscript() {
    return { ok: true, value: { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false } };
}

export async function readAfterTranscript() {
    return { ok: true, value: { outcome: 'already_current' } };
}

export async function evaluateAvailability() {
    return { available: true };
}

export async function attach() {
    return { ok: true, value: { exitCode: 0 } };
}

export async function exportBundle() {
    return { providerId: 'codex', remoteSessionId: 'remote-1', files: [] };
}

export async function importBundle() {
    return {
        remoteSessionId: 'remote-1',
        directSource: 'codex',
        resume: {
            directory: '/tmp/integration',
            agent: 'codex',
            resume: 'resume-1',
            transcriptStorage: 'direct',
            approvedNewDirectoryCreation: true,
        },
    };
}
