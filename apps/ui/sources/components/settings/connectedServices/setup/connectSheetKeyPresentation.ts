import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';

import type { ConnectedAccountGuideContent } from '../account/ConnectedAccountGuide';
import type { ConnectSheetKeyBindingTarget } from './connectSheetKeyBindings';

export type ConnectSheetKeyPresentation = Readonly<{
    pluginId: string;
    purpose: string;
    guide: ConnectedAccountGuideContent | null;
}>;

/**
 * What a key sheet says about the thing that asked for the key, from that thing's declaration. Decided
 * from the request's binding target, so every caller of a Voice key sheet gets it without passing it.
 */
export function resolveConnectSheetKeyPresentation(input: Readonly<{
    bindingTarget?: ConnectSheetKeyBindingTarget;
    providers: readonly Readonly<{ pluginId: string; declaration: VoiceProviderContribution }>[];
    localize: (text: PluginLocalizedStringV2, pluginId: string) => string;
}>): ConnectSheetKeyPresentation | null {
    const target = input.bindingTarget;
    if (target?.kind !== 'voice') return null;
    const provider = input.providers.find(({ pluginId, declaration }) =>
        pluginId === target.contribution.pluginId && declaration.id === target.contribution.localId);
    if (!provider) return null;
    const { pluginId, declaration } = provider;
    const presentation = declaration.settings?.presentation;
    const consoleUrl = presentation?.links.apiKeys;
    return {
        pluginId,
        purpose: 'description' in declaration && declaration.description ? input.localize(declaration.description, pluginId) : '',
        guide: consoleUrl ? {
            consoleUrl,
            steps: (presentation?.credential.checklist ?? []).map(step => input.localize(step, pluginId)),
        } : null,
    };
}
