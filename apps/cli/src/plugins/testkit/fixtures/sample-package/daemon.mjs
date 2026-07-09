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
    return { ok: true, value: { source: 'codex' } };
}

export async function listCandidates() {
    return { ok: true, value: { candidates: [], nextCursor: null } };
}

export async function getActivity() {
    return { ok: true, value: { lastActivityAtMs: null, isRunning: false } };
}

export async function pageTranscript() {
    return { ok: true, value: { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false } };
}

export async function readAfterTranscript() {
    return { ok: true, value: { items: [], nextCursor: null, truncated: false } };
}

export async function resolveTakeoverSpawnOptions() {
    return { ok: true, value: null };
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
