import { describe, expect, it, onTestFinished } from 'vitest';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';

describe('Summary settings catalog admission', () => {
    it('reads real offered model support and rejects catalog authority after the selected Agent is disabled', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        storage.setState({ settings: settingsDefaults });
        // Captured Account and storage are system boundaries; catalog, models and support remain real.
        const account = { serverId: 'test-home',
            accountLifetime: { scope: { serverId: 'test-home', accountId: 'test-account' },
                isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            assertCurrent() {}, readLiveSettings: () => settingsDefaults,
        };
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey }),
            backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey,
            acpCatalogSettingsV1: settingsDefaults.acpCatalogSettingsV1,
        });
        const choices = entries.flatMap(entry => buildScmDiffSummaryModelProfiles({
            backendTarget: readBackendTargetRefV2(entry.backendTarget),
            models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
            agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats,
        }));
        const offered = choices.find(profile => profile.structuredOutput === 'supported');
        if (!offered?.modelSelector?.backendTargetKey) throw new Error('Expected a genuinely supported bundled model');
        const reader = createScmDiffSummarySettingsCatalogReader(account);
        const catalog = await reader(settingsDefaults, offered.catalogId);
        expect(catalog?.profiles).toContainEqual(offered);
        expect(catalog?.isCurrent(settingsDefaults)).toBe(true);
        const disabled = { ...settingsDefaults, backendEnabledByTargetKey: {
            ...settingsDefaults.backendEnabledByTargetKey, [offered.modelSelector.backendTargetKey]: false,
        } };
        expect(catalog?.isCurrent(disabled)).toBe(false);
        expect(await reader(disabled, offered.catalogId)).toBeNull();
    });
});
