export type TerminalImeEvent = Readonly<{
    phase: 'start' | 'update' | 'commit' | 'cancel';
    text?: string;
}>;

export function resolveTerminalImeInput(event: TerminalImeEvent): string {
    return event.phase === 'commit' ? event.text ?? '' : '';
}
