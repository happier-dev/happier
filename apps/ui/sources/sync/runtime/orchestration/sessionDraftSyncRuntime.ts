import {
    SESSION_DRAFT_SOCKET_EVENT,
    SessionDraftSocketUpdateV1Schema,
    type SessionDraftAddressV1,
    type SessionDraftSocketUpdateV1,
} from '@happier-dev/protocol';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

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

export function parseSessionDraftSocketWake(payload: unknown): SessionDraftSocketUpdateV1 | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const { type, ...hint } = payload as Record<string, unknown>;
    if (type !== SESSION_DRAFT_SOCKET_EVENT) return null;
    const parsed = SessionDraftSocketUpdateV1Schema.safeParse(hint);
    return parsed.success ? parsed.data : null;
}

export async function materializeSessionDraftSocketWake(params: Readonly<{
    payload: unknown;
    capturedScope: ServerAccountScope;
    readActiveScope: () => ServerAccountScope | null;
    materializeExact: (scope: ServerAccountScope, address: SessionDraftAddressV1) => Promise<void>;
}>): Promise<boolean> {
    const update = parseSessionDraftSocketWake(params.payload);
    if (!update || !areServerAccountScopesEqual(params.readActiveScope(), params.capturedScope)) {
        return false;
    }
    await params.materializeExact(params.capturedScope, update.address);
    return areServerAccountScopesEqual(params.readActiveScope(), params.capturedScope);
}
