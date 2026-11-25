/**
 * Exact-value redaction of secrets that an Agent can read and echo into its transcript. One rule:
 * string values of Agent-authored content are masked, never record keys and never control data.
 * Each shape owner passes only its content, once, before encryption or plain storage: the message
 * writer (`redactSessionMessageContentSecrets`: text, tool input and tool output), the Agent-state
 * request store when it builds the stored entry (request arguments, offer and question prose), each Execution
 * Run profile right after it decodes the Agent's output (prose of the decoded result), the Run
 * writers (`finishExecutionRun` summary and error messages) and the Voice turn-stream pushes, so
 * Run state, Review findings and comments, Workflow step results and stream reads never hold a
 * value whose registration later ends (Project secrets outlive their launch). Reads apply no second pass.
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
 * Session's content is masked with. A detached Execution Run in the daemon has its own scope the
 * same way: the exec owner registers the Project environment it materialized for the Run's launch
 * there, and that Run's result, profile and Run writers mask with it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindToHostedSessionScope, readHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { NativePermissionChoicesV1Schema, type NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

const processSecrets = new Map<string, number>();
/**
 * A detached Execution Run (no Session) is hosted by the daemon, which serves several Accounts'
 * Runs. Its launch secrets belong to that Run the way a hosted Session's belong to that Session.
 */
const executionRunSecrets = new AsyncLocalStorage<Map<string, number>>();

/** The current scope's own store: the hosted Session's, else the detached Run's; absent outside both. */
function readOwnScopeSecrets(create: boolean): Map<string, number> | undefined {
    const hosted = readHostedSessionScope();
    if (hosted) return create ? hosted.transcriptSecrets ??= new Map() : hosted.transcriptSecrets;
    return executionRunSecrets.getStore();
}

/**
 * Run one detached Execution Run's work in its own secret scope (its bridge owner keeps one store
 * per Run). Inside a hosted Session the Session scope stays the scope.
 */
export function runInExecutionRunTranscriptSecretScope<T>(secrets: Map<string, number>, run: () => T): T {
    return executionRunSecrets.run(secrets, run);
}

/**
 * Retain the caller's own secret scope (the hosted Session's and the detached Run's) when a later
 * write or comparison for its content runs from another async context, such as a queued store write
 * or a person's answer arriving through its own call.
 */
export function bindToTranscriptSecretScope<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
    const hostedBound = bindToHostedSessionScope(callback);
    const run = executionRunSecrets.getStore();
    if (!run) return hostedBound;
    return (...args) => executionRunSecrets.run(run, hostedBound, ...args);
}

