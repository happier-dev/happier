export default async function resolveTranscriptBinding() {
    return 'integration-bound';
}

export { resolveTranscriptBinding };

function createRuntimeTurnOperations() {
    let handler = null;
    let sessionId = null;

    return {
        beginTurnLifecycle() {},
        async startOrLoadSession(opts) {
            sessionId = opts?.resumeId ?? 'integration-session';
        },
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
    return { ok: true, source: 'codex' };
}

export async function listCandidates() {
    return { candidates: [], nextCursor: null };
}

export async function getActivity() {
    return { lastActivityAtMs: null, isRunning: false };
}

export async function pageTranscript() {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false };
}

export async function readAfterTranscript() {
    return { items: [], nextCursor: null, truncated: false };
}

export async function resolveTakeoverSpawnOptions() {
    return null;
}

export async function evaluateAvailability() {
    return { eligible: true, scope: 'local', metadata: { source: 'integration' } };
}

export async function attach() {
    return 0;
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
