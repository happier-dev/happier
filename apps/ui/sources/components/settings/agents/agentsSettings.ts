import { agentDefaultPermissionStorage, agentEnabledStorage, agentExecutableSourceStorage,
    agentIdleCompactionStorage, agentIdleCompactionMinContextTokensStorage, agentIdleCompactionCacheWindowOverrideMsStorage,
} from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * Search keeps the explicit selected Agent address; it never chooses an Agent for the reader.
 * `defaultModel` has no settings storage: its writer is `providers.defaults.set`.
 */
export const AGENT_SETTINGS = defineSettingsPage({
    pageId: 'agents',
    subpage: { id: 'detail', anchors: 'page', titleKey: 'settingsAgents.detailPage.sessionDefaultsTitle',
        route: context => /^\/(?:\(app\)\/)?settings\/agents\/(?:custom\/)?[^/]+$/.test(context.pathname) ? context.pathname : null },
    sections: {
        defaults: { settings: { defaultPermission: { storage: agentDefaultPermissionStorage }, defaultModel: {}, models: {},
            idleCompaction: { storage: agentIdleCompactionStorage },
            'idleCompaction.minContextTokens': { storage: agentIdleCompactionMinContextTokensStorage },
            'idleCompaction.cacheWindowOverrideMs': { storage: agentIdleCompactionCacheWindowOverrideMsStorage },
        } },
        preferences: { settings: { enabled: { storage: agentEnabledStorage }, executableSource: { storage: agentExecutableSourceStorage } } },
    },
});
