import {
    PluginBrowserTargetContributionV1Schema,
} from '@happier-dev/protocol/plugins/contributions/browser';
import type { BrowserAvailabilityDescriptor } from './actions.js';
import type { JsonValue } from '../identity.js';
import type { PluginLocalizedStringV2 } from '../manifest.js';

export type BrowserTargetContributionInput = Readonly<{
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    availability?: BrowserAvailabilityDescriptor;
    metadata?: Readonly<Record<string, JsonValue>>;
    url: string;
    launch?: 'newView' | 'currentView';
    profile?: 'ephemeral' | 'session' | 'user' | 'plugin';
}>;

export type BrowserTargetContribution = Omit<
    BrowserTargetContributionInput,
    'launch' | 'profile'
> & Readonly<{
    launch: 'newView' | 'currentView';
    profile: 'ephemeral' | 'session' | 'user' | 'plugin';
}>;

export function defineBrowserTarget<const TContribution extends BrowserTargetContributionInput>(
    contribution: TContribution,
): BrowserTargetContribution {
    return PluginBrowserTargetContributionV1Schema.parse(contribution);
}
