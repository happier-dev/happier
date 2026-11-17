import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectTargetActionDiagnosticIssue, type TargetActionDiagnosticConfidentiality } from './actionDiagnosticRedaction.js';

/**
 * Projects already-admitted JSON through the invocation's existing redactor.
 * Admission remains with the Action/MCP owner. An iterative work list preserves
 * valid deep results without introducing a depth quota or call-stack boundary.
 */
export function redactPluginInvocationResultData(
    value: JsonValue,
    redact: (value: string) => string,
    confidentiality?: TargetActionDiagnosticConfidentiality,
): JsonValue {
    if (typeof value === 'string') return redact(value);
    if (value === null || typeof value !== 'object') return value;
    const redactedLeaf = projectRedactedTypedLeaf(value, redact);
    if (redactedLeaf) return redactedLeaf;

    type PendingRedaction =
        | Readonly<{ kind: 'array'; source: readonly JsonValue[]; destination: JsonValue[]; path: readonly string[] }>
        | Readonly<{ kind: 'record'; source: Readonly<Record<string, JsonValue>>; destination: Record<string, JsonValue>; path: readonly string[] }>;
    const isJsonArray = (candidate: JsonValue): candidate is readonly JsonValue[] => Array.isArray(candidate);
    const root: PendingRedaction = isJsonArray(value)
        ? { kind: 'array', source: value, destination: [], path: [] }
        : { kind: 'record', source: value, destination: {}, path: [] };
    const pending: PendingRedaction[] = [root];
    const confidentialPaths = new Set(confidentiality?.paths);
    const project = (candidate: JsonValue, path: readonly string[]): JsonValue => {
        // PluginError owns its envelope; only details carry input operands.
        // Terminal confidentiality markers must not be redacted a second time.
        if (path[0] === 'details' && confidentialPaths.has(path.slice(1).join('.'))) return '[REDACTED]';
        const issue = path[0] === 'details' && confidentiality
            ? projectTargetActionDiagnosticIssue(candidate, confidentiality) : null;
        if (issue) candidate = { path: [...issue.path], code: issue.code, message: issue.message };
        if (typeof candidate === 'string') return redact(candidate);
        if (candidate === null || typeof candidate !== 'object') return candidate;
        const redactedLeaf = projectRedactedTypedLeaf(candidate, redact);
        if (redactedLeaf) return redactedLeaf;
        const next: PendingRedaction = isJsonArray(candidate)
            ? { kind: 'array', source: candidate, destination: [], path }
            : { kind: 'record', source: candidate, destination: {}, path };
        pending.push(next);
        return next.destination;
    };
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) continue;
        if (current.kind === 'array') {
            for (let index = 0; index < current.source.length; index += 1) {
                current.destination[index] = project(current.source[index]!, confidentialPaths.size > 0 ? [...current.path, String(index)] : current.path);
            }
        } else {
            for (const [key, candidate] of Object.entries(current.source)) {
                Object.defineProperty(current.destination, redact(key), {
                    value: project(candidate, confidentialPaths.size > 0 ? [...current.path, key] : current.path),
                    enumerable: true, configurable: true, writable: true,
                });
            }
        }
    }
    return root.destination;
}

/**
 * A typed leaf ({ type, value }) constrains its value's format by its tag. When the redactor
 * replaces part of a non-text leaf's value, keeping that tag would publish an invalid value,
 * so the leaf becomes the plain text carrying the redacted string. Text leaves keep their shape.
 */
function projectRedactedTypedLeaf(candidate: JsonValue, redact: (value: string) => string): JsonValue | undefined {
    if (Array.isArray(candidate) || candidate === null || typeof candidate !== 'object') return undefined;
    const { type, value } = candidate;
    if (typeof type !== 'string' || typeof value !== 'string') return undefined;
    if (type === 'text' && Object.keys(candidate).length === 2) return undefined;
    const redacted = redact(value);
    return redacted === value ? undefined : { type: 'text', value: redacted };
}
