import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { commitPreferredLanguage, getPreferredLanguage } from '@/text/preferredLanguage';
import { preloadTranslations, tLoose } from '@/text';

import { clearProjectedAgentUiBehaviorDescriptors, publishProjectedAgentUiBehaviorDescriptors } from '../agentUiBehaviorProjection';
import { readNativeAgentComposerPlacementDefinitions } from './nativeComposerPlacement';

afterEach(() => { clearProjectedAgentUiBehaviorDescriptors(); });

describe('native Agent composer placement metadata', () => {
    it('reads generated and already-held Account declarations without chip factories and drops retired external declarations', async () => {
        const previousLanguage = getPreferredLanguage();
        onTestFinished(() => commitPreferredLanguage(previousLanguage));
        await Promise.all([preloadTranslations('en'), preloadTranslations('fr')]);
        commitPreferredLanguage('en');
        const scope = { serverId: 'srv_native_composer', accountId: 'native-composer-account' };
        const account = await activateStorageAccountScope(scope);
        onTestFinished(() => account.dispose());
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the canonical active Account fixture');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'already-described-machine', accountScope: scope, accountLifetime: lifetime,
            descriptorsByAgentId: {
                'acme.indexer': {
                    kind: 'plugin.ui.v1', pluginId: 'acme.indexer', agentId: 'acme.indexer', version: 1,
                    components: { slots: [{
                        id: 'external-indexing', slot: 'newSession.agentInputExtraActionChips',
                        chip: {
                            kind: 'booleanOption', optionStateKey: 'indexing', iconName: 'magnifying-glass',
                            onLabelKey: 'agentInput.auggieIndexingChip.on', offLabelKey: 'agentInput.auggieIndexingChip.off',
                        },
                    }] },
                },
            },
        });
        const read = () => readNativeAgentComposerPlacementDefinitions(scope);
        const definitions = read();
        expect(definitions).toEqual(expect.arrayContaining([
            expect.objectContaining({ controlId: 'providerOption', contexts: ['newSession'], placement: expect.objectContaining({ id: 'providerOption:auggie-allow-indexing' }) }),
            expect.objectContaining({ controlId: 'providerOption', contexts: ['newSession'], placement: expect.objectContaining({ id: 'providerOption:external-indexing', defaultPlacement: 'overflow' }) }),
        ]));
        const titleBefore = definitions.find(definition => definition.placement.id === 'providerOption:external-indexing')?.placement.title;
        expect(titleBefore).toBe(tLoose('agentInput.auggieIndexingChip.on'));
        commitPreferredLanguage('fr');
        const titleAfter = read().find(definition => definition.placement.id === 'providerOption:external-indexing')?.placement.title;
        expect(titleAfter).toBe(tLoose('agentInput.auggieIndexingChip.on'));
        expect(titleAfter).not.toBe(titleBefore);
        retireActiveServerAccountScopeLifetime();
        expect(read().some(definition => definition.placement.id === 'providerOption:external-indexing')).toBe(false);
    });
});
