import { maybeParseJson } from '../activity/parseJson.js';
import { resolveToolEnvelopeMeta } from '../tools/v2/meta.js';
import { isShellToolNameAlias } from '../tools/v2/aliases.js';
import { SubAgentRunResultV2Schema } from '../tools/v2/schemas.js';
import { readActionFailureCauseV1 } from './actionExecutionResult.js';
import { readActionFailurePresentationV1, type ActionFailurePresentationV1 } from './actionFailurePresentation.js';

const PREFIXES = ['mcp__happier__', 'happier__', 'happier_'] as const;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFirstPartyShellBridgeCall(value: unknown): Readonly<{ tool: string; json: boolean; rawToolName: string }> | null {
    const parsed = maybeParseJson(value);
    if (!isRecord(parsed)) return null;
    // Only a shell bridge call is first-party: check its marker before decoding the envelope, which
    // every tool call on every transcript grouping pass would otherwise pay for.
    const bridge = parsed.happierToolsShellBridge;
    if (!isRecord(bridge) || bridge.kind !== 'call') return null;
    const meta = resolveToolEnvelopeMeta(parsed);
    if (!meta || !isShellToolNameAlias(meta.rawToolName)
        || bridge.source !== 'happier'
        || typeof bridge.rawCommand !== 'string' || !bridge.rawCommand.trim()
        || typeof bridge.tool !== 'string' || bridge.tool !== meta.canonicalToolName
        || typeof bridge.json !== 'boolean'
        || !(bridge.sessionId === null || typeof bridge.sessionId === 'string')
        || !(bridge.directory === null || typeof bridge.directory === 'string')
        || !(bridge.argsJson === null || typeof bridge.argsJson === 'string')
        || !Object.hasOwn(bridge, 'args')
        || !(bridge.agentBridge === undefined || typeof bridge.agentBridge === 'boolean')) return null;
    return { tool: bridge.tool, json: bridge.json, rawToolName: meta.rawToolName };
}

/** Consume the canonicalizer's typed annotation, never reparse an arbitrary shell command. */
export function readHappierActionToolName(toolName: string, input: unknown): string {
    const bridge = readFirstPartyShellBridgeCall(input);
    return bridge && toolName === bridge.rawToolName ? `happier__${bridge.tool}` : toolName;
}

/** Normalizers preserve operands at the top level; `_raw` is only a truncated preview. */
export function readHappierActionToolPayload(value: unknown): unknown {
    const parsed = maybeParseJson(value);
    if (!isRecord(parsed) || !resolveToolEnvelopeMeta(parsed)) return parsed;
    const bridge = readFirstPartyShellBridgeCall(parsed);
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => ![
        '_happier', '_happy', '_raw', '_mcp', '_acp', 'locations',
        ...(bridge ? ['happierToolsShellBridge'] : []),
    ].includes(key)));
}

export function createHappierActionToolNameIndex<T extends string>(bindings: readonly Readonly<{ actionId: T; name?: string }>[]): ReadonlyMap<string, T> {
    return new Map(bindings.flatMap(binding => {
        const name = binding.name?.trim();
        return name ? [[name, binding.actionId] as const] : [];
    }));
}

function firstPartyName(name: string): string | null {
    for (const prefix of PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length);
    return null;
}

export function readHappierActionId<T extends string>(toolName: string, index: ReadonlyMap<string, T>): T | null {
    const name = toolName.trim();
    const bare = firstPartyName(name);
    return index.get(name) ?? (bare ? index.get(bare) ?? null : null);
}

export function readHappierActionExecuteActionId<T extends string>(
    toolName: string, input: unknown, isFamilyActionId: (id: string) => id is T,
): T | null {
    if (firstPartyName(readHappierActionToolName(toolName, input).trim()) !== 'action_execute') return null;
    const value = readHappierActionToolPayload(input);
    if (!isRecord(value) || typeof value.actionId !== 'string') return null;
    const id = value.actionId.trim();
    return isFamilyActionId(id) ? id : null;
}

