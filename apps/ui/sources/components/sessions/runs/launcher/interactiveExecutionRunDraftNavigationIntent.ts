import { ExecutionRunDraftCorrelationIdSchema } from '@happier-dev/protocol/execution/runs/index';
import { SessionDiscussionSelectionSourceV1Schema, type SessionDiscussionSelectionSourceV1 } from '@happier-dev/protocol/sessions/discussions/content';

import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

type InteractiveExecutionRunDraftNavigationIntent = Readonly<{
    addressKey: string;
    source: SessionDiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
    initialText: string;
}>;

const pendingByCorrelationId = new Map<string, InteractiveExecutionRunDraftNavigationIntent>();

/**
 * Process-local responsive navigation handoff for the canonical interactive Run draft.
 * Selected text stays out of route history; the qualified route carries only its opaque
 * Run correlation identity and consumes this payload once.
 */
export function publishInteractiveExecutionRunDraftNavigationIntent(input: Readonly<{
    address: SessionAddress;
    source: SessionDiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
    initialText: string;
}>): Readonly<{ correlationId: string; href: string }> {
    const parsedSource = SessionDiscussionSelectionSourceV1Schema.parse(input.source);
    const correlationId = ExecutionRunDraftCorrelationIdSchema.parse(input.source.draftCorrelationId);
    const source = Object.freeze({ ...parsedSource, draftCorrelationId: correlationId });
    if (source.sessionId !== input.address.sessionId) {
        throw new Error('Discussion selection source does not match the destination Session');
    }
    pendingByCorrelationId.set(correlationId, Object.freeze({
        addressKey: sessionAddressKey(input.address),
        source,
        initialText: input.initialText,
    }));
    return Object.freeze({
        correlationId,
        href: buildScopedSessionRouteHref({
            sessionId: input.address.sessionId,
            serverId: input.address.serverId,
            suffix: '/runs/new',
            query: { draftCorrelationId: correlationId },
        }),
    });
}

export function consumeInteractiveExecutionRunDraftNavigationIntent(input: Readonly<{
    address: SessionAddress;
    correlationId: string;
}>): Readonly<{
    source: SessionDiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
    initialText: string;
}> | null {
    const pending = readInteractiveExecutionRunDraftNavigationIntent(input);
    if (!pending) return null;
    pendingByCorrelationId.delete(input.correlationId.trim());
    return pending;
}

/** Reads without mutating during React render; the mounted route consumes after commit. */
export function readInteractiveExecutionRunDraftNavigationIntent(input: Readonly<{
    address: SessionAddress;
    correlationId: string;
}>): Readonly<{
    source: SessionDiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
    initialText: string;
}> | null {
    const correlationId = input.correlationId.trim();
    if (!correlationId) return null;
    const pending = pendingByCorrelationId.get(correlationId);
    if (!pending || pending.addressKey !== sessionAddressKey(input.address)) return null;
    return Object.freeze({ source: pending.source, initialText: pending.initialText });
}

export function resetInteractiveExecutionRunDraftNavigationIntentsForTests(): void {
    pendingByCorrelationId.clear();
}
