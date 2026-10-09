import type { ExternalSessionCandidateThreadV1 } from '@happier-dev/protocol';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { t } from '@/text';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';

type ExternalSessionIdentityTranslationKey =
    | 'sessionsList.storageExternalFilter'
    | 'sessionsList.storagePersistedTab';

export type ExternalSessionIdentityPresentation = Readonly<{
    agentId: string | null;
    agentLabel: string | null;
    machineLabel: string | null;
    storageLabel: string;
    identityLabel: string | null;
    rowMetadataLabel: string | null;
}>;

export type ExternalSessionBrowseCandidateIdentityPresentation = Readonly<{
    title: string;
    pathLabel: string | null;
    identityLabel: string | null;
    /** What an internal thread is ("Reviewer", "Sub-agent of <parent>"); null for a top-level session. */
    threadLabel: string | null;
    secondaryLabel: string | null;
}>;

function joinDistinctIdentityLabels(labels: readonly (string | null | undefined)[]): string | null {
    const normalized = Array.from(new Set(labels
        .map((label) => label?.trim())
        .filter((label): label is string => Boolean(label))));
    return normalized.join(' · ') || null;
}

function joinIdentityLabels(labels: readonly (string | null | undefined)[]): string | null {
    return labels
        .map((label) => label?.trim())
        .filter((label): label is string => Boolean(label))
        .join(' · ') || null;
}

/** A UUID-shaped string: an Agent's session or thread id, never a name a person gave. */
const SESSION_ID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A title a person could recognize: never empty, never the session's own id, never id-shaped. */
function readMeaningfulTitle(title: string | undefined, remoteSessionId: string | null): string | null {
    const trimmed = typeof title === 'string' ? title.trim() : '';
    return trimmed && trimmed !== remoteSessionId && !SESSION_ID_SHAPED.test(trimmed) ? trimmed : null;
}

function resolveThreadLabel(thread: ExternalSessionCandidateThreadV1 | undefined): string | null {
    if (!thread) return null;
    const parent = readMeaningfulTitle(thread.parentTitle, thread.parentRemoteSessionId);
    if (thread.kind === 'reviewer') {
        return parent
            ? t('externalSessions.browseThreadReviewerOf', { parent })
            : t('externalSessions.browseThreadReviewer');
    }
    return parent
        ? t('externalSessions.browseThreadSubagentOf', { parent })
        : t('externalSessions.browseThreadSubagent');
}

/** The last six characters of an id, as a short hint that tells untitled sessions apart. */
function readShortIdHint(remoteSessionId: string): string | null {
    const compact = remoteSessionId.replace(/[^0-9a-z]/gi, '');
    return compact.length > 0 ? `…${compact.slice(-6)}` : null;
}

/**
 * How a Browse candidate is named. Its title is the Agent's title (the first meaningful user message
 * when the index has one); a candidate without one is an "Untitled session", like any other session
 * without a name, and its secondary line carries the hint that tells it apart: its project folder,
 * else a short id suffix. A raw session id is never the title. An internal thread leads that line with
 * what it is and, when its parent's title is known, whose thread it is.
 */
export function resolveExternalSessionBrowseCandidateIdentityPresentation(
    input: Readonly<{
        remoteSessionId: string;
        title?: string;
        path: string | null;
        homeDir?: string | null;
        agentLabel?: string | null;
        machineLabel?: string | null;
        thread?: ExternalSessionCandidateThreadV1;
    }>,
): ExternalSessionBrowseCandidateIdentityPresentation {
    const meaningfulTitle = readMeaningfulTitle(input.title, input.remoteSessionId);
    const threadLabel = resolveThreadLabel(input.thread);
    const pathLabel = input.path
        ? formatSessionPath(input.path, input.homeDir ?? undefined).trim() || null
        : null;
    const identityLabel = joinDistinctIdentityLabels([input.agentLabel, input.machineLabel]);
    return {
        title: meaningfulTitle ?? t('session.untitled'),
        pathLabel,
        identityLabel,
        threadLabel,
        secondaryLabel: joinDistinctIdentityLabels([
            threadLabel,
            identityLabel,
            meaningfulTitle ? pathLabel : pathLabel ?? readShortIdHint(input.remoteSessionId),
        ]),
    };
}

export function resolveExternalSessionIdentityPresentation(
    metadata: unknown,
    currentMachineId: unknown,
    translate: (key: ExternalSessionIdentityTranslationKey) => string = t,
): ExternalSessionIdentityPresentation {
    const externalSessionLink = readExternalSessionLink(metadata);
    if (!externalSessionLink) {
        return {
            agentId: null,
            agentLabel: null,
            machineLabel: null,
            storageLabel: translate('sessionsList.storagePersistedTab'),
            identityLabel: null,
            rowMetadataLabel: null,
        };
    }

    const agentLabel = resolveAgentCatalogProjection(externalSessionLink.agentId, {
        enabledAgentIds: [],
    }).title;
    const metadataRecord = metadata && typeof metadata === 'object'
        ? metadata as Readonly<Record<string, unknown>>
        : null;
    const host = typeof metadataRecord?.host === 'string' ? metadataRecord.host.trim() : '';
    const machineLabel = host || externalSessionLink.machineId;
    const storageLabel = translate('sessionsList.storageExternalFilter');
    const isCurrentMachine = typeof currentMachineId === 'string'
        && currentMachineId === externalSessionLink.machineId;

    const identityLabel = joinIdentityLabels([
        agentLabel,
        isCurrentMachine ? null : machineLabel,
    ]);
    const rowMetadataLabel = joinIdentityLabels([storageLabel, identityLabel]);
    return {
        agentId: externalSessionLink.agentId,
        agentLabel,
        machineLabel,
        storageLabel,
        identityLabel,
        rowMetadataLabel,
    };
}
