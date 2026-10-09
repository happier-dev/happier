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

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope, useArtifacts } from '@/sync/domains/state/storage';
import { resolveWorkspaceDisplayNameFromPath } from '@/sync/domains/workspaces/resolveWorkspaceDisplayNameFromPath';
import { useHomeAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

export type SessionContextLayerId = 'account' | 'profile' | 'project' | 'session';
export type SessionContextRow = Readonly<{
    layer: SessionContextLayerId;
    entry: PromptStackEntryV1;
    title: string | null;
    kind: 'memory' | 'doc' | 'skill';
    /** Read on the next turn: enabled at its source, not switched off here, and memory is on for memory. */
    on: boolean;
    /** Why it is not read: off where it was added, off for this Session, or the Session's memory is off. */
    off: 'source' | 'session' | 'memory' | null;
}>;
export type SessionContextLayers = Readonly<{
    /** This device holds the Session Home's Account, so its Account and Profile layers are known here. */
    accountKnown: boolean;
    isBot: boolean;
    memoryEnabled: boolean;
    account: readonly SessionContextRow[];
    profile: Readonly<{ name: string | null; rows: readonly SessionContextRow[] }>;
    project: Readonly<{ status: 'none' | 'pending' | 'ready' | 'unavailable'; name: string | null; rows: readonly SessionContextRow[] }>;
    session: readonly SessionContextRow[];
    sessionStackValid: boolean;
}>;

const StoredStack = createStoredReadSchema(SessionPromptStackV1Schema);
const StoredDisabled = createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema);
const NO_ENTRIES: readonly PromptStackEntryV1[] = [];
type ProjectRead = Readonly<{ key: string; status: 'pending' | 'ready' | 'unavailable'; entries: readonly PromptStackEntryV1[] }>;

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
    const activeScope = useActiveServerAccountScope();
    const settingsScope = useAccountSettingsScope();
    const accountKnown = Boolean(activeScope && areServerProfileIdentifiersEquivalent(activeScope.serverId, serverId));
    const coding = usePromptLibraryCatalogValue('coding', accountKnown ? undefined : null);
    const profileId = text(field(ownerMetadata, 'profileId'));
    const profiles = useHomeAiLaunchProfiles(accountKnown && profileId ? settingsScope : null);
    const profile = profileId ? profiles.find((candidate) => candidate.id === profileId) : undefined;
    const artifacts = useArtifacts();

    const work = field(ownerMetadata, 'work');
    const workspaceId = text(field(ownerMetadata, 'workspaceId'));
    const projectId = text(field(ownerMetadata, 'projectId'));
    const path = text(field(ownerMetadata, 'path'));
    const hasProject = accountKnown && (workspaceId !== null || projectId !== null);
    const projectKey = JSON.stringify([serverId, params.sessionId, workspaceId, projectId, path]);
    const [projectRead, setProjectRead] = React.useState<ProjectRead | null>(null);
    const metadataRef = React.useRef(ownerMetadata);
    metadataRef.current = ownerMetadata;
    const versionRef = React.useRef(params.metadataVersion);
    versionRef.current = params.metadataVersion;
    React.useEffect(() => {
        if (!hasProject) return;
        const controller = new AbortController();
        setProjectRead((previous) => ({ key: projectKey, status: 'pending', entries: previous?.key === projectKey ? previous.entries : NO_ENTRIES }));
        void (async () => {
            const metadata = metadataRef.current;
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
            try {
                const [{ captureLazyActionAccountContext }, { readUiSessionProjectPromptStack }] = await Promise.all([
                    import('@/sync/ops/actions/actionAccountContext'),
                    import('@/sync/ops/actions/readUiMemoryInheritedContext'),
                ]);
                const account = await captureLazyActionAccountContext(serverId, controller.signal);
                try {
                    const context: ActionExecutorContext = { serverId, surface: 'ui', signal: controller.signal };
                    const entries = await readUiSessionProjectPromptStack(account,
                        { metadata: { ...metadata }, revision: versionRef.current }, context);
                    if (!controller.signal.aborted) setProjectRead({ key: projectKey, status: 'ready', entries });
                } finally {
                    account.dispose();
                }
            } catch {
                if (!controller.signal.aborted) {
                    setProjectRead((previous) => ({ key: projectKey, status: 'unavailable',
                        entries: previous?.key === projectKey ? previous.entries : NO_ENTRIES }));
                }
            }
        })();
        return () => controller.abort();
    }, [hasProject, projectKey, serverId]);

    return React.useMemo((): SessionContextLayers => {
        const headers = new Map<string, Readonly<{ kind: unknown; title: unknown }>>();
        for (const artifact of artifacts) {
            headers.set(artifact.id, { kind: artifact.header?.kind, title: artifact.header?.title ?? artifact.title });
        }
        const memoryEnabled = readSessionMemoryEnabledV1(ownerMetadata);
        const isBot = readSessionBotV1(field(ownerMetadata, 'bot') ?? field(work, 'bot')) !== null;
        const stack = StoredStack.safeParse(field(work, 'promptStack') ?? []);
        const disabledParse = StoredDisabled.safeParse(field(work, 'disabledInheritedEntryIds') ?? []);
        const disabled = new Set(disabledParse.success ? disabledParse.data : []);
        const rows = (layer: SessionContextLayerId, entries: readonly PromptStackEntryV1[]): SessionContextRow[] => entries
            // Composer inserts are picked by hand in the composer; they are not read before a turn.
            .filter((entry) => entry.placement === 'system_append' || entry.placement === 'skill_instructions')
            .map((entry) => {
                const header = headers.get(entry.ref.artifactId);
                const kind = entry.ref.kind === 'bundle' ? 'skill' : header?.kind === 'memory_doc.v1' ? 'memory' : 'doc';
                const off = !entry.enabled ? 'source'
                    : layer !== 'session' && disabled.has(entry.id) ? 'session'
                        : kind === 'memory' && !memoryEnabled ? 'memory' : null;
                return { layer, entry, kind, off, on: off === null, title: typeof header?.title === 'string' && header.title ? header.title : null };
            });
        const project = projectRead?.key === projectKey ? projectRead : null;
        return {
            accountKnown,
            isBot,
            memoryEnabled,
            account: rows('account', coding.value?.entries ?? NO_ENTRIES),
            profile: { name: profile?.name ?? null, rows: rows('profile', profile?.promptStack ?? NO_ENTRIES) },
            project: {
                status: !hasProject ? 'none' : project?.status ?? 'pending',
                name: path ? resolveWorkspaceDisplayNameFromPath(path) : null,
                rows: rows('project', project?.entries ?? NO_ENTRIES),
            },
            session: rows('session', stack.success ? stack.data : NO_ENTRIES),
            sessionStackValid: stack.success,
        };
    }, [accountKnown, artifacts, coding.value?.entries, hasProject, ownerMetadata, path, profile?.name, profile?.promptStack, projectKey, projectRead, work]);
}
