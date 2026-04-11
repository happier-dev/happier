import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { randomUUID } from '@/platform/randomUUID';

export type TerminalDetailsResource = Readonly<{
    kind: 'terminal';
    terminalInstanceId: string;
    cwd?: string | null;
    title?: string | null;
}>;

export function isTerminalDetailsResource(value: unknown): value is TerminalDetailsResource {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as {
        kind?: unknown;
        terminalInstanceId?: unknown;
        cwd?: unknown;
        title?: unknown;
    };
    return (
        maybe.kind === 'terminal'
        && (maybe.terminalInstanceId == null || (typeof maybe.terminalInstanceId === 'string' && maybe.terminalInstanceId.trim().length > 0))
        && (maybe.cwd == null || typeof maybe.cwd === 'string')
        && (maybe.title == null || typeof maybe.title === 'string')
    );
}

export function readTerminalDetailsInstanceId(value: unknown, fallbackInstanceId: string | null = null): string | null {
    if (isTerminalDetailsResource(value)) {
        const terminalInstanceId = value.terminalInstanceId?.trim() ?? '';
        return terminalInstanceId.length > 0 ? terminalInstanceId : fallbackInstanceId;
    }
    if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'terminal') {
        return fallbackInstanceId;
    }
    return null;
}

export function readTerminalDetailsCwd(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const cwd = (value as { cwd?: unknown }).cwd;
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : null;
}

export function buildTerminalDetailsTabKey(terminalInstanceId: string): string {
    return `terminal:${terminalInstanceId}`;
}

export function resolveTerminalDetailsInstanceId(input: Readonly<{
    resource: unknown;
    tabKey?: string | null;
}>): string | null {
    if (isTerminalDetailsResource(input.resource)) {
        const terminalInstanceId = input.resource.terminalInstanceId?.trim() ?? '';
        if (terminalInstanceId.length > 0) {
            return terminalInstanceId;
        }
    }
    if (!input.resource || typeof input.resource !== 'object') return null;
    const maybe = input.resource as { kind?: unknown };
    if (maybe.kind !== 'terminal') return null;

    const tabKey = typeof input.tabKey === 'string' ? input.tabKey.trim() : '';
    if (tabKey.startsWith('terminal:')) {
        const instanceId = tabKey.slice('terminal:'.length).trim();
        return instanceId.length > 0 ? instanceId : null;
    }
    return tabKey.length > 0 ? tabKey : 'embedded';
}

export function isTerminalDetailsTab(input: Readonly<{
    resource: unknown;
    tabKey?: string | null;
}>): boolean {
    return resolveTerminalDetailsInstanceId(input) != null;
}

export function createTerminalDetailsTab(params: Readonly<{
    title: string;
    terminalInstanceId?: string | null;
    cwd?: string | null;
}>): DetailsTab & Readonly<{ resource: TerminalDetailsResource }> {
    const terminalInstanceId = params.terminalInstanceId?.trim() || randomUUID();
    const title = params.title;

    return {
        key: buildTerminalDetailsTabKey(terminalInstanceId),
        kind: 'terminal',
        title,
        resource: {
            kind: 'terminal',
            terminalInstanceId,
            cwd: params.cwd ?? null,
        },
    };
}
