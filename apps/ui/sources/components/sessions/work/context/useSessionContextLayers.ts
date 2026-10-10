import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import {
    readSessionMemoryEnabledV1,
    SessionDisabledInheritedEntryIdsV1Schema,
    SessionPromptStackV1Schema,
} from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { useActiveServerAccountScope, getStorage } from '@/sync/domains/state/storage';
import { usePromptStackEntryPresentations, type PromptStackEntryPresentation } from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { captureActiveServerAccountScopeCurrentness, captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { resolveWorkspaceDisplayNameFromPath } from '@/sync/domains/workspaces/resolveWorkspaceDisplayNameFromPath';
import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';

export type SessionContextLayerId = 'account' | 'profile' | 'project' | 'session';
export type SessionContextRow = Readonly<{
    layer: SessionContextLayerId;
    entry: PromptStackEntryV1;
    title: string | null;
    kind: PromptStackEntryPresentation['kind'];
    /** Recheck the same qualified header owner before acting on a rendered row. */
    currentPresentation: () => PromptStackEntryPresentation;
    /** Read on the next turn: enabled at its source, not switched off here, and memory is on for memory. */
    on: boolean;
    /** Why it is not read: off where it was added, off for this Session, or the Session's memory is off. */
    off: 'source' | 'session' | 'memory' | null;
}>;
export type SessionContextLayers = Readonly<{
    /** This device holds the Session Home's Account, so its Account and Profile layers are known here. */
    accountKnown: boolean;
    accountStatus: 'pending' | 'ready' | 'unavailable';
    isBot: boolean;
    memoryEnabled: boolean;
    account: readonly SessionContextRow[];
    profile: Readonly<{ status: 'pending' | 'ready' | 'unavailable'; name: string | null; rows: readonly SessionContextRow[] }>;
    project: Readonly<{ status: 'none' | 'pending' | 'ready' | 'unavailable'; name: string | null; rows: readonly SessionContextRow[] }>;
    session: readonly SessionContextRow[];
    sessionStackValid: boolean;
}>;

const StoredStack = createStoredReadSchema(SessionPromptStackV1Schema);
const StoredDisabled = createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema);
const NO_ENTRIES: readonly PromptStackEntryV1[] = [];
type ProjectRead = Readonly<{ key: string; isCurrent: () => boolean; status: 'pending' | 'ready' | 'unavailable'; entries: readonly PromptStackEntryV1[] }>;

function field(metadata: unknown, key: string): unknown {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? Reflect.get(metadata, key) : undefined;
}
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * What an open Work pane shows as the Session's Context (lab `c-mem O`, plan 65 §2): the four layers
 * the prompt-stack resolver reads in order — Account, Profile, Project, Session — with each entry's
 * effective on/off. Display-only: it reuses the layers' own owners (the coding catalog row, the
 * Profile catalog, `readUiSessionProjectPromptStack`, the Session's `work` fields) and the resolver's
 * own switch rule; preparation never consumes this projection.
 */
