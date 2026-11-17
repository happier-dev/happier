import { t } from '@/text';
import type { StoreKind } from './storeKinds';

/** Native kind words have one owner across directories, Discover and filter labels. */
export function kindCopy(kind: StoreKind | 'bot'): Readonly<{ title: string; description: string; search: string }> {
    switch (kind) {
        case 'theme': return { title: t('themeStore.title'), description: t('themeStore.description'), search: t('themeStore.search') };
        case 'bot': return { title: t('bots.title'), description: t('botTemplates.storeDescription'), search: t('botTemplates.storeSearch') };
        case 'app': return { title: t('capabilities.store.kinds.app.title'), description: t('capabilities.store.kinds.app.description'), search: t('capabilities.store.kinds.app.search') };
        case 'starter': return { title: t('capabilities.store.kinds.starter.title'), description: t('capabilities.store.kinds.starter.description'), search: t('capabilities.store.kinds.starter.search') };
        case 'browserExtension': return { title: t('capabilities.store.kinds.browserExtension.title'), description: t('capabilities.store.kinds.browserExtension.description'), search: t('capabilities.store.kinds.browserExtension.search') };
        case 'software': return { title: t('capabilities.store.kinds.software.title'), description: t('capabilities.store.softwarePage.description'), search: t('capabilities.store.softwarePage.search') };
        case 'mcpServer': return { title: t('capabilities.store.kinds.mcpServer.title'), description: t('capabilities.store.kinds.mcpServer.description'), search: t('capabilities.store.kinds.mcpServer.search') };
        case 'skill': return { title: t('capabilities.store.kinds.skill.title'), description: t('capabilities.store.kinds.skill.description'), search: t('capabilities.store.kinds.skill.search') };
        case 'agent': return { title: t('capabilities.store.kinds.agent.title'), description: t('capabilities.store.kinds.agent.description'), search: t('capabilities.store.kinds.agent.search') };
        case 'provider': return { title: t('capabilities.store.kinds.provider.title'), description: t('capabilities.store.kinds.provider.description'), search: t('capabilities.store.kinds.provider.search') };
        case 'plugin': return { title: t('capabilities.store.kinds.plugin.title'), description: t('capabilities.store.kinds.plugin.description'), search: t('capabilities.store.kinds.plugin.search') };
    }
}
