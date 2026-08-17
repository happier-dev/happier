import {
    PluginBrowserActionContributionV1Schema,
} from '@happier-dev/protocol/plugins/contributions/browser';
import type { JsonValue } from '../identity.js';
import type { PluginLocalizedStringV2 } from '../manifest.js';

export type BrowserAvailabilityDescriptor = unknown;
export type BrowserContributionReference =
    | string
    | Readonly<{ pluginId: string; localId: string }>;

export type BrowserActionContributionInput = Readonly<{
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    availability?: BrowserAvailabilityDescriptor;
    metadata?: Readonly<Record<string, JsonValue>>;
    action: BrowserContributionReference;
    target: BrowserContributionReference;
    placement?: 'toolbar' | 'detailsPanel' | 'contextMenu';
    icon?: string;
    order?: number;
}>;

export type BrowserActionContribution = Omit<
    BrowserActionContributionInput,
    'placement'
> & Readonly<{
    placement: 'toolbar' | 'detailsPanel' | 'contextMenu';
}>;

export function defineBrowserAction<const TContribution extends BrowserActionContributionInput>(
    contribution: TContribution,
): BrowserActionContribution {
    return PluginBrowserActionContributionV1Schema.parse(contribution);
}