function registerIn(store: Map<string, number>, secret: string): () => void {
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

export const TRANSCRIPT_SECRET_REDACTED = '[redacted]';

/** Whether stored text carries this masker's marker (a reader of the stored form can name the cause). */
export function containsTranscriptSecretMask(text: string): boolean {
    return text.includes(TRANSCRIPT_SECRET_REDACTED);
}

/** Register a live secret; the returned function releases this registration. */
export function registerTranscriptSecret(secret: string): () => void {
    const scope = readHostedSessionScope();
    return registerIn(scope ? scope.transcriptSecrets ??= new Map() : processSecrets, secret);
}

/**
 * Register a launch's own secret in its own scope only: the hosted Session's, or the detached
 * Execution Run's. Launch secrets never enter the process set, where they would mask (and reveal)
 * other Accounts' content in the same host; outside both scopes nothing is registered.
 *
 * In a Run's scope the value stays registered for the Run, not the launch: a per-turn Agent process
 * can exit (its launch released) before the Run decodes that turn. The bridge owner empties the
 * Run's store once the Run has settled and deletes it with the Run's history.
 */
export function registerSessionTranscriptSecret(secret: string): () => void {
    if (readHostedSessionScope()) return registerIn(readOwnScopeSecrets(true)!, secret);
    const run = executionRunSecrets.getStore();
    if (run) run.set(secret, (run.get(secret) ?? 0) + 1);
    return () => {};
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
    return mapRecord(value, (key, entry) => [key, redactValue(entry, secrets)]);
}

function readActiveSecrets(): readonly string[] | undefined {
    const scoped = readOwnScopeSecrets(false);
    if (processSecrets.size === 0 && !scoped?.size) return undefined;
    return [...new Set([...processSecrets.keys(), ...(scoped?.keys() ?? [])])]
        .sort((left, right) => right.length - left.length);
}

type PermissionGrantFields = Readonly<{ allowedTools?: unknown; updatedPermissions?: unknown; execPolicyAmendment?: unknown }>;

function readExecPolicyCommand(amendment: unknown): readonly unknown[] | undefined {
    if (amendment === null || typeof amendment !== 'object' || Array.isArray(amendment)) return undefined;
    const command = (amendment as Readonly<Record<string, unknown>>).command;
    return Array.isArray(command) ? command : undefined;
}

function redactPermissionGrantFields<T extends PermissionGrantFields>(record: T, secrets: readonly string[]): T {
    const allowedTools = Array.isArray(record.allowedTools)
        ? mapArray(record.allowedTools, tool => typeof tool === 'string' ? redactString(tool, secrets) : tool) : record.allowedTools;
    const updatedPermissions = record.updatedPermissions === undefined ? undefined : redactValue(record.updatedPermissions, secrets);
    const command = readExecPolicyCommand(record.execPolicyAmendment);
    const maskedCommand = command && mapArray(command, part => typeof part === 'string' ? redactString(part, secrets) : part);
    if (allowedTools === record.allowedTools && updatedPermissions === record.updatedPermissions && maskedCommand === command) return record;
    return {
        ...record,
        ...(allowedTools !== record.allowedTools ? { allowedTools } : {}),
        ...(updatedPermissions !== record.updatedPermissions ? { updatedPermissions } : {}),
        ...(maskedCommand !== command ? { execPolicyAmendment: { ...record.execPolicyAmendment as object, command: maskedCommand } } : {}),
    };
}

/**
 * The one stored form of the command-derived grants a permission answer carries: its allowed tool
 * rules, updated permissions and exec-policy amendment command pass the transcript redactor, while
 * every other field (decision, mode, approval) stays exact. A request completion and each choice of
 * a native offer take this same form, so a pending offer and its completed copy store one grant
 * form. Delivery never reads it: the Agent receives its own offer's raw grant.
 */
export function redactPermissionGrants<T extends PermissionGrantFields>(record: T): T {
    const secrets = readActiveSecrets();
    return secrets ? redactPermissionGrantFields(record, secrets) : record;
}

/** Whether a stored grant (see `redactPermissionGrants`) carries the mask, so it cannot be delivered as a grant. */
export function containsPermissionGrantMask(record: PermissionGrantFields): boolean {
    const strings = (value: unknown): boolean => typeof value === 'string' ? containsTranscriptSecretMask(value)
        : Array.isArray(value) ? value.some(strings)
            : value !== null && typeof value === 'object' && Object.values(value).some(strings);
    return strings(record.allowedTools) || strings(record.updatedPermissions) || strings(readExecPolicyCommand(record.execPolicyAmendment));
}

/**
 * A native choice offer's Agent-authored content (choice labels, rule previews, response reasons,
 * the subagent label, and each response's grants in their one stored form) is masked; requirement
 * and choice ids, decisions, scopes, modes and follow-up Actions stay exact. An offer that does not
 * parse is masked whole: it can over-mask, never leak. Shared by the request store and the message
 * writer.
 */
export function redactAgentStatePermissionChoiceOffer(value: unknown): unknown {
    if (value == null) return value;
    const secrets = readActiveSecrets();
    if (!secrets) return value;
    const offer = NativePermissionChoicesV1Schema.safeParse(value);
    if (!offer.success) return redactValue(value, secrets);
    const prose = (text: string) => redactString(text, secrets);
    const { origin, choices } = offer.data;
    return {
        ...offer.data,
        ...(origin?.subagentLabel !== undefined ? { origin: { ...origin, subagentLabel: prose(origin.subagentLabel) } } : {}),
        choices: choices.map(choice => ({
            ...choice,
            label: prose(choice.label),
            ...(choice.rulePreview !== undefined ? { rulePreview: prose(choice.rulePreview) } : {}),
            response: redactPermissionGrantFields(choice.response.reason !== undefined
                ? { ...choice.response, reason: prose(choice.response.reason) } : choice.response, secrets),
        })),
    } satisfies NativePermissionChoicesV1;
}

/**
 * Replaces every registered secret inside the string values of Agent-authored content. Record keys,
 * numbers and booleans are never touched, so the structure and types stay exact. Callers pass only
 * content, never an envelope with control fields, and pass decoded values, never serialized text that
 * is parsed later. Unchanged content is returned as is. Without a registered secret this is a no-op.
 */
export function redactTranscriptSecrets<T>(content: T): T {
    const secrets = readActiveSecrets();
    return secrets ? redactValue(content, secrets) as T : content;
}

/**
 * Masks a decoded Agent-authored record whose fields are all Agent content except the named
 * references (ids, paths, refs its shape owner resolves against host data); key order is kept.
 */
export function redactTranscriptSecretsExcept<T extends object>(record: T, references: readonly (keyof T & string)[]): T {
    const secrets = readActiveSecrets();
    if (!secrets) return record;
    return mapRecord(record, (key, entry) => [key, (references as readonly string[]).includes(key)
        ? entry : redactValue(entry, secrets)]) as T;
}
