import type {
    AgentTranscriptFileFollowHandle,
    AgentTranscriptFileFollowService,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeRuntimeLogger } from '../../dependencies.js';

import { isSidechainSessionHook } from '../../../hooks/sidechain.js';

const DEFAULT_PROMPT_PROOF_WINDOW_MS = 30_000;

type PromptIntent = {
    text: string;
    submittedAtMs: number;
    acceptedAtMs: number | null;
    acceptedCandidate: ActiveTranscriptCandidate | null;
};

type TranscriptEvidence = Readonly<{
    text: string;
    timestampMs: number;
}>;

type ActiveTranscriptCandidate = {
    providerSessionId: string;
    transcriptPath: string;
    evidence: TranscriptEvidence[];
    invalidated: boolean;
    promoted: boolean;
    promotionInFlight: Promise<void> | null;
    followHandle: AgentTranscriptFileFollowHandle | null;
};

export type ClaudeAgentSdkResumeIdentityPromotion = Readonly<{
    providerSessionId: string;
    transcriptPath: string;
    isCurrent(): boolean;
}>;

export type ClaudeAgentSdkResumeIdentityOwner = Readonly<{
    recordSubmittedPrompt(prompt: string): void;
    settleCurrentCandidate(): Promise<void>;
    observeSessionHook(
        providerSessionId: string,
        payload: Readonly<Record<string, unknown>>,
    ): Promise<void>;
    validateSdkResultProviderSessionId(providerSessionId: unknown): ClaudeAgentSdkResumeIdentityMismatchError | null;
    readExplicitResumeFailure(): ClaudeAgentSdkResumeIdentityMismatchError | null;
    dispose(): Promise<void>;
}>;

export class ClaudeAgentSdkResumeIdentityMismatchError extends Error {
    readonly code = 'claude_agent_sdk_resume_identity_mismatch';
    readonly happierNativeResumeIdentityMismatch = true;

    constructor(
        readonly requestedProviderSessionId: string,
        readonly observedProviderSessionId: string | null,
        readonly observedSource: string | null,
    ) {
        super('Claude could not resume the requested provider session.');
        this.name = 'ClaudeAgentSdkResumeIdentityMismatchError';
    }
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readHookEventName(payload: Readonly<Record<string, unknown>>): string | null {
    return readString(payload.hook_event_name)
        ?? readString(payload.hookEventName)
        ?? readString(payload.eventName);
}

function readProviderSessionId(
    reportedProviderSessionId: string,
    payload: Readonly<Record<string, unknown>>,
): string | null {
    const values = [
        readString(reportedProviderSessionId),
        readString(payload.session_id),
        readString(payload.sessionId),
    ].filter((value): value is string => value !== null);
    if (values.length === 0 || new Set(values).size !== 1) return null;
    return values[0] ?? null;
}

function readTranscriptPath(payload: Readonly<Record<string, unknown>>): string | null {
    const snakeCase = readString(payload.transcript_path);
    const camelCase = readString(payload.transcriptPath);
    if (snakeCase && camelCase && snakeCase !== camelCase) return null;
    return snakeCase ?? camelCase;
}

function readRowTimestampMs(row: Readonly<Record<string, unknown>>): number | null {
    const timestamp = readString(row.timestamp);
    if (!timestamp) return null;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
}

function readUserPromptText(row: Readonly<Record<string, unknown>>): string | null {
    if (row.type !== 'user' || row.isSidechain === true || row.isMeta === true) return null;
    const message = row.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const content = (message as Readonly<Record<string, unknown>>).content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
        const record = block as Readonly<Record<string, unknown>>;
        if (record.type !== 'text' || typeof record.text !== 'string') return null;
        parts.push(record.text);
    }
    return parts.length > 0 ? parts.join('') : null;
}

function parseJsonRecord(line: string): Readonly<Record<string, unknown>> | null {
    try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Readonly<Record<string, unknown>>
            : null;
    } catch {
        return null;
    }
}

function isWithinPromptProofWindow(params: Readonly<{
    evidenceAtMs: number;
    acceptedAtMs: number;
    windowMs: number;
}>): boolean {
    return params.evidenceAtMs >= params.acceptedAtMs - params.windowMs
        && params.evidenceAtMs <= params.acceptedAtMs + params.windowMs;
}

