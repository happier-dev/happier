import type { Machine, Session } from '@/sync/domains/state/storageTypes';

export type SessionListViewItem =
    | {
        type: 'header';
        title: string;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'project' | 'pinned';
        groupKey?: string;
        serverId?: string;
        serverName?: string;
        machine?: Machine;
        subtitle?: string;
    }
    | {
        type: 'session';
        session: Session;
        section?: 'active' | 'inactive';
        groupKey?: string;
        groupKind?: 'active' | 'date' | 'project' | 'pinned';
        pinned?: boolean;
        variant?: 'default' | 'no-path';
        serverId?: string;
        serverName?: string;
    };

export interface BuildSessionListViewDataOptions {
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    serverScope?: {
        serverId: string;
        serverName?: string;
    };
}

function isSessionActive(session: { active: boolean }): boolean {
    return session.active;
}

function resolveGroupingForSection(
    section: 'active' | 'inactive',
    options: BuildSessionListViewDataOptions,
): 'project' | 'date' {
    if (section === 'active') {
        return options.activeGroupingV1 ?? 'project';
    }
    if (options.inactiveGroupingV1) return options.inactiveGroupingV1;
    return options.groupInactiveSessionsByProject ? 'project' : 'date';
}

function formatPathRelativeToHome(path: string, homeDir?: string | null): string {
    if (!homeDir) return path;

    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    const isInHome = path === normalizedHome || path.startsWith(`${normalizedHome}/`);
    if (!isInHome) {
        return path;
    }

    const relativePath = path.slice(normalizedHome.length);
    return relativePath ? `~${relativePath}` : '~';
}

function makeUnknownMachine(id: string): Machine {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function normalizeServerIdForKey(serverId?: string): string {
    const normalized = String(serverId ?? '').trim();
    return normalized || '__unknown_server__';
}

function formatYyyyMmDdLocal(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function hashFNV1a32Hex(input: string): string {
    // FNV-1a 32-bit. Used to avoid persisting raw local paths in synced keys.
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

type ProjectGroup = {
    key: string;
    displayPath: string;
    machine: Machine;
    latestCreatedAt: number;
    sessions: Session[];
};

function compareSessionsStableNewestFirst(a: Session, b: Session): number {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
}

function groupSessionsByProject(params: Readonly<{
    sessions: ReadonlyArray<Session>;
    machines: Record<string, Machine>;
}>): ProjectGroup[] {
    const groups = new Map<string, ProjectGroup>();

    for (const session of params.sessions) {
        const machineId = session.metadata?.machineId || 'unknown';
        const path = session.metadata?.path || '';
        const key = `${machineId}:${path}`;

        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, {
                key,
                displayPath: path ? formatPathRelativeToHome(path, session.metadata?.homeDir) : '',
                machine: params.machines[machineId] ?? makeUnknownMachine(machineId),
                latestCreatedAt: session.createdAt,
                sessions: [session],
            });
        } else {
            existing.sessions.push(session);
            existing.latestCreatedAt = Math.max(existing.latestCreatedAt, session.createdAt);
        }
    }

    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
        if (b.latestCreatedAt !== a.latestCreatedAt) return b.latestCreatedAt - a.latestCreatedAt;
        if (a.displayPath !== b.displayPath) return a.displayPath.localeCompare(b.displayPath);
        return a.key.localeCompare(b.key);
    });

    for (const group of sortedGroups) {
        group.sessions.sort(compareSessionsStableNewestFirst);
    }

    return sortedGroups;
}

function pushProjectGroupsToList(params: Readonly<{
    listData: SessionListViewItem[];
    groups: ReadonlyArray<ProjectGroup>;
    section: 'active' | 'inactive';
    serverKey: string;
    serverScopeMeta: Record<string, unknown>;
}>): void {
    for (const group of params.groups) {
        const hasGroupHeader = Boolean(group.displayPath);
        const groupKey = `server:${params.serverKey}:${params.section}:project:${hashFNV1a32Hex(group.key)}`;

        if (hasGroupHeader) {
            params.listData.push({
                type: 'header',
                title: group.displayPath,
                headerKind: 'project',
                groupKey,
                machine: group.machine,
                subtitle: group.machine.metadata?.displayName || group.machine.metadata?.host || group.machine.id,
                ...(params.serverScopeMeta as any),
            });
        }

        const variant: 'default' | 'no-path' = hasGroupHeader ? 'no-path' : 'default';
        group.sessions.forEach((session) => {
            params.listData.push({
                type: 'session',
                session,
                section: params.section,
                groupKey,
                groupKind: 'project',
                variant,
                ...(params.serverScopeMeta as any),
            });
        });
    }
}

function pushDateGroupsToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<Session>;
    section: 'active' | 'inactive';
    serverKey: string;
    serverScopeMeta: Record<string, unknown>;
}>): void {
    if (params.sessions.length === 0) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;

    const flush = () => {
        if (currentDateGroup.length === 0 || !currentDateString) return;

        const groupDate = new Date(currentDateString);
        const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

        let headerTitle: string;
        if (sessionDateOnly.getTime() === today.getTime()) {
            headerTitle = 'Today';
        } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
            headerTitle = 'Yesterday';
        } else {
            const diffTime = today.getTime() - sessionDateOnly.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            headerTitle = `${diffDays} days ago`;
        }

        const groupKey = `server:${params.serverKey}:${params.section}:day:${formatYyyyMmDdLocal(sessionDateOnly)}`;
        params.listData.push({ type: 'header', title: headerTitle, headerKind: 'date', groupKey, ...(params.serverScopeMeta as any) });
        currentDateGroup.forEach((sess) => {
            params.listData.push({
                type: 'session',
                session: sess,
                section: params.section,
                groupKey,
                groupKind: 'date',
                ...(params.serverScopeMeta as any),
            });
        });
    };

    for (const session of params.sessions) {
        const sessionDate = new Date(session.createdAt);
        const dateString = sessionDate.toDateString();

        if (currentDateString !== dateString) {
            flush();
            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }

    flush();
}

export function buildSessionListViewData(
    sessions: Record<string, Session>,
    machines: Record<string, Machine>,
    options: BuildSessionListViewDataOptions
): SessionListViewItem[] {
    const serverScopeMeta = options.serverScope
        ? {
            serverId: options.serverScope.serverId,
            serverName: options.serverScope.serverName,
        }
        : {};
    const activeSessions: Session[] = [];
    const inactiveSessions: Session[] = [];

    Object.values(sessions).forEach((session) => {
        // Hide system sessions from user-facing lists by default.
        if (session.metadata?.systemSessionV1?.hidden === true) {
            return;
        }
        if (isSessionActive(session)) {
            activeSessions.push(session);
        } else {
            inactiveSessions.push(session);
        }
    });

    activeSessions.sort(compareSessionsStableNewestFirst);
    inactiveSessions.sort(compareSessionsStableNewestFirst);

    const listData: SessionListViewItem[] = [];

    if (activeSessions.length > 0) {
        const serverKey = normalizeServerIdForKey(options.serverScope?.serverId);
        const grouping = resolveGroupingForSection('active', options);
        listData.push({ type: 'header', title: 'Active', headerKind: 'active', ...serverScopeMeta });

        if (grouping === 'project') {
            pushProjectGroupsToList({
                listData,
                groups: groupSessionsByProject({ sessions: activeSessions, machines }),
                section: 'active',
                serverKey,
                serverScopeMeta,
            });
        } else {
            pushDateGroupsToList({
                listData,
                sessions: activeSessions,
                section: 'active',
                serverKey,
                serverScopeMeta,
            });
        }
    }

    if (inactiveSessions.length > 0) {
        const serverKey = normalizeServerIdForKey(options.serverScope?.serverId);
        const grouping = resolveGroupingForSection('inactive', options);
        listData.push({ type: 'header', title: 'Inactive', headerKind: 'inactive', ...serverScopeMeta });

        if (grouping === 'project') {
            pushProjectGroupsToList({
                listData,
                groups: groupSessionsByProject({ sessions: inactiveSessions, machines }),
                section: 'inactive',
                serverKey,
                serverScopeMeta,
            });
        } else {
            pushDateGroupsToList({
                listData,
                sessions: inactiveSessions,
                section: 'inactive',
                serverKey,
                serverScopeMeta,
            });
        }
    }

    return listData;
}
