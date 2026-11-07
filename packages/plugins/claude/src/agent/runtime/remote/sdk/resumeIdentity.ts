import type {
    AgentTranscriptFileFollowHandle,
    AgentTranscriptFileFollowService,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeRuntimeLogger } from '../../dependencies.js';

import { readClaudeProviderIdentityValue } from '../../../../protocol/providerIdentity.js';
import { isSidechainSessionHook } from '../../../hooks/sidechain.js';

/**
 * One submitted prompt awaiting native acceptance (UserPromptSubmit) and its
 * persisted transcript row. Intents leave by lifecycle, never by elapsed time:
 * a later acceptance supersedes earlier unaccepted prompts, promotion consumes
 * the candidate's proof, and a retired candidate drops what it accepted.
 */
type PromptIntent = {
    text: string;
    acceptedCandidate: ActiveTranscriptCandidate | null;
};

type TranscriptEvidence = Readonly<{
    text: string;
}>;

type SessionHookOrigin = 'sdk' | 'local_terminal';

type ActiveTranscriptCandidate = {
    providerSessionId: string;
    transcriptPath: string;
    evidence: TranscriptEvidence[];
    invalidated: boolean;
    promoted: boolean;
    promotionInFlight: Promise<void> | null;
    promotionRefused: boolean;
    promotionRetryRequested: boolean;
    followHandle: AgentTranscriptFileFollowHandle | null;
    proofReadFailure: unknown;
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
        origin?: SessionHookOrigin,
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
    reportedProviderSessionId: unknown,
    payload: Readonly<Record<string, unknown>>,
): string | null {
    const values = [
        readClaudeProviderIdentityValue(reportedProviderSessionId),
        readClaudeProviderIdentityValue(payload.session_id),
        readClaudeProviderIdentityValue(payload.sessionId),
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
}>): ClaudeAgentSdkResumeIdentityOwner {
    const promptIntents: PromptIntent[] = [];
    const retiredCandidateKeys = new Set<string>();
    const inFlightHookOperations = new Set<Promise<void>>();
    const promotionOperations = new Set<Promise<void>>();
    let activeCandidate: ActiveTranscriptCandidate | null = null;
    let lastPublishedProviderSessionId: string | null = null;
    let expectedInitialProviderSessionId = readClaudeProviderIdentityValue(params.expectedInitialProviderSessionId);
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

    function dropIntentsAcceptedFor(candidate: ActiveTranscriptCandidate): void {
        for (let index = promptIntents.length - 1; index >= 0; index -= 1) {
            if (promptIntents[index]?.acceptedCandidate === candidate) promptIntents.splice(index, 1);
        }
    }

    function findAcceptedIntent(
        candidate: ActiveTranscriptCandidate,
        evidence: TranscriptEvidence,
    ): PromptIntent | null {
        return promptIntents.find((intent) => (
            intent.acceptedCandidate === candidate
            && intent.text === evidence.text
        )) ?? null;
    }

    async function maybePromote(candidate: ActiveTranscriptCandidate): Promise<void> {
        if (disposed || activeCandidate !== candidate || candidate.invalidated || candidate.promoted) return;
        if (candidate.promotionRefused && !candidate.promotionRetryRequested) return;
        if (candidate.promotionInFlight) return await candidate.promotionInFlight;
        const evidence = candidate.evidence.find((item) => findAcceptedIntent(candidate, item) !== null);
        if (!evidence) return;
        const acceptedIntent = findAcceptedIntent(candidate, evidence);
        if (!acceptedIntent) return;
        candidate.promotionRetryRequested = false;

        const promotion = (async () => {
            try {
                await params.onTranscriptPromoted({
                    providerSessionId: candidate.providerSessionId,
                    transcriptPath: candidate.transcriptPath,
                    isCurrent: () => !disposed && activeCandidate === candidate && !candidate.invalidated,
                });
            } catch (error) {
                // A deterministic host admission refusal is an outcome of this proof,
                // not a failed JSONL read. Acknowledge the row so at-least-once delivery
                // does not turn the refusal into a polling retry loop.
                if (error instanceof Error
                    && Reflect.get(error, 'code') === 'native_agent_terminal_transcript_follow_admission_failed'
                    && Reflect.get(error, 'phase') === 'bind'
                    && Reflect.get(error, 'retryable') === false) {
                    if (!candidate.promotionRefused) {
                        candidate.promotionRefused = true;
                        params.ctx.logger.warn('[ClaudeAgentSdk] transcript identity promotion refused', {
                            code: Reflect.get(error, 'followCode'),
                        });
                    }
                    return;
                }
                throw error;
            }
            if (activeCandidate !== candidate || candidate.invalidated) return;
            candidate.promoted = true;
            dropIntentsAcceptedFor(candidate);
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
        const rowProviderSessionId = readProviderSessionId(undefined, row);
        if (rowProviderSessionId !== candidate.providerSessionId) return;
        const text = readUserPromptText(row);
        if (text === null) return;
        const relevantIntent = promptIntents.some((intent) => (
            (intent.acceptedCandidate === null || intent.acceptedCandidate === candidate)
            && intent.text === text
        ));
        if (!relevantIntent) return;
        candidate.evidence.push({ text });
        candidate.promotionRetryRequested = true;
        candidate.proofReadFailure = null;
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
                    recordProofReadFailure(candidate, error);
                },
            });
            if (disposed || activeCandidate !== candidate || candidate.promoted) {
                await handle.close().catch(() => undefined);
                return;
            }
            candidate.followHandle = handle;
        } catch (error) {
            recordProofReadFailure(candidate, error);
        }
    }

    function recordProofReadFailure(candidate: ActiveTranscriptCandidate, error: unknown): void {
        if (disposed || activeCandidate !== candidate || candidate.invalidated || candidate.promoted) return;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (code === 'ENOENT' || code === 'ENOTDIR') return;
        candidate.proofReadFailure = error ?? new Error('Claude transcript identity proof is unavailable.');
        params.ctx.logger.warn('[ClaudeAgentSdk] transcript identity proof read failed', { error });
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
            existing.promotionRetryRequested = true;
            await maybePromote(existing);
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
                promotionRefused: false,
                promotionRetryRequested: false,
                followHandle: null,
                proofReadFailure: null,
            }
            : null;
        if (existing) {
            retiredCandidateKeys.add(candidateKey(existing.providerSessionId, existing.transcriptPath));
            dropIntentsAcceptedFor(existing);
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
        origin: SessionHookOrigin,
    ): Promise<void> {
        if (isSidechainSessionHook(payload)) return;
        const candidate = activeCandidate;
        if (!candidate) return;
        const providerSessionId = readProviderSessionId(reportedProviderSessionId, payload);
        if (providerSessionId !== candidate.providerSessionId) return;
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : null;
        if (prompt === null) return;
        let index = promptIntents.findIndex((item) => item.acceptedCandidate === null && item.text === prompt);
        if (index < 0 && origin === 'local_terminal') {
            // An owned terminal's authenticated submit hook is the person's input boundary;
            // no host-injected prompt precedes it. The matching transcript row still proves persistence.
            promptIntents.push({ text: prompt, acceptedCandidate: null });
            index = promptIntents.length - 1;
        }
        if (index < 0) return;
        const intent = promptIntents[index]!;
        // Native acceptance is ordered: earlier prompts still unaccepted were superseded.
        for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
            if (promptIntents[earlier]?.acceptedCandidate === null) promptIntents.splice(earlier, 1);
        }
        if (candidate.promoted) {
            // This candidate's resume proof is already durable; nothing left to prove.
            promptIntents.splice(promptIntents.indexOf(intent), 1);
            return;
        }
        intent.acceptedCandidate = candidate;
        candidate.promotionRetryRequested = true;
        await maybePromote(candidate);
    }

    return {
        recordSubmittedPrompt(prompt) {
            promptIntents.push({ text: prompt, acceptedCandidate: null });
            if (activeCandidate) activeCandidate.promotionRetryRequested = true;
        },
        async settleCurrentCandidate() {
            while (!disposed) {
                await Promise.allSettled(Array.from(inFlightHookOperations));
                const candidate = activeCandidate;
                if (!candidate || candidate.invalidated || candidate.promoted) return;
                await candidate.followHandle?.drainNow().catch((error) => {
                    recordProofReadFailure(candidate, error);
                });
                await candidate.promotionInFlight?.catch((error) => {
                    params.ctx.logger.debug('[ClaudeAgentSdk] transcript identity promotion failed', { error });
                });
                // A hook may replace the identity during either await. Settle its candidate before takeover.
                if (activeCandidate !== candidate) continue;
                if (disposed || candidate.invalidated || candidate.promoted) return;
                // Host drains can resolve after reporting onError; only matched proof retires that failure.
                if (candidate.proofReadFailure !== null) throw candidate.proofReadFailure;
                return;
            }
        },
        async observeSessionHook(providerSessionId, payload, origin = 'sdk') {
            if (disposed) return;
            const eventName = readHookEventName(payload);
            let operation: Promise<void> | null = null;
            if (eventName === 'SessionStart') {
                operation = observeSessionStart(providerSessionId, payload);
            } else if (eventName === 'UserPromptSubmit') {
                operation = observeAcceptedPrompt(providerSessionId, payload, origin);
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
            const providerSessionId = readClaudeProviderIdentityValue(value);
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
