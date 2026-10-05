import type { FindOptions, FindStatus } from '@happier-dev/plugin-ui/presentation';
import type { CodeEditorFindTarget } from '../codeEditorTypes';

export type CodeEditorFindSet = Readonly<{ query: string; options: FindOptions; target?: CodeEditorFindTarget }>;
export type CodeEditorFindMessage =
    | Readonly<{ v: 1; type: 'find.set'; payload: CodeEditorFindSet }>
    | Readonly<{ v: 1; type: 'find.step'; payload: Readonly<{ direction: 1 | -1 }> }>
    | Readonly<{ v: 1; type: 'find.close'; payload: Readonly<Record<string, never>> }>;

/** Only the live CodeMirror engine can report complete document results. */
export function readCodeMirrorFindStatus(payload: unknown, request: Readonly<{ query: string; options: FindOptions }>): FindStatus | null {
    if (!payload || typeof payload !== 'object' || !('status' in payload)) return null;
    if (!('query' in payload) || payload.query !== request.query || !('options' in payload)) return null;
    const options = payload.options;
    if (!options || typeof options !== 'object' || !('matchCase' in options) || !('regex' in options)) return null;
    if (options.matchCase !== request.options.matchCase || options.regex !== request.options.regex) return null;
    const status = payload.status;
    if (!status || typeof status !== 'object' || !('kind' in status)) return null;
    if (status.kind === 'idle' || status.kind === 'invalidPattern') return { kind: status.kind };
    if (status.kind !== 'results' || !('total' in status) || !('current' in status) || !('coverage' in status)) return null;
    const { total, current, coverage } = status;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || coverage !== 'complete') return null;
    if (current !== null && (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 1 || current > total)) return null;
    return { kind: 'results', current, total, coverage };
}
