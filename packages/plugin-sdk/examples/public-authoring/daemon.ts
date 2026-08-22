import type {
    ComposerReferenceRuntime,
    PluginApi,
} from '@happier-dev/plugin-sdk';
import {
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import {
    PluginAgentCompositionRequestSchema,
    type PluginAgentCompositionRequest,
    type PluginAgentCompositionResult,
} from '@happier-dev/plugin-sdk/hooks';
import type {
    AgentSessionRunnerFactoryLocatorV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type {
    PluginDynamicResourceInvocationOptionsV1,
    PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';
import type { SessionSystemRecordAddress } from '@happier-dev/plugin-sdk/sessions';
import { definePluginDeclarativeDocumentV1 } from '@happier-dev/plugin-sdk/ui';

type ActionRegistrationHandler = Parameters<PluginApi['actions']['register']>[1];
type HookRegistrationHandler = Parameters<PluginApi['hooks']['register']>[1];

type ReviewSummaryInput = Readonly<{
    transcript: string;
    maxBullets: number;
}>;

type ReviewSummaryData = Readonly<{
    summary: string;
    bullets: readonly string[];
}>;

const DEFAULT_MAX_BULLETS = 3;

const REVIEW_REFERENCE_CANDIDATES = [
    {
        id: 'security-check',
        label: 'Security review',
        description: 'Focus on authorization, secrets, and trust boundaries.',
    },
] satisfies Awaited<ReturnType<ComposerReferenceRuntime['search']>>;

export const reviewSessionStatusCollection = defineAccountCollection({
    id: 'review-session-statuses',
    schemaVersion: 1,
    schema: defineProtocolObject({
        id: defineProtocolString(),
        summary: defineProtocolString({ maxLength: 2_048 }),
    }, { policy: 'closed' }),
    rowIdField: 'id',
    identityFields: [],
    serverReadable: ['summary'],
    indexes: [],
    uiQueries: [],
    relations: [],
});

function abortReviewOperation(): never {
    throw new DOMException('Review operation cancelled.', 'AbortError');
}

function requireActiveReviewOperation(signal: AbortSignal): void {
    if (signal.aborted) abortReviewOperation();
}

function requireReviewSessionStatusScope(
    options: PluginDynamicResourceInvocationOptionsV1,
) {
    if (options.context.kind !== 'session') {
        throw new Error('review_session_status_requires_session_context');
    }
    if (!options.accountStorage) {
        throw new Error('review_session_status_account_storage_unavailable');
    }
    return {
        sessionId: options.context.sessionId,
        collection: options.accountStorage.collection(reviewSessionStatusCollection),
    };
}

export const reviewReferenceProvider = {
    async search(query, signal) {
        requireActiveReviewOperation(signal);
        const normalized = query.trim().toLowerCase();
        const candidates = normalized.length === 0
            ? REVIEW_REFERENCE_CANDIDATES
            : REVIEW_REFERENCE_CANDIDATES.filter((candidate) => (
                [candidate.id, candidate.label, candidate.description]
                    .some((value) => value.toLowerCase().includes(normalized))
            ));
        requireActiveReviewOperation(signal);
        return candidates;
    },
    async resolve(candidateId, signal) {
        requireActiveReviewOperation(signal);
        const candidate = REVIEW_REFERENCE_CANDIDATES.find((entry) => entry.id === candidateId);
        if (!candidate) {
            throw new Error('review_reference_not_found');
        }
        requireActiveReviewOperation(signal);
        return {
            ...candidate,
            context: 'Review focus: authorization, secrets, and trust boundaries.',
        };
    },
} satisfies ComposerReferenceRuntime;

export const reviewSessionStatusResource: PluginDynamicResourceRuntime = {
    async read(options) {
        return readReviewSessionStatus(options);
    },
    observe(invalidate, options) {
        return observeReviewSessionStatus(invalidate, options);
    },
};

async function readReviewSessionStatus(options: PluginDynamicResourceInvocationOptionsV1): Promise<string> {
    requireActiveReviewOperation(options.signal);
    const { collection, sessionId } = requireReviewSessionStatusScope(options);
    requireActiveReviewOperation(options.signal);
    const row = await collection.get(sessionId, { signal: options.signal });
    requireActiveReviewOperation(options.signal);
    return typeof row?.value.summary === 'string' ? row.value.summary : '';
}

function observeReviewSessionStatus(
    invalidate: () => void,
    options: PluginDynamicResourceInvocationOptionsV1,
) {
    requireActiveReviewOperation(options.signal);
    const { collection } = requireReviewSessionStatusScope(options);
    requireActiveReviewOperation(options.signal);
    let active = true;
    const subscription = collection.watch({ kind: 'collection' }, () => {
        if (active && !options.signal.aborted) invalidate();
    });
    const dispose = () => {
        if (!active) return;
        active = false;
        options.signal.removeEventListener('abort', dispose);
        subscription.dispose();
    };
    options.signal.addEventListener('abort', dispose, { once: true });
    if (options.signal.aborted) dispose();
    return { dispose };
}

export const projectCompanionDashboardResource: PluginDynamicResourceRuntime = {
    async read(options) {
        const summary = await readReviewSessionStatus(options);
        return JSON.stringify(definePluginDeclarativeDocumentV1({
            version: 1,
            root: {
                kind: 'group',
                title: 'Project Companion',
                description: 'Live review status for the current Session.',
                children: [{
                    kind: 'status',
                    label: 'Review status',
                    value: summary.length > 0
                        ? summary
                        : 'No review status has been declared for this Session.',
                }],
            },
        }));
    },
    observe(invalidate, options) {
        return observeReviewSessionStatus(invalidate, options);
    },
};

function readReviewSummaryInput(input: unknown): ReviewSummaryInput {
    const record = typeof input === 'object' && input !== null
        ? input as Readonly<Record<string, unknown>>
        : {};
    const transcript = typeof record.transcript === 'string' ? record.transcript.trim() : '';
    const maxBullets = typeof record.maxBullets === 'number' && Number.isInteger(record.maxBullets)
        ? Math.min(Math.max(record.maxBullets, 1), 8)
        : DEFAULT_MAX_BULLETS;

    return { transcript, maxBullets };
}

type ExternalSessionDigestEntry = Readonly<{
    title: string;
    agentTurns: number;
    userTurns: number;
    truncated: boolean;
}>;

const DEFAULT_EXTERNAL_SESSION_DIGEST_CANDIDATES = 3;
const DEFAULT_EXTERNAL_SESSION_DIGEST_ITEMS = 20;

function readExternalSessionDigestInput(value: unknown): Readonly<{
    agentId: string | null;
    maxCandidates: number;
    maxItemsPerCandidate: number;
}> {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const agentId = typeof record.agentId === 'string' && record.agentId.trim().length > 0
        ? record.agentId.trim()
        : null;
    const maxCandidates = typeof record.maxCandidates === 'number' && Number.isInteger(record.maxCandidates)
        ? Math.min(Math.max(record.maxCandidates, 1), 10)
        : DEFAULT_EXTERNAL_SESSION_DIGEST_CANDIDATES;
    const maxItemsPerCandidate = typeof record.maxItems === 'number' && Number.isInteger(record.maxItems)
        ? Math.min(Math.max(record.maxItems, 1), 50)
        : DEFAULT_EXTERNAL_SESSION_DIGEST_ITEMS;
    return { agentId, maxCandidates, maxItemsPerCandidate };
}

export const runReviewSummary: ActionRegistrationHandler = async (value, context) => {
    await context.ui?.status.set('review-summary', 'Summarizing review…');
    const input = readReviewSummaryInput(value);
    const source = input.transcript || 'No transcript was provided.';
    const firstSentence = source.split(/[.!?]\s/u)[0]?.trim() || source;

    try {
        return {
            summary: firstSentence,
            bullets: source
                .split(/\n+/u)
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(0, input.maxBullets),
        };
    } finally {
        await context.ui?.status.set('review-summary', null);
    }
};

/**
 * The External Sessions consumer path, exercised for real rather than stubbed.
 *
 * The host answers availability, owns the candidate inventory and owns the
 * transcript page; this Action only asks, filters on the capability the host
 * published for each candidate, and projects a bounded digest. It constructs no
 * `ExternalSessionRef` of its own — a ref is host-issued and is only ever
 * carried back from `list`.
 */
export const runExternalSessionDigest: ActionRegistrationHandler = async (value, context) => {
    const input = readExternalSessionDigestInput(value);
    const external = context.services.sessions.external;

    const capabilities = await external.capabilities({ signal: context.signal });
    if (capabilities.list.status !== 'available') {
        return { outcome: 'unavailable', reason: capabilities.list.code, entries: [] };
    }

    const page = await external.list(
        {
            ...(input.agentId ? { agentId: input.agentId } : {}),
            limit: input.maxCandidates,
        },
        { signal: context.signal },
    );
    const readable = page.items.filter((item) => item.capabilities.includes('transcript'));
    if (readable.length === 0) {
        return { outcome: 'no_readable_candidate', reason: null, entries: [] };
    }

    const entries: ExternalSessionDigestEntry[] = [];
    for (const candidate of readable.slice(0, input.maxCandidates)) {
        const transcript = await external.readTranscript(
            candidate.ref,
            { mode: 'page', direction: 'older', limit: input.maxItemsPerCandidate },
            { signal: context.signal },
        );
        // Only the paged arm carries items; every `readAfter` outcome is a
        // different question and is deliberately not flattened into one shape.
        if (transcript.mode !== 'page') continue;
        entries.push({
            title: candidate.title ?? 'Untitled external session',
            agentTurns: transcript.items.filter((item) => item.kind === 'agent').length,
            userTurns: transcript.items.filter((item) => item.kind === 'user').length,
            truncated: transcript.truncated === true || transcript.hasMore === true,
        });
    }

    return { outcome: 'read', reason: null, entries };
};

export const observeSessionSpawned: HookRegistrationHandler = async (
    payload,
    context,
) => {
    await Promise.resolve();
    void payload;
    void context.signal;
};

const AGENT_CONTEXT_COMPANION_TOOL_ID = 'review-summary-tool';
const AGENT_CONTEXT_COMPANION_PROMPT_ASSET_ID = 'agent-context-companion-prompt';
const AGENT_CONTEXT_COMPANION_RECORD_ADDRESS = Object.freeze({
    owner: 'plugin' as const,
    namespace: 'agent-context-companion',
    kind: 'review-cursor',
    localId: 'current',
}) satisfies SessionSystemRecordAddress;

function readAgentCompositionRequest(event: unknown): PluginAgentCompositionRequest | null {
    const envelope = event && typeof event === 'object' && !Array.isArray(event)
        ? event as Readonly<Record<string, unknown>>
        : null;
    const candidate = envelope && Object.prototype.hasOwnProperty.call(envelope, 'payload')
        ? envelope.payload
        : event;
    const parsed = PluginAgentCompositionRequestSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

function resolveAgentContextCompanionCompositionResult(
    request: PluginAgentCompositionRequest,
): PluginAgentCompositionResult {
    const enabledToolIds = request.declaredToolIds.includes(
        AGENT_CONTEXT_COMPANION_TOOL_ID,
    )
        ? [AGENT_CONTEXT_COMPANION_TOOL_ID]
        : [];
    const enabledPromptAssetIds = request.declaredPromptAssetIds.includes(
        AGENT_CONTEXT_COMPANION_PROMPT_ASSET_ID,
    )
        ? [AGENT_CONTEXT_COMPANION_PROMPT_ASSET_ID]
        : [];
    return enabledToolIds.length > 0 || enabledPromptAssetIds.length > 0
        ? {
            enabledToolIds,
            enabledPromptAssetIds,
            additionalInstructions:
                'Use the bounded review context for this turn and preserve the review cursor in your response when it matters.',
        }
        : {
            enabledToolIds,
            enabledPromptAssetIds,
        };
}

/**
 * The host-stamped Session handle is the only persistence path for the
 * Companion cursor. While this hook is active, omission of both applicable
 * declarations clears its bounded record rather than retaining stale context.
 * Disable/uninstall stops hook invocation at the host lifecycle owner; this
 * plugin has no cleanup callback, local store, or fallback path.
 */
async function synchronizeAgentContextCompanionRecord(
    request: PluginAgentCompositionRequest,
    result: PluginAgentCompositionResult,
    context: Parameters<HookRegistrationHandler>[1],
): Promise<void> {
    context.signal.throwIfAborted();
    const session = await context.services.sessions.get(request.sessionId, {
        signal: context.signal,
    });
    context.signal.throwIfAborted();
    if (!session) return;

    const existing = await session.readSystemRecord({
        address: AGENT_CONTEXT_COMPANION_RECORD_ADDRESS,
    }, { signal: context.signal });
    context.signal.throwIfAborted();
    const hasSelectedContribution = (result.enabledToolIds?.length ?? 0) > 0
        || (result.enabledPromptAssetIds?.length ?? 0) > 0;
    if (!hasSelectedContribution) {
        if (existing) {
            await session.deleteSystemRecord({
                address: AGENT_CONTEXT_COMPANION_RECORD_ADDRESS,
                expectedRevision: existing.revision,
            }, { signal: context.signal });
            context.signal.throwIfAborted();
        }
        return;
    }

    await session.upsertSystemRecord({
        address: AGENT_CONTEXT_COMPANION_RECORD_ADDRESS,
        content: {
            version: 1,
            cursor: request.agentId,
            annotation: 'Bounded review cursor for the next Agent composition turn.',
        },
        expectedRevision: existing?.revision ?? null,
    }, { signal: context.signal });
    context.signal.throwIfAborted();
}

/**
 * Public-only next-turn composition. It receives no Session/runtime handle;
 * the host validates these local ids against this plugin's current manifest.
 */
export const resolveAgentContextCompanionComposition: HookRegistrationHandler = async (
    event,
    context,
) => {
    const request = readAgentCompositionRequest(event);
    if (!request) return undefined;
    context.signal.throwIfAborted();
    const result = resolveAgentContextCompanionCompositionResult(request);
    try {
        await synchronizeAgentContextCompanionRecord(request, result, context);
    } catch (error) {
        // A stale/failed persistence attempt is local to this plugin's
        // annotation. The host still composes the independently valid turn.
        if (context.signal.aborted) throw error;
    }
    context.signal.throwIfAborted();
    return result;
};

export const reviewAgentRunnerFactory = Object.freeze({
    module: './agent/runtime.js',
    export: 'createReviewAgentRuntime',
    runtimeApiVersion: 1,
}) satisfies AgentSessionRunnerFactoryLocatorV1;
