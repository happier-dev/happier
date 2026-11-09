import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { isPromptStackSystemAppendPlacementV1 } from '@happier-dev/protocol/prompts/library/promptPlacementV1';
import {
    readSessionMemoryEnabledV1,
    SessionDisabledInheritedEntryIdsV1Schema,
    SessionPromptStackV1Schema,
    type SessionPromptStackEntryV1,
} from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { useActiveServerAccountScope, getStorage } from '@/sync/domains/state/storage';
import { usePromptStackEntryPresentations, type PromptStackEntryPresentation, type PromptStackEntryPresentationStatus } from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readCurrentProjectAccountRows, readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { resolveWorkspaceDisplayNameFromPath } from '@/sync/domains/workspaces/resolveWorkspaceDisplayNameFromPath';
import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';

export type SessionContextLayerId = 'account' | 'profile' | 'project' | 'session';
export type SessionContextRow = Readonly<{
    layer: SessionContextLayerId;
    /** Only Session entries can carry Plan; inherited layers retain their own schemas. */
    entry: SessionPromptStackEntryV1;
    title: string | null;
    kind: PromptStackEntryPresentation['kind'];
    presentationStatus: PromptStackEntryPresentationStatus;
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
    project: Readonly<{ status: 'none' | 'pending' | 'ready' | 'unavailable';
        /** Retained display content is readable while the owner refreshes; it grants no mutation authority. */
        refreshing: boolean; name: string | null; rows: readonly SessionContextRow[] }>;
    session: readonly SessionContextRow[];
    sessionStackValid: boolean;
}>;

const StoredStack = createStoredReadSchema(SessionPromptStackV1Schema);
const StoredDisabled = createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema);
const NO_ENTRIES: readonly PromptStackEntryV1[] = [];

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
 * Profile catalog, admitted Project rows/exact Source reader, the Session's `work` fields) and the resolver's
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
    // The Account sync/change owner admits and refreshes these rows. Display never starts a census.
    const [workspaceRows, organizationRows, projectOwnerStatus, projectCoverage] = getStorage()(useShallow(state => {
        const current = readCurrentProjectAccountRows(state);
        return [readProjectAccountWorkspaceRefs(state), current?.organizations, current?.status, current?.coverage] as const;
    }));

    const work = field(ownerMetadata, 'work');
    const path = text(field(ownerMetadata, 'path'));
    const machineId = resolveSessionMachineId(ownerMetadata);
    const projectAssociation = React.useMemo(() => resolveSessionProjectKeyV1(
        ownerMetadata && typeof ownerMetadata === 'object' && !Array.isArray(ownerMetadata) ? { ...ownerMetadata, machineId } : null,
        serverId, accountKnown ? workspaceRows : undefined, workspaceRefResolutionContextV1(),
    ), [accountKnown, machineId, ownerMetadata, serverId, workspaceRows]);
    const hasProject = accountKnown && projectAssociation.kind === 'resolved';
    const projectId = hasProject && projectAssociation.kind === 'resolved' ? projectAssociation.projectKey.projectKey : null;
    const sourceId = hasProject && projectAssociation.kind === 'resolved' ? projectAssociation.ref?.source?.sourceId ?? null : null;
    const source = useProjectSource(accountKnown ? activeLifetime : null, sourceId);
    const projectEntries = React.useMemo(() => {
        if (!hasProject || !workspaceRows) return NO_ENTRIES;
        const entries = sourceId ? source.source?.source.attachments?.flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : [])
            : organizationRows?.find(row => areServerProfileIdentifiersEquivalent(row.key.serverId, serverId)
                && row.key.projectKey === projectId)?.value.promptStack;
        return entries?.map(entry => ({ ...entry, ref: { ...entry.ref, serverId: entry.ref.serverId ?? serverId } })) ?? NO_ENTRIES;
    }, [hasProject, organizationRows, projectId, serverId, source.source, sourceId, workspaceRows]);
    const projectStatus: SessionContextLayers['project']['status'] = projectAssociation.kind === 'none' ? 'none'
        : !accountKnown || projectOwnerStatus === 'locked' || projectOwnerStatus === 'refused'
            || projectOwnerStatus === 'error' && !workspaceRows
            || projectOwnerStatus === 'ready' && (projectCoverage !== 'complete' || projectAssociation.kind !== 'resolved') ? 'unavailable'
            : !workspaceRows ? 'pending'
                : projectAssociation.kind !== 'resolved' || !projectAssociation.ref ? 'unavailable'
                    : sourceId && !source.source ? source.status === 'initial' || source.status === 'loading' ? 'pending' : 'unavailable'
                        : 'ready';
    const projectRefreshing = projectStatus === 'ready'
        && (projectOwnerStatus !== 'ready' || sourceId !== null && source.status !== 'ready');

    const stack = React.useMemo(() => StoredStack.safeParse(field(work, 'promptStack') ?? []), [work]);
    const entries = React.useMemo(() => [...(coding.value?.entries ?? NO_ENTRIES), ...(profile?.promptStack ?? NO_ENTRIES),
        ...projectEntries, ...(stack.success ? stack.data : NO_ENTRIES)],
        [coding.value?.entries, profile?.promptStack, projectEntries, stack]);
    const presentations = usePromptStackEntryPresentations(entries, serverId);
    return React.useMemo((): SessionContextLayers => {
        const memoryEnabled = readSessionMemoryEnabledV1(ownerMetadata);
        const isBot = readSessionBotV1(field(ownerMetadata, 'bot') ?? field(work, 'bot')) !== null;
        const disabledParse = StoredDisabled.safeParse(field(work, 'disabledInheritedEntryIds') ?? []);
        const disabled = new Set(disabledParse.success ? disabledParse.data : []);
        const rows = (layer: SessionContextLayerId, entries: readonly PromptStackEntryV1[]): SessionContextRow[] => entries
            // Composer inserts are picked by hand in the composer; they are not read before a turn.
            .filter((entry) => isPromptStackSystemAppendPlacementV1(entry.placement))
            .map((entry) => {
                const { kind, title } = presentations(entry);
                const presentationStatus = presentations.status(entry);
                const off = !entry.enabled ? (layer === 'session' ? 'session' : 'source')
                    : layer !== 'session' && disabled.has(entry.id) ? 'session'
                        : kind === 'memory' && !memoryEnabled ? 'memory' : null;
                return { layer, entry, kind, presentationStatus, off,
                    on: presentationStatus !== 'unavailable' && off === null, title,
                    currentPresentation: () => presentations(entry) };
            });
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
                status: projectStatus,
                refreshing: projectRefreshing,
                name: path ? resolveWorkspaceDisplayNameFromPath(path) : null,
                rows: rows('project', projectEntries),
            },
            session: rows('session', stack.success ? stack.data : NO_ENTRIES),
            sessionStackValid: stack.success,
        };
    }, [activeLifetime, accountKnown, presentations, stack, coding.status, coding.value?.entries, ownerMetadata, path, profileId, profileCatalog.status, profileCatalog.selectedProfile, profile?.name, profile?.promptStack, projectStatus, projectRefreshing, projectEntries, work]);
}
