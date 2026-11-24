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
import type { AgentState } from '@/api/types';

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

/**
 * Register a Session's own secret in its hosted Session scope only. A Session's launch secrets
 * never enter the process set, where they would mask (and reveal) other Accounts' content in the
 * same host; outside a hosted Session nothing is registered.
 */
export function registerSessionTranscriptSecret(secret: string): () => void {
    if (!readHostedSessionScope()) return () => {};
    return registerTranscriptSecret(secret);
}

function redactString(value: string, secrets: readonly string[]): string {
    let redacted = value;
    for (const secret of secrets) {
        if (redacted.includes(secret)) redacted = redacted.split(secret).join(TRANSCRIPT_SECRET_REDACTED);
    }
    return redacted;
}

function mapArray(value: readonly unknown[], project: (entry: unknown) => unknown): readonly unknown[] {
    let changed = false;
    const next = value.map(entry => {
        const projected = project(entry);
        changed ||= projected !== entry;
        return projected;
    });
    return changed ? next : value;
}

function mapRecord(
    value: object,
    project: (key: string, entry: unknown) => readonly [key: string, entry: unknown],
): unknown {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    let changed = false;
    const next = Object.entries(value).map(([key, entry]) => {
        const [nextKey, nextEntry] = project(key, entry);
        changed ||= nextKey !== key || nextEntry !== entry;
        return [nextKey, nextEntry] as const;
    });
    return changed ? Object.fromEntries(next) : value;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === 'string') return redactString(value, secrets);
    if (Array.isArray(value)) return mapArray(value, entry => redactValue(entry, secrets));
    if (value === null || typeof value !== 'object') return value;
    return mapRecord(value, (key, entry) => [redactString(key, secrets), redactValue(entry, secrets)]);
}

function redactFields(
    value: unknown,
    secrets: readonly string[],
    project: (key: string, entry: unknown) => unknown,
): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return redactValue(value, secrets);
    return mapRecord(value, (key, entry) => [key, project(key, entry)]);
}

function redactChoiceOffer(value: unknown, secrets: readonly string[]): unknown {
    return redactFields(value, secrets, (key, entry) => {
        if (key === 'requirementId' || key === 'source') return entry;
        if (key === 'origin') {
            return redactFields(entry, secrets, (field, part) => field === 'sessionId' || field === 'subagentId'
                ? part : redactValue(part, secrets));
        }
        if (key === 'choices' && Array.isArray(entry)) {
            return mapArray(entry, choice => redactFields(choice, secrets, (field, part) => {
                if (field === 'id' || field === 'scope' || field === 'decision') return part;
                if (field === 'response') {
                    return redactFields(part, secrets, (name, content) => name === 'decision' || name === 'mode'
                        ? content : redactValue(content, secrets));
                }
                if (field === 'followUp') {
                    return redactFields(part, secrets, (name, content) => name === 'actionId'
                        ? content : redactValue(content, secrets));
                }
                return redactValue(part, secrets);
            }));
        }
        return redactValue(entry, secrets);
    });
}

function redactChoiceAnswer(value: unknown, secrets: readonly string[]): unknown {
    return redactFields(value, secrets, (key, entry) => key === 'requirementId' || key === 'choiceId'
        ? entry : redactValue(entry, secrets));
}

function redactRequest(value: unknown, secrets: readonly string[]): unknown {
    return redactFields(value, secrets, (key, entry) => {
        switch (key) {
            case 'turnId':
            case 'source':
            case 'kind':
            case 'lifetime':
            case 'status':
            case 'decision':
            case 'mode':
                return entry;
            case 'nativeChoices':
                return redactChoiceOffer(entry, secrets);
            case 'nativeChoice':
                return redactChoiceAnswer(entry, secrets);
            case 'permissionResponseClaimV1':
                return redactFields(entry, secrets, (field, part) => {
                    if (field === 'turnId' || field === 'origin' || field === 'decision' || field === 'scope') return part;
                    return field === 'nativeChoice' ? redactChoiceAnswer(part, secrets) : redactValue(part, secrets);
                });
            default:
                return redactValue(entry, secrets);
        }
    });
}

function readActiveSecrets(): readonly string[] | undefined {
    const scoped = readHostedSessionScope()?.transcriptSecrets;
    if (processSecrets.size === 0 && !scoped?.size) return undefined;
    return [...new Set([...processSecrets.keys(), ...(scoped?.keys() ?? [])])]
        .sort((left, right) => right.length - left.length);
}

/** Keep the Session's routing fields and request IDs intact while redacting their content. */
export function redactAgentStateTranscriptSecrets(state: AgentState): AgentState {
    const secrets = readActiveSecrets();
    if (!secrets) return state;
    return redactFields(state, secrets, (key, entry) => key === 'requests' || key === 'completedRequests'
        ? redactFields(entry, secrets, (_, request) => redactRequest(request, secrets))
        : redactValue(entry, secrets)) as AgentState;
}

/** The request store compares the live and persisted offer using the writer's projection. */
export function redactAgentStatePermissionChoiceOffer(value: unknown): unknown {
    if (value == null) return value;
    const secrets = readActiveSecrets();
    return secrets ? redactChoiceOffer(value, secrets) : value;
}

/**
 * Replaces every registered secret inside the string keys and values of JSON content, leaving its
 * structure intact; registered values may be any person-chosen string. Unchanged content is
 * returned as is. Without a registered secret this is a no-op.
 */
export function redactTranscriptSecrets<T>(content: T): T {
    const secrets = readActiveSecrets();
    return secrets ? redactValue(content, secrets) as T : content;
}
