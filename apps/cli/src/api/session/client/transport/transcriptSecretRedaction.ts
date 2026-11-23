/**
 * Exact-value redaction of secrets that an Agent can read and echo into its transcript. Applied
 * once at each Session writer of Agent-authored content, before encryption or plain storage: the
 * message writer (`buildOutboundSessionMessagePayload`) and the Agent-state commit
 * (`ApiSessionClient.updateAgentState`, which carries permission request arguments). Execution Run
 * output is redacted where it is stored: `publishExecutionRunTurn` and `finishExecutionRun`, so
 * Run state, Review findings and comments, and Workflow step results never hold a value whose
 * registration later ends (Project secrets outlive their launch). The Run read projection in
 * `dispatchExecutionRunRpcAction.ts` still applies it for live host-minted bearers.
 *
 * Covers Session MCP registration bearers, plugin-hosted loopback MCP servers, the session hook
 * server, and the secret values the daemon materialized into a runner-spawned launch (Project
 * secret bindings, Profile secret bindings, produced native credentials), registered by the
 * runner's exec authorization for the launch's life. The registry is process-local: it protects
 * the process that writes this Session's transcript, so registration happens there.
 */
const registeredSecrets = new Map<string, number>();

export const TRANSCRIPT_SECRET_REDACTED = '[redacted]';

/** Register a live secret; the returned function releases this registration. */
export function registerTranscriptSecret(secret: string): () => void {
    registeredSecrets.set(secret, (registeredSecrets.get(secret) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = registeredSecrets.get(secret) ?? 0;
        if (count <= 1) registeredSecrets.delete(secret);
        else registeredSecrets.set(secret, count - 1);
    };
}

function redactString(value: string, secrets: readonly string[]): string {
    let redacted = value;
    for (const secret of secrets) {
        if (redacted.includes(secret)) redacted = redacted.split(secret).join(TRANSCRIPT_SECRET_REDACTED);
    }
    return redacted;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === 'string') return redactString(value, secrets);
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map(entry => {
            const redacted = redactValue(entry, secrets);
            changed ||= redacted !== entry;
            return redacted;
        });
        return changed ? next : value;
    }
    if (value === null || typeof value !== 'object') return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        const redactedKey = redactString(key, secrets);
        const redacted = redactValue(entry, secrets);
        changed ||= redactedKey !== key || redacted !== entry;
        next[redactedKey] = redacted;
    }
    return changed ? next : value;
}

/**
 * Replaces every registered secret inside the string keys and values of JSON content, leaving its
 * structure intact; registered values may be any person-chosen string. Unchanged content is
 * returned as is. Without a registered secret this is a no-op.
 */
export function redactTranscriptSecrets<T>(content: T): T {
    if (registeredSecrets.size === 0 || content === undefined) return content;
    const secrets = [...registeredSecrets.keys()].sort((left, right) => right.length - left.length);
    return redactValue(content, secrets) as T;
}
