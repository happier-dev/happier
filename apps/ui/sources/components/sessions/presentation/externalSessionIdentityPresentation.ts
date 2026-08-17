import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

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

export function resolveExternalSessionBrowseCandidateIdentityPresentation(
    input: Readonly<{
        remoteSessionId: string;
        title?: string;
        path: string | null;
        homeDir?: string | null;
        agentLabel?: string | null;
        machineLabel?: string | null;
    }>,
): ExternalSessionBrowseCandidateIdentityPresentation {
    const candidateTitle = typeof input.title === 'string' ? input.title.trim() : '';
    const meaningfulTitle = candidateTitle && candidateTitle !== input.remoteSessionId
        ? candidateTitle
        : null;
    const pathLabel = input.path
        ? formatPathRelativeToHome(input.path, input.homeDir ?? undefined).trim() || null
        : null;
    const identityLabel = joinDistinctIdentityLabels([input.agentLabel, input.machineLabel]);
    return {
        title: meaningfulTitle ?? pathLabel ?? input.remoteSessionId,
        pathLabel,
        identityLabel,
        secondaryLabel: joinDistinctIdentityLabels([
            identityLabel,
            meaningfulTitle ? pathLabel : null,
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
