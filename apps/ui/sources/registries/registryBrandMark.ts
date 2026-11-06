import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import { admitCatalogBrandMark } from '@/components/ui/media/catalogBrandMark';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';

/** Presentation-only augmentation; never serialized into registry Action input. */
export type RegistryCatalogItemSummary = RegistryItemSummaryV1 & Readonly<{ brandMark?: HostCatalogMark }>;

export function admitRegistrySummaryMark(summary: RegistryItemSummaryV1, previous?: RegistryCatalogItemSummary): RegistryCatalogItemSummary {
    return { ...summary, brandMark: admitCatalogBrandMark({ displayName: summary.title,
        iconUrl: summary.iconUrl, iconDarkUrl: summary.iconDarkUrl }, previous?.brandMark) };
}