export function createClaudeAgentSdkResumeIdentityOwner(params: Readonly<{
    ctx: Readonly<{
        logger: ClaudeRuntimeLogger;
        agentRuntime: Readonly<{
            transcripts: Readonly<{
                fileFollow: AgentTranscriptFileFollowService;
            }>;
        }>;
    }>;
    onProviderSessionId(providerSessionId: string): void;
    onTranscriptCandidateActivated?(candidate: Readonly<{
        providerSessionId: string;
        transcriptPath: string;
    }>): void;
    onTranscriptPromoted(promotion: ClaudeAgentSdkResumeIdentityPromotion): Promise<void>;
    expectedInitialProviderSessionId?: string | null;
    nowMs?: () => number;
    promptProofWindowMs?: number;
}>): ClaudeAgentSdkResumeIdentityOwner {
    const nowMs = params.nowMs ?? Date.now;
    const promptProofWindowMs = Math.max(
        100,
        Math.trunc(params.promptProofWindowMs ?? DEFAULT_PROMPT_PROOF_WINDOW_MS),
    );
    const promptIntents: PromptIntent[] = [];
    const retiredCandidateKeys = new Set<string>();
    const inFlightHookOperations = new Set<Promise<void>>();
    const promotionOperations = new Set<Promise<void>>();
    let activeCandidate: ActiveTranscriptCandidate | null = null;
    let lastPublishedProviderSessionId: string | null = null;
    let expectedInitialProviderSessionId = readString(params.expectedInitialProviderSessionId);
    let explicitResumeFailure: ClaudeAgentSdkResumeIdentityMismatchError | null = null;
    let disposed = false;
    let disposePromise: Promise<void> | null = null;

    function failExplicitResume(
        observedProviderSessionId: string | null,
        observedSource: string | null,
    ): ClaudeAgentSdkResumeIdentityMismatchError | null {
        if (explicitResumeFailure) return explicitResumeFailure;
        if (!expectedInitialProviderSessionId) return null;
        explicitResumeFailure = new ClaudeAgentSdkResumeIdentityMismatchError(
            expectedInitialProviderSessionId,
            observedProviderSessionId,
            observedSource,
        );
        return explicitResumeFailure;
    }

    function candidateKey(providerSessionId: string, transcriptPath: string): string {
        return `${providerSessionId}\u0000${transcriptPath}`;
    }

    function prunePromptIntents(referenceMs: number): void {
        for (let index = promptIntents.length - 1; index >= 0; index -= 1) {
            const intent = promptIntents[index];
            const anchorMs = intent?.acceptedAtMs ?? intent?.submittedAtMs ?? referenceMs;
            if (referenceMs - anchorMs > promptProofWindowMs) promptIntents.splice(index, 1);
        }
    }

    function findAcceptedIntent(
        candidate: ActiveTranscriptCandidate,
        evidence: TranscriptEvidence,
    ): PromptIntent | null {
        return promptIntents.find((intent) => (
            intent.acceptedAtMs !== null
            && intent.acceptedCandidate === candidate
            && intent.text === evidence.text
            && isWithinPromptProofWindow({
                evidenceAtMs: evidence.timestampMs,
                acceptedAtMs: intent.acceptedAtMs,
                windowMs: promptProofWindowMs,
            })
        )) ?? null;
    }

    async function maybePromote(candidate: ActiveTranscriptCandidate): Promise<void> {
        if (disposed || activeCandidate !== candidate || candidate.invalidated || candidate.promoted) return;
        if (candidate.promotionInFlight) return await candidate.promotionInFlight;
        const evidence = candidate.evidence.find((item) => findAcceptedIntent(candidate, item) !== null);
        if (!evidence) return;
        const acceptedIntent = findAcceptedIntent(candidate, evidence);
        if (!acceptedIntent) return;

        const promotion = (async () => {
            await params.onTranscriptPromoted({
                providerSessionId: candidate.providerSessionId,
                transcriptPath: candidate.transcriptPath,
                isCurrent: () => !disposed && activeCandidate === candidate && !candidate.invalidated,
            });
            if (activeCandidate !== candidate || candidate.invalidated) return;
            candidate.promoted = true;
            const intentIndex = promptIntents.indexOf(acceptedIntent);
            if (intentIndex >= 0) promptIntents.splice(intentIndex, 1);
            const followHandle = candidate.followHandle;
            candidate.followHandle = null;
            await followHandle?.close().catch(() => undefined);
        })();
        candidate.promotionInFlight = promotion;
        promotionOperations.add(promotion);
        try {
            await promotion;
        } finally {
            promotionOperations.delete(promotion);
            if (candidate.promotionInFlight === promotion) candidate.promotionInFlight = null;
        }
    }

    async function observeTranscriptLine(
        candidate: ActiveTranscriptCandidate,
        line: string,
    ): Promise<void> {
        if (disposed || activeCandidate !== candidate || candidate.invalidated || candidate.promoted) return;
        const row = parseJsonRecord(line.endsWith('\r') ? line.slice(0, -1) : line);
        if (!row) return;
        const rowProviderSessionId = readString(row.sessionId) ?? readString(row.session_id);
        if (rowProviderSessionId !== candidate.providerSessionId) return;
        const text = readUserPromptText(row);
        const timestampMs = readRowTimestampMs(row);
        if (text === null || timestampMs === null) return;
        const relevantIntent = promptIntents.some((intent) => (
            (intent.acceptedAtMs === null || intent.acceptedCandidate === candidate)
            &&
            intent.text === text
            && isWithinPromptProofWindow({
                evidenceAtMs: timestampMs,
                acceptedAtMs: intent.acceptedAtMs ?? intent.submittedAtMs,
                windowMs: promptProofWindowMs,
            })
        ));
        if (!relevantIntent) return;
        candidate.evidence.push({ text, timestampMs });
        await maybePromote(candidate);
    }

    async function attachCandidate(candidate: ActiveTranscriptCandidate): Promise<void> {
        try {
            const handle = await params.ctx.agentRuntime.transcripts.fileFollow.follow({
                path: candidate.transcriptPath,
                // SessionStart is the admission boundary for this candidate. Historical rows are
                // replay, not proof for the newly submitted prompt, even when their text and
                // timestamps happen to fall inside the prompt window.
                startAt: 'end',
                strategy: 'poll',
                onLine: async ({ line }) => {
                    await observeTranscriptLine(candidate, line);
                },
                onReset: () => {
                    candidate.invalidated = true;
                    candidate.evidence.length = 0;
                },
                onError: (error) => {
                    params.ctx.logger.debug('[ClaudeAgentSdk] transcript identity proof follow failed', { error });
                },
            });
            if (disposed || activeCandidate !== candidate || candidate.promoted) {
                await handle.close().catch(() => undefined);
                return;
            }
            candidate.followHandle = handle;
        } catch (error) {
            params.ctx.logger.debug('[ClaudeAgentSdk] transcript identity proof follow unavailable', { error });
        }
    }

    async function observeSessionStart(
        reportedProviderSessionId: string,
        payload: Readonly<Record<string, unknown>>,
    ): Promise<void> {
        if (isSidechainSessionHook(payload)) return;
        const providerSessionId = readProviderSessionId(reportedProviderSessionId, payload);
        if (expectedInitialProviderSessionId) {
            const source = readString(payload.source);
            if (source !== 'resume' || providerSessionId !== expectedInitialProviderSessionId) {
                failExplicitResume(providerSessionId, source);
                return;
            }
            expectedInitialProviderSessionId = null;
        }
        if (!providerSessionId) return;
        const transcriptPath = readTranscriptPath(payload);
        const existing = activeCandidate;
        if (
            existing
            && !existing.invalidated
            && existing.providerSessionId === providerSessionId
            && (transcriptPath === null || existing.transcriptPath === transcriptPath)
        ) {
            return;
        }
        const reactivatesInvalidatedCurrentTuple = Boolean(
            transcriptPath
            && existing?.invalidated
            && existing.providerSessionId === providerSessionId
            && existing.transcriptPath === transcriptPath,
        );
        if (
            transcriptPath
            && retiredCandidateKeys.has(candidateKey(providerSessionId, transcriptPath))
            && !reactivatesInvalidatedCurrentTuple
        ) {
            return;
        }
        if (
            transcriptPath === null
            && lastPublishedProviderSessionId !== null
            && lastPublishedProviderSessionId !== providerSessionId
        ) {
            return;
        }

        // Fence the previous follower before any asynchronous close or identity publication. Keep
        // the new candidate active while the old close drains so an authenticated prompt hook that
        // overtakes that close is still correlated with the rotated transcript.
        const candidate: ActiveTranscriptCandidate | null = transcriptPath
            ? {
                providerSessionId,
                transcriptPath,
                evidence: [],
                invalidated: false,
                promoted: false,
                promotionInFlight: null,
                followHandle: null,
            }
            : null;
        if (existing) {
            retiredCandidateKeys.add(candidateKey(existing.providerSessionId, existing.transcriptPath));
        }
        activeCandidate = candidate;
        if (lastPublishedProviderSessionId !== providerSessionId) {
            lastPublishedProviderSessionId = providerSessionId;
            params.onProviderSessionId(providerSessionId);
        }
        if (candidate) {
            params.onTranscriptCandidateActivated?.({ providerSessionId, transcriptPath: candidate.transcriptPath });
        }

        if (existing?.followHandle) {
            await existing.followHandle.close().catch(() => undefined);
        }
        if (disposed || !candidate || activeCandidate !== candidate) return;
        await attachCandidate(candidate);
    }

    async function observeAcceptedPrompt(
        reportedProviderSessionId: string,
        payload: Readonly<Record<string, unknown>>,
    ): Promise<void> {
        if (isSidechainSessionHook(payload)) return;
        const candidate = activeCandidate;
        if (!candidate) return;
        const providerSessionId = readProviderSessionId(reportedProviderSessionId, payload);
        if (providerSessionId !== candidate.providerSessionId) return;
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : null;
        if (prompt === null) return;
        const acceptedAtMs = nowMs();
        prunePromptIntents(acceptedAtMs);
        const intent = promptIntents.find((item) => item.acceptedAtMs === null && item.text === prompt);
        if (!intent) return;
        intent.acceptedAtMs = acceptedAtMs;
        intent.acceptedCandidate = candidate;
        await maybePromote(candidate);
    }

    return {
        recordSubmittedPrompt(prompt) {
            const submittedAtMs = nowMs();
            prunePromptIntents(submittedAtMs);
            promptIntents.push({ text: prompt, submittedAtMs, acceptedAtMs: null, acceptedCandidate: null });
        },
        async settleCurrentCandidate() {
            if (disposed) return;
            await Promise.allSettled(Array.from(inFlightHookOperations));
            const candidate = activeCandidate;
            if (!candidate || candidate.invalidated || candidate.promoted) return;
            await candidate.followHandle?.drainNow().catch((error) => {
                params.ctx.logger.debug('[ClaudeAgentSdk] transcript identity proof drain failed', { error });
            });
            await candidate.promotionInFlight?.catch((error) => {
                params.ctx.logger.debug('[ClaudeAgentSdk] transcript identity promotion failed', { error });
            });
        },
        async observeSessionHook(providerSessionId, payload) {
            if (disposed) return;
            const eventName = readHookEventName(payload);
            let operation: Promise<void> | null = null;
            if (eventName === 'SessionStart') {
                operation = observeSessionStart(providerSessionId, payload);
            } else if (eventName === 'UserPromptSubmit') {
                operation = observeAcceptedPrompt(providerSessionId, payload);
            }
            if (!operation) return;
            inFlightHookOperations.add(operation);
            try {
                await operation;
            } finally {
                inFlightHookOperations.delete(operation);
            }
        },
        validateSdkResultProviderSessionId(value) {
            if (explicitResumeFailure) return explicitResumeFailure;
            if (!expectedInitialProviderSessionId) return null;
            const providerSessionId = readString(value);
            if (providerSessionId !== expectedInitialProviderSessionId) {
                return failExplicitResume(providerSessionId, null);
            }
            expectedInitialProviderSessionId = null;
            return null;
        },
        readExplicitResumeFailure() {
            return explicitResumeFailure;
        },
        async dispose() {
            if (disposePromise) return await disposePromise;
            disposed = true;
            disposePromise = (async () => {
                promptIntents.length = 0;
                const candidate = activeCandidate;
                activeCandidate = null;
                await Promise.allSettled(Array.from(inFlightHookOperations));
                await Promise.allSettled(Array.from(promotionOperations));
                await candidate?.followHandle?.close().catch(() => undefined);
            })();
            await disposePromise;
        },
    };
}
