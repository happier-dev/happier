import type { ProviderBoundModelRef } from '@happier-dev/protocol';

import { t } from '@/text';

import type { EmbedSummaryPart } from './embedDraft';

export type EmbedSummaryNames = Readonly<{
    modelName: (ref: ProviderBoundModelRef) => string | null;
    folderName: (folderId: string) => string | null;
}>;

function formatModels(models: readonly ProviderBoundModelRef[], names: EmbedSummaryNames): string {
    if (models.length === 1) return t('settingsEmbeds.summary.modelOnly', { name: names.modelName(models[0]!) ?? models[0]!.modelId });
    return t('settingsEmbeds.summary.models', { count: models.length });
}

/** One row line from the fixed-order facts (`listEmbedSummaryParts`); a folder that is gone says nothing. */
export function formatEmbedSummary(parts: readonly EmbedSummaryPart[], names: EmbedSummaryNames): string {
    return parts.flatMap((part) => {
        switch (part.kind) {
            case 'sites': return [t('settingsEmbeds.summary.sites', { count: part.count })];
            case 'viewOnly': return [t('settingsEmbeds.summary.viewOnly')];
            case 'approve': return [t('settingsEmbeds.summary.approve')];
            case 'send': return [t('settingsEmbeds.summary.send')];
            case 'sendAndApprove': return [t('settingsEmbeds.summary.sendAndApprove')];
            case 'models': return [formatModels(part.models, names)];
            case 'folder': {
                const name = names.folderName(part.folderId);
                return name ? [name] : [];
            }
        }
    }).join(' · ');
}