/** Only documented executor and MCP text/structured envelopes are candidates. */
export function readHappierActionToolResultCandidates(result: unknown, input?: unknown): readonly unknown[] {
    const normalized = maybeParseJson(result);
    const parsed = readHappierActionToolPayload(normalized);
    const candidates: unknown[] = [parsed];
    if (isRecord(parsed) && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'value')
        && isRecord(normalized) && resolveToolEnvelopeMeta(normalized)) {
        candidates.push(maybeParseJson(parsed.value));
    }
    if (isRecord(parsed) && parsed.structuredContent !== undefined) candidates.push(parsed.structuredContent);
    // Claude ACP stores a single-text MCP result as the text itself (`content: "<json>"`).
    if (isRecord(parsed) && typeof parsed.content === 'string') candidates.push(maybeParseJson(parsed.content));
    const blocks = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.content) ? parsed.content : null;
    if (blocks?.length) {
        const texts: string[] = [];
        for (const block of blocks) {
            if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return candidates;
            texts.push(block.text);
        }
        candidates.push(maybeParseJson(texts.join('')));
    }
    const bridge = readFirstPartyShellBridgeCall(input);
    if (bridge?.json) {
        if (isRecord(parsed) && typeof parsed.stdout === 'string') candidates.push(maybeParseJson(parsed.stdout));
        for (const candidate of [...candidates]) {
            if (!isRecord(candidate) || candidate.v !== 1 || candidate.kind !== 'tools_call') continue;
            if (candidate.ok === false && isRecord(candidate.error)
                && typeof candidate.error.code === 'string' && typeof candidate.error.message === 'string') {
                candidates.push({ ok: false, errorCode: candidate.error.code, error: candidate.error.message,
                    ...(candidate.error.details === undefined ? {} : { details: candidate.error.details }) });
                continue;
            }
            if (candidate.ok !== true || !isRecord(candidate.data)) continue;
            const data = candidate.data;
            if (data.source === 'happier' && data.tool === bridge.tool && data.isError === false
                && Object.hasOwn(data, 'output')) candidates.push(data.output);
        }
    }
    return candidates;
}

export type HappierActionToolFailure = Readonly<{
    outcome?: ActionFailurePresentationV1['outcome'];
    messageTrust?: ActionFailurePresentationV1['messageTrust'];
    /** The typed failure code: the Action's `errorCode`, or a spawn error's launch code. */
    code: string;
    /** The typed cause or reason the failure's `details` name, when it names one. */
    cause: string | null;
    /** The executor's own words for it (`error`, or the run's `error.message`), when it gave any. */
    message: string | null;
}>;

function readFailureCause(details: unknown): string | null {
    if (!isRecord(details)) return null;
    for (const key of ['cause', 'reason'] as const) {
        const value = details[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * The typed Action failure a first-party Happier tool call returned: the executor's
 * `{ errorCode, error, details? }` outcome, a Session spawn's `{ type: 'error', code }`,
 * or the host SubAgentRun marker's schema-validated terminal error.
 * Other MCP servers' results are never read, whatever keys they carry.
 */
/** Words a person can read; an error that only repeats a code (`self_stop_forbidden`, `unsupported_action:x`) is not one. */
function readFailureMessage(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && !/^[\w.:/-]+$/.test(text) ? text : null;
}

export function readHappierActionToolFailure(toolName: string, input: unknown, result: unknown): HappierActionToolFailure | null {
    // SubAgentRun is the host's own transcript marker, not an arbitrary MCP result.
    if (toolName === 'SubAgentRun') {
        const parsed = SubAgentRunResultV2Schema.safeParse(readHappierActionToolPayload(result));
        return parsed.success && (parsed.data.status === 'failed' || parsed.data.status === 'timeout') && parsed.data.error
            ? { code: parsed.data.error.code, cause: null, message: readFailureMessage(parsed.data.error.message) } : null;
    }
    // Persisted tool calls are read at a boundary: a record without a name is not a first-party call.
    if (typeof toolName !== 'string' || firstPartyName(readHappierActionToolName(toolName, input).trim()) === null) return null;
    for (const candidate of readHappierActionToolResultCandidates(result, input)) {
        if (!isRecord(candidate) || candidate.ok === true) continue;
        if (typeof candidate.errorCode === 'string' && candidate.errorCode.trim() && typeof candidate.error === 'string') {
            const presentation = readActionFailurePresentationV1(candidate.errorCode.trim(), candidate.details);
            if (presentation) return { code: candidate.errorCode.trim(), cause: null,
                outcome: presentation.outcome, message: presentation.message, messageTrust: presentation.messageTrust };
            const failureCause = readActionFailureCauseV1(candidate.failureCause);
            return { code: candidate.errorCode.trim(),
                cause: readFailureCause(candidate.details) ?? ('kind' in failureCause ? null : failureCause.errorCode),
                message: readFailureMessage(candidate.error) };
        }
        if (candidate.type === 'error' && typeof candidate.code === 'string' && candidate.code.trim()) {
            const launch = isRecord(candidate.launchError) && typeof candidate.launchError.code === 'string' && candidate.launchError.code.trim()
                ? candidate.launchError.code.trim() : null;
            return { code: launch ?? candidate.code.trim(), cause: null, message: null };
        }
    }
    return null;
}
