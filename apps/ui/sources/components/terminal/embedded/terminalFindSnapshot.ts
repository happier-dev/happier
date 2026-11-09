import type { TerminalFindSnapshot } from './embeddedTerminalRendererHandle';

/** Both xterm hosts publish the same terminal-only status and preserve unchanged facts. */
export function reconcileTerminalFindSnapshot(previous: TerminalFindSnapshot, next: TerminalFindSnapshot): TerminalFindSnapshot {
    const options = next.options.regex === previous.options.regex && next.options.matchCase === previous.options.matchCase
        ? previous.options : next.options;
    const sameStatus = next.status === previous.status || next.status.kind === previous.status.kind && (
        next.status.kind === 'idle' || next.status.kind === 'invalidPattern'
        || next.status.kind === 'results' && previous.status.kind === 'results'
            && next.status.current === previous.status.current && next.status.total === previous.status.total
            && next.status.coverage === previous.status.coverage);
    const status = sameStatus ? previous.status : next.status;
    if (next.open === previous.open && next.query === previous.query && options === previous.options
        && status === previous.status && next.retainedLines === previous.retainedLines) return previous;
    return { ...next, options, status };
}
