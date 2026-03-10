import type { Metadata } from '@/sync/domains/state/storageTypes';

export function getAttachCommandForSession(params: {
    sessionId: string;
    terminal: Metadata['terminal'] | null | undefined;
}): string | null {
    const { sessionId, terminal } = params;
    if (!terminal) return null;
    if (terminal.mode === 'tmux') {
        if (!terminal.tmux?.target) return null;
    } else if (terminal.mode === 'windows_terminal') {
        if (!terminal.windows?.windowId) return null;
    } else if (terminal.mode === 'windows_console') {
        if (terminal.windows?.host !== 'console') return null;
    } else {
        return null;
    }
    return `happier attach ${sessionId}`;
}

export function getTmuxTargetForSession(terminal: Metadata['terminal'] | null | undefined): string | null {
    if (!terminal) return null;
    if (terminal.mode !== 'tmux') return null;
    return terminal.tmux?.target ?? null;
}

export function getTmuxFallbackReason(terminal: Metadata['terminal'] | null | undefined): string | null {
    if (!terminal) return null;
    if (terminal.mode !== 'plain') return null;
    if (terminal.requested !== 'tmux') return null;
    return terminal.fallbackReason ?? null;
}
