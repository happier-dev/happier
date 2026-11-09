import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { PLUGIN_MANIFEST as elevenlabs } from '../../../../../../../packages/plugins/elevenlabs/src/manifest';
import { PLUGIN_MANIFEST as xai } from '../../../../../../../packages/plugins/xai/src/manifest';

import { resolveConnectSheetKeyPresentation } from './connectSheetKeyPresentation';

const providers = [elevenlabs, xai].flatMap(manifest => (manifest.contributes.voiceProviders ?? []).map(raw => ({
    pluginId: manifest.id, declaration: VoiceProviderContributionSchema.parse(raw),
})));
const localize = (text: unknown) => (typeof text === 'string' ? text : (text as { fallback: string }).fallback);

describe('resolveConnectSheetKeyPresentation', () => {
    it.each(providers.map(provider => [provider.pluginId, provider] as const))('gives %s its mark, purpose and console guide from its declaration', (_id, provider) => {
        const presentation = resolveConnectSheetKeyPresentation({
            bindingTarget: { kind: 'voice', contribution: { pluginId: provider.pluginId, localId: provider.declaration.id }, slot: provider.declaration.credentials!.slot.id },
            providers, localize,
        });
        expect(presentation?.pluginId).toBe(provider.pluginId);
        expect(presentation?.purpose).toBeTruthy();
        expect(presentation?.guide?.consoleUrl).toMatch(/^https:\/\//u);
        expect(presentation?.guide?.steps?.length).toBeGreaterThan(0);
    });

    it('leaves a bare secret and an unknown contribution without presentation', () => {
        expect(resolveConnectSheetKeyPresentation({ providers, localize })).toBeNull();
        expect(resolveConnectSheetKeyPresentation({ providers, localize,
            bindingTarget: { kind: 'voice', contribution: { pluginId: 'acme.voice', localId: 'gone' }, slot: 'api_key' } })).toBeNull();
    });
});
