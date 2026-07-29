type SwitchAttemptKeyInput = Readonly<{
    sessionId: string;
    serviceId: string;
    groupId: string;
    profileId?: string | null;
    credentialRevision?: string | null;
}>;

type SwitchAttemptEntry = Readonly<{
    switches: number;
    updatedAtMs: number;
}>;

function normalizeString(value: string): string {
    return value.trim();
}

function sessionGroupKeyFor(input: SwitchAttemptKeyInput): string {
    return `${normalizeString(input.sessionId)}\0${normalizeString(input.serviceId)}\0${normalizeString(input.groupId)}`;
}

function failureEdgeKeyFor(input: SwitchAttemptKeyInput): string {
    const profileId = typeof input.profileId === 'string' ? normalizeString(input.profileId) : '';
    const credentialRevision = typeof input.credentialRevision === 'string'
        ? normalizeString(input.credentialRevision)
        : '';
    return `${sessionGroupKeyFor(input)}\0${profileId}\0${credentialRevision}`;
}

function normalizeSwitches(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export class ConnectedServiceRuntimeAuthSwitchAttemptTracker {
    private readonly attemptsByKey = new Map<string, SwitchAttemptEntry>();
    private readonly sessionSwitchTimestampsByKey = new Map<string, number[]>();

    constructor(private readonly deps: Readonly<{
        nowMs: () => number;
        windowMs: number;
    }>) {}

    private isFresh(entry: SwitchAttemptEntry, nowMs: number): boolean {
        const windowMs = Math.max(0, Math.trunc(this.deps.windowMs));
        return windowMs === 0 || nowMs - entry.updatedAtMs <= windowMs;
    }

    resolveSwitchesThisTurn(input: SwitchAttemptKeyInput & Readonly<{
        reportedSwitchesThisTurn: number;
    }>): number {
        const nowMs = this.deps.nowMs();
        const key = failureEdgeKeyFor(input);
        const entry = this.attemptsByKey.get(key);
        const reported = normalizeSwitches(input.reportedSwitchesThisTurn);
        if (!entry) return reported;
        if (!this.isFresh(entry, nowMs)) {
            this.attemptsByKey.delete(key);
            return reported;
        }
        return Math.max(reported, entry.switches);
    }

    recordSwitchResult(input: SwitchAttemptKeyInput & Readonly<{
        resultStatus: string;
    }>): void {
        if (input.resultStatus !== 'switched') return;
        const nowMs = this.deps.nowMs();
        const key = failureEdgeKeyFor(input);
        const existing = this.attemptsByKey.get(key);
        const existingSwitches = existing && this.isFresh(existing, nowMs) ? existing.switches : 0;
        this.attemptsByKey.set(key, {
            switches: existingSwitches + 1,
            updatedAtMs: nowMs,
        });
        const sessionGroupKey = sessionGroupKeyFor(input);
        const existingTimestamps = this.sessionSwitchTimestampsByKey.get(sessionGroupKey) ?? [];
        this.sessionSwitchTimestampsByKey.set(sessionGroupKey, [...existingTimestamps, nowMs]);
    }

    countRecordedSwitchesInWindow(input: SwitchAttemptKeyInput & Readonly<{
        windowMs: number;
    }>): number {
        const nowMs = this.deps.nowMs();
        const windowMs = Math.max(0, Math.trunc(input.windowMs));
        const key = sessionGroupKeyFor(input);
        const recent = (this.sessionSwitchTimestampsByKey.get(key) ?? []).filter((timestamp) =>
            windowMs === 0 || nowMs - timestamp <= windowMs,
        );
        if (recent.length > 0) {
            this.sessionSwitchTimestampsByKey.set(key, recent);
            return recent.length;
        }
        this.sessionSwitchTimestampsByKey.delete(key);
        return 0;
    }

    clearSession(sessionIdRaw: string): void {
        const sessionId = normalizeString(sessionIdRaw);
        if (!sessionId) return;
        const prefix = `${sessionId}\0`;
        for (const key of this.attemptsByKey.keys()) {
            if (key.startsWith(prefix)) this.attemptsByKey.delete(key);
        }
        for (const key of this.sessionSwitchTimestampsByKey.keys()) {
            if (key.startsWith(prefix)) this.sessionSwitchTimestampsByKey.delete(key);
        }
    }
}