export function useSessionContextLayers(params: Readonly<{
    sessionId: string;
    serverId: string;
    ownerMetadata: unknown;
    metadataVersion: number;
}>): SessionContextLayers {
    const { ownerMetadata, serverId } = params;
    const activeScope = useActiveServerAccountScope(serverId);
    const activeLifetime = captureActiveServerAccountScopeLifetime();
    const accountKnown = Boolean(activeScope && areServerProfileIdentifiersEquivalent(activeScope.serverId, serverId));
    const coding = usePromptLibraryCatalogValue('coding', accountKnown ? activeScope : null);
    const profileId = text(field(ownerMetadata, 'profileId'));
    const profileCatalog = useHomeAiLaunchProfileCatalog(accountKnown && profileId ? activeScope : null, profileId);
    // Retained raw rows remain readable display content; only the admitted selection establishes readiness.
    const profile = profileCatalog.selectedProfile ?? profileCatalog.profiles.find(candidate => candidate.id === profileId);
    // Observe stable owner rows, not its refresh status (our own read also publishes that status).
    const [workspaceRows, organizationRows, projectOwnerStatus, projectCoverage] = getStorage()(useShallow(state => {
        const current = readCurrentProjectAccountRows(state);
        return [current?.workspaceRefs, current?.organizations, current?.status, current?.coverage] as const;
    }));

    const work = field(ownerMetadata, 'work');
    const workspaceId = text(field(ownerMetadata, 'workspaceId'));
    const projectId = text(field(ownerMetadata, 'projectId'));
    const path = text(field(ownerMetadata, 'path'));
    const hasProject = accountKnown && (workspaceId !== null || projectId !== null);
    const projectKey = JSON.stringify([serverId, activeScope?.accountId, params.sessionId, workspaceId, projectId,
        resolveSessionMachineId(ownerMetadata), path]);
    const [projectRead, setProjectRead] = React.useState<ProjectRead | null>(null);
    const metadataRef = React.useRef(ownerMetadata);
    metadataRef.current = ownerMetadata;
    const versionRef = React.useRef(params.metadataVersion);
    versionRef.current = params.metadataVersion;
    React.useEffect(() => {
        if (!hasProject) return;
        const lifetime = captureActiveServerAccountScopeCurrentness();
        let controller: AbortController | null = null;
        const refresh = () => {
            if (!lifetime.isCurrent()) return;
            controller?.abort();
            const request = new AbortController();
            controller = request;
            setProjectRead((previous) => ({ key: projectKey, isCurrent: lifetime.isCurrent, status: 'pending',
                entries: previous?.key === projectKey && previous.isCurrent() ? previous.entries : NO_ENTRIES }));
            void (async () => {
                const metadata = metadataRef.current;
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
                try {
                    const [{ captureLazyActionAccountContext }, { readUiSessionProjectPromptStack }] = await Promise.all([
                        import('@/sync/ops/actions/actionAccountContext'),
                        import('@/sync/ops/actions/readUiMemoryInheritedContext'),
                    ]);
                    const account = await captureLazyActionAccountContext(serverId, request.signal);
                    try {
                        const context: ActionExecutorContext = { serverId, surface: 'ui', signal: request.signal };
                        const entries = await readUiSessionProjectPromptStack(account,
                            { metadata: { ...metadata }, revision: versionRef.current }, context);
                        if (!request.signal.aborted && lifetime.isCurrent()) setProjectRead({ key: projectKey, isCurrent: lifetime.isCurrent, status: 'ready', entries });
                    } finally {
                        account.dispose();
                    }
                } catch {
                    if (!request.signal.aborted && lifetime.isCurrent()) {
                        setProjectRead((previous) => ({ key: projectKey, isCurrent: lifetime.isCurrent, status: 'unavailable',
                            entries: previous?.key === projectKey && previous.isCurrent() ? previous.entries : NO_ENTRIES }));
                    }
                }
            })();
        };
        const retirement = lifetime.onRetire(() => { controller?.abort(); setProjectRead(null); });
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) refresh();
        });
        refresh();
        return () => { controller?.abort(); retirement.dispose(); unsubscribe(); };
    }, [activeLifetime, hasProject, projectKey, serverId, workspaceRows, organizationRows]);

    const stack = React.useMemo(() => StoredStack.safeParse(field(work, 'promptStack') ?? []), [work]);
    const entries = React.useMemo(() => [...(coding.value?.entries ?? NO_ENTRIES), ...(profile?.promptStack ?? NO_ENTRIES),
        ...(projectRead?.key === projectKey && projectRead.isCurrent() ? projectRead.entries : NO_ENTRIES), ...(stack.success ? stack.data : NO_ENTRIES)],
        [activeLifetime, coding.value?.entries, profile?.promptStack, projectRead, projectKey, stack]);
    const presentations = usePromptStackEntryPresentations(entries, serverId);
    return React.useMemo((): SessionContextLayers => {
        const memoryEnabled = readSessionMemoryEnabledV1(ownerMetadata);
        const isBot = readSessionBotV1(field(ownerMetadata, 'bot') ?? field(work, 'bot')) !== null;
        const disabledParse = StoredDisabled.safeParse(field(work, 'disabledInheritedEntryIds') ?? []);
        const disabled = new Set(disabledParse.success ? disabledParse.data : []);
        const rows = (layer: SessionContextLayerId, entries: readonly PromptStackEntryV1[]): SessionContextRow[] => entries
            // Composer inserts are picked by hand in the composer; they are not read before a turn.
            .filter((entry) => entry.placement === 'system_append' || entry.placement === 'skill_instructions')
            .map((entry) => {
                const { kind, title } = presentations(entry);
                const off = !entry.enabled ? 'source'
                    : layer !== 'session' && disabled.has(entry.id) ? 'session'
                        : kind === 'memory' && !memoryEnabled ? 'memory' : null;
                return { layer, entry, kind, off, on: kind !== 'unknown' && off === null, title,
                    currentPresentation: () => presentations(entry) };
            });
        const project = projectRead?.key === projectKey && projectRead.isCurrent() ? projectRead : null;
        return {
            accountKnown,
            accountStatus: coding.status === 'ready' ? 'ready' : coding.status === 'loading' ? 'pending' : 'unavailable',
            isBot,
            memoryEnabled,
            account: rows('account', coding.value?.entries ?? NO_ENTRIES),
            profile: { status: !profileId ? 'ready' : profileCatalog.status === 'loading' ? 'pending'
                : profileCatalog.status === 'ready' && profileCatalog.selectedProfile ? 'ready' : 'unavailable',
                name: profile?.name ?? null, rows: rows('profile', profile?.promptStack ?? NO_ENTRIES) },
            project: {
                status: !hasProject ? 'none'
                    : projectOwnerStatus === 'error' || projectOwnerStatus === 'locked' || projectOwnerStatus === 'refused'
                        || projectOwnerStatus === 'ready' && projectCoverage !== 'complete' ? 'unavailable'
                        : projectOwnerStatus === 'loading' || projectOwnerStatus === 'idle' ? 'pending' : project?.status ?? 'pending',
                name: path ? resolveWorkspaceDisplayNameFromPath(path) : null,
                rows: rows('project', project?.entries ?? NO_ENTRIES),
            },
            session: rows('session', stack.success ? stack.data : NO_ENTRIES),
            sessionStackValid: stack.success,
        };
    }, [activeLifetime, accountKnown, presentations, stack, coding.status, coding.value?.entries, hasProject, ownerMetadata, path, profileId, profileCatalog.status, profileCatalog.selectedProfile, profile?.name, profile?.promptStack, projectKey, projectRead, projectOwnerStatus, projectCoverage, work]);
}
