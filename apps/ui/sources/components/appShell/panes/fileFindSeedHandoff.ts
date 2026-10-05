import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { TranscriptJumpTarget } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';

/** A travelling query is launch input for one file, never a tab resource or URL parameter. */
export type FileFindSeed = Readonly<{
    query: string;
    options: Readonly<{ matchCase: boolean; regex: boolean }>;
    target: Readonly<{ kind: 'file'; path: string; anchor?: FileTargetAnchor }>;
}>;

export type FileFindSeedDestination = Readonly<{
    host: 'session' | 'project';
    id: string;
    accountId: string;
    scope: WorkspaceScopeBase;
    path: string;
}>;
export type FileFindSeedHostDestination = Omit<FileFindSeedDestination, 'accountId'>;

export type ChatFindSeed = Readonly<{
    query: string;
    options: FileFindSeed['options'];
    target: TranscriptJumpTarget;
}>;
export type ChatFindSeedDestination = Readonly<{ sessionId: string; serverId: string; accountId: string }>;
export type ChatFindSeedHostDestination = Omit<ChatFindSeedDestination, 'accountId'>;

type SeedPayload =
    | Readonly<{ kind: 'file'; destination: FileFindSeedDestination; seed: FileFindSeed }>
    | Readonly<{ kind: 'chat'; destination: ChatFindSeedDestination; seed: ChatFindSeed }>;
type SeedRecord = SeedPayload & Readonly<{ authority: ServerAccountScopeLifetime; cancel(): void }>;

function destinationKey(destination: FileFindSeedDestination): string {
    return JSON.stringify([destination.host, destination.id, destination.accountId, destination.scope.serverId,
        destination.scope.machineId, destination.scope.rootPath, destination.path]);
}

/** Private memory owned by AppPaneProvider; leaves take an addressed seed exactly once. */
export function createFileFindSeedHandoff() {
    const seeds = new Map<string, SeedRecord>();
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    const findCurrent = (destination: FileFindSeedHostDestination) => [...seeds.values()].find((record): record is SeedRecord & { kind: 'file' } => {
        if (record.kind !== 'file') return false;
        const addressed = record.destination;
        return addressed.host === destination.host && addressed.id === destination.id && addressed.path === destination.path
            && addressed.scope.serverId === destination.scope.serverId && addressed.scope.machineId === destination.scope.machineId
            && addressed.scope.rootPath === destination.scope.rootPath && record.authority.isCurrent();
    });
    const findChatCurrent = (destination: ChatFindSeedHostDestination) => [...seeds.values()].find((record): record is SeedRecord & { kind: 'chat' } =>
        record.kind === 'chat' && record.destination.sessionId === destination.sessionId
        && record.destination.serverId === destination.serverId && record.authority.isCurrent());
    const stage = (key: string, value: SeedPayload, authority: ServerAccountScopeLifetime): (() => void) => {
        const serverId = value.kind === 'file' ? value.destination.scope.serverId : value.destination.serverId;
        if (!authority || !authority.isCurrent() || authority.scope.accountId !== value.destination.accountId
            || authority.scope.serverId !== serverId) return () => {};
        seeds.get(key)?.cancel();
        let retirement: Readonly<{ dispose(): void }> | undefined;
        const record: SeedRecord = { ...value, authority, cancel: () => {
            retirement?.dispose();
            if (seeds.get(key) === record) { seeds.delete(key); notify(); }
        } };
        seeds.set(key, record);
        retirement = authority.onRetire(record.cancel);
        notify();
        return record.cancel;
    };
    return {
        stage(destination: FileFindSeedDestination, seed: FileFindSeed, authority: ServerAccountScopeLifetime): () => void {
            if (destination.path !== seed.target.path) return () => {};
            return stage(destinationKey(destination), { kind: 'file', destination, seed }, authority);
        },
        peek(destination: FileFindSeedDestination): FileFindSeed | null {
            const record = seeds.get(destinationKey(destination));
            return record?.kind === 'file' && record.authority.isCurrent() ? record.seed : null;
        },
        take(destination: FileFindSeedDestination): FileFindSeed | null {
            const key = destinationKey(destination);
            const record = seeds.get(key);
            const seed = record?.kind === 'file' && record.authority.isCurrent() ? record.seed : null;
            record?.cancel();
            return seed;
        },
        peekCurrent(destination: FileFindSeedHostDestination): FileFindSeed | null {
            return findCurrent(destination)?.seed ?? null;
        },
        takeCurrent(destination: FileFindSeedHostDestination): Readonly<{ seed: FileFindSeed; authority: ServerAccountScopeLifetime }> | null {
            const record = findCurrent(destination);
            if (!record) return null;
            record.cancel();
            return { seed: record.seed, authority: record.authority };
        },
        stageChat(destination: ChatFindSeedDestination, seed: ChatFindSeed, authority: ServerAccountScopeLifetime): () => void {
            const key = JSON.stringify(['chat', destination.sessionId, destination.serverId, destination.accountId]);
            return stage(key, { kind: 'chat', destination, seed }, authority);
        },
        peekChatCurrent(destination: ChatFindSeedHostDestination): ChatFindSeed | null {
            return findChatCurrent(destination)?.seed ?? null;
        },
        takeChatCurrent(destination: ChatFindSeedHostDestination): Readonly<{ seed: ChatFindSeed; authority: ServerAccountScopeLifetime }> | null {
            const record = findChatCurrent(destination);
            if (!record) return null;
            record.cancel();
            return { seed: record.seed, authority: record.authority };
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        dispose(): void {
            for (const record of [...seeds.values()]) record.cancel();
            listeners.clear();
        },
    };
}

export type FileFindSeedHandoff = ReturnType<typeof createFileFindSeedHandoff>;

/** Both History entry points hand launch input to the same destination owner. */
export async function openChatWithFindSeed(input: Readonly<{
    handoff?: FileFindSeedHandoff;
    destination: ChatFindSeedHostDestination;
    seed?: ChatFindSeed;
    authority?: ServerAccountScopeLifetime | null;
    open(): void | Promise<void>;
}>) {
    let cancel: (() => void) | undefined;
    if (input.seed && input.authority?.isCurrent()) {
        cancel = input.handoff?.stageChat({ ...input.destination, accountId: input.authority.scope.accountId }, input.seed, input.authority);
    }
    try {
        await input.open();
    } catch (error) {
        cancel?.();
        throw error;
    }
}
