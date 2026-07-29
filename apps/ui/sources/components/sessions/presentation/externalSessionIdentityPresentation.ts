import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { t } from '@/text';

type ExternalSessionIdentityTranslationKey =
    | 'sessionsList.storageExternalFilter'
    | 'sessionsList.storagePersistedTab';

export type ExternalSessionIdentityPresentation = Readonly<{
    agentId: string | null;
    agentLabel: string | null;
    machineLabel: string | null;
    storageLabel: string;
    headerBadgeLabel: string | null;
    rowMetadataLabel: string | null;
}>;

export function resolveExternalSessionIdentityPresentation(
    metadata: unknown,
    translate: (key: ExternalSessionIdentityTranslationKey) => string = t,
): ExternalSessionIdentityPresentation {
    const externalSessionLink = readExternalSessionLink(metadata);
    if (!externalSessionLink) {
        return {
            agentId: null,
            agentLabel: null,
            machineLabel: null,
            storageLabel: translate('sessionsList.storagePersistedTab'),
            headerBadgeLabel: null,
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

    return {
        agentId: externalSessionLink.agentId,
        agentLabel,
        machineLabel,
        storageLabel,
        headerBadgeLabel: `${agentLabel} · ${machineLabel}`,
        rowMetadataLabel: `${storageLabel} · ${machineLabel}`,
    };
}
