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
