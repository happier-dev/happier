import { listActionSpecs, type ActionId } from '@happier-dev/protocol';

export type ParsedSessionSlashCommand =
    | { kind: 'client.clear_input' }
    | { kind: 'action'; actionId: ActionId; rest: string };

const SLASH_TOKEN_TO_ACTION_ID: Readonly<Record<string, ActionId>> = (() => {
    const entries: Array<readonly [string, ActionId]> = [];
    for (const spec of listActionSpecs() as any[]) {
        if (spec?.surfaces?.ui_slash_command !== true) continue;
        const actionId = String(spec?.id ?? '').trim();
        if (!actionId) continue;
        const tokens = Array.isArray(spec?.slash?.tokens) ? spec.slash.tokens : [];
        for (const token of tokens) {
            const t = String(token ?? '').trim();
            if (!t) continue;
            entries.push([t, actionId as ActionId] as const);
        }
    }
    return Object.freeze(Object.fromEntries(entries));
})();

function tokenize(input: string): { command: string; rest: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) return { command: trimmed, rest: '' };
    return { command: trimmed.slice(0, firstSpace), rest: trimmed.slice(firstSpace + 1).trim() };
}

export function parseSessionSlashCommand(input: string): ParsedSessionSlashCommand | null {
    const tokens = tokenize(input);
    if (!tokens) return null;

    if (tokens.command === '/clear') {
        return { kind: 'client.clear_input' };
    }

    const actionId = SLASH_TOKEN_TO_ACTION_ID[tokens.command];
    if (actionId) return { kind: 'action', actionId, rest: tokens.rest };

    return null;
}
