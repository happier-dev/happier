/**
 * Exact-value redaction of secrets that an Agent can read and echo into its transcript. Applied
 * once at each Session writer of Agent-authored content, before encryption or plain storage: the
 * message writer (`buildOutboundSessionMessagePayload`) and the Agent-state commit
 * (`ApiSessionClient.updateAgentState`, which carries permission request arguments). Execution Run
 * output is redacted where it is stored: `publishExecutionRunTurn`, `finishExecutionRun`, the
 * exact-input turn writers and the Voice turn-stream pushes, so Run state, Review findings and
 * comments, Workflow step results and stream reads never hold a value whose registration later
 * ends (Project secrets outlive their launch). Reads apply no second pass.
 *
 * Covers Session MCP registration bearers, plugin-hosted loopback MCP servers, the session hook
 * server, and the secret values the daemon materialized into a runner-spawned launch (Project
 * secret bindings, Profile secret bindings, produced native credentials), registered by the
 * runner's exec authorization for its invocation's life. A Session's own launch secrets (Profile saved
 * secrets, Provider binding and Connected Account credentials the daemon materialized, carried in
 * the runner bootstrap or the foreground admission) register through
 * `beginSessionLaunchSecretRedaction` for the Session's life. Registration happens in the process
 * that writes this Session's transcript. Inside a hosted Session it goes to that Session's scope, so
 * a session host serving several Accounts never masks (or reveals the presence of) one Session's
 * values in another's content; outside any Session it goes to the process set, which every
 * Session's content is masked with.
 */
import { readHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';

const processSecrets = new Map<string, number>();

export const TRANSCRIPT_SECRET_REDACTED = '[redacted]';

/** Register a live secret; the returned function releases this registration. */
export function registerTranscriptSecret(secret: string): () => void {
    const scope = readHostedSessionScope();
    const store = scope ? scope.transcriptSecrets ??= new Map() : processSecrets;
    store.set(secret, (store.get(secret) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = store.get(secret) ?? 0;
        if (count <= 1) store.delete(secret);
        else store.set(secret, count - 1);
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
    const scoped = readHostedSessionScope()?.transcriptSecrets;
    if ((processSecrets.size === 0 && !scoped?.size) || content === undefined) return content;
    const secrets = [...new Set([...processSecrets.keys(), ...(scoped?.keys() ?? [])])]
        .sort((left, right) => right.length - left.length);
    return redactValue(content, secrets) as T;
}
