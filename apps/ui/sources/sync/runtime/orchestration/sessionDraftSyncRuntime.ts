import { SESSION_DRAFT_SOCKET_EVENT, SessionDraftSocketUpdateV1Schema, type SessionDraftSocketUpdateV1 } from '@happier-dev/protocol/drafts/sessionDrafts';
import { SESSION_DRAFT_V2_SOCKET_EVENT, SessionDraftSocketUpdateV2Schema, type SessionDraftAddressV2, type SessionDraftSocketUpdateV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { log } from '@/log';
import { isSessionDraftContextUnavailableError } from '@/sync/ops/sessionDrafts/sessionDraftCipherError';

export class SessionDraftRuntimeHydrationGate {
    private hydratedScope: ServerAccountScope | null = null;
    private inFlight: Promise<void> | null = null;
    private resetEpoch = 0;

    reset(): void {
        this.resetEpoch += 1;
        this.hydratedScope = null;
        this.inFlight = null;
    }

    run(params: Readonly<{
        scope: ServerAccountScope;
        force: boolean;
        hydrate: () => Promise<boolean>;
    }>): Promise<void> {
        if (!params.force && areServerAccountScopesEqual(this.hydratedScope, params.scope)) {
            return Promise.resolve();
        }
        if (this.inFlight) return this.inFlight;
        const capturedResetEpoch = this.resetEpoch;
        let run: Promise<void>;
        run = params.hydrate().then((hydrated) => {
            if (
                hydrated
                && this.resetEpoch === capturedResetEpoch
                && this.inFlight === run
            ) {
                this.hydratedScope = params.scope;
            }
        });
        this.inFlight = run;
        return run.finally(() => {
            if (this.inFlight === run) this.inFlight = null;
        });
    }
}

export function parseSessionDraftSocketWake(payload: unknown): SessionDraftSocketUpdateV1 | SessionDraftSocketUpdateV2 | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const { type, ...hint } = payload as Record<string, unknown>;
    const schema = type === SESSION_DRAFT_SOCKET_EVENT
        ? SessionDraftSocketUpdateV1Schema
        : type === SESSION_DRAFT_V2_SOCKET_EVENT
            ? SessionDraftSocketUpdateV2Schema
            : null;
    if (!schema) return null;
    const parsed = schema.safeParse(hint);
    return parsed.success ? parsed.data : null;
}

export async function materializeSessionDraftSocketWake(params: Readonly<{
    payload: unknown;
    capturedScope: ServerAccountScope;
    readActiveScope: () => ServerAccountScope | null;
    materializeExact: (scope: ServerAccountScope, address: SessionDraftAddressV2) => Promise<void>;
}>): Promise<boolean> {
    const update = parseSessionDraftSocketWake(params.payload);
    if (!update || !areServerAccountScopesEqual(params.readActiveScope(), params.capturedScope)) {
        return false;
    }
    try {
        await params.materializeExact(params.capturedScope, update.address);
    } catch (error) {
        if (isSessionDraftContextUnavailableError(error)) {
            log.log('[session-drafts] Socket wake deferred reason=session_context_unavailable');
            return false;
        }
        throw error;
    }
    return areServerAccountScopesEqual(params.readActiveScope(), params.capturedScope);
}

export async function materializeVisibleExistingSessionDraft(params: Readonly<{
    sessionId: string;
    capturedScope: ServerAccountScope;
    isCurrent: () => boolean;
    materializeExact: (scope: ServerAccountScope, address: SessionDraftAddressV2) => Promise<void>;
}>): Promise<boolean> {
    const sessionId = params.sessionId.trim();
    if (!sessionId || !params.isCurrent()) {
        return false;
    }
    await params.materializeExact(params.capturedScope, { kind: 'session', sessionId });
    return params.isCurrent();
}
