import * as React from 'react';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { getVoiceContributedSettingsDeclarations, voiceSettingsDeclarationRegistry } from './voiceContributedSettingsDeclarations';

export function useVoiceContributedSettingsDeclarations(pageId: 'voiceDictation' | 'voiceConversations') {
    const localize = useProjectedPluginLocalizedTextResolver();
    const revision = React.useSyncExternalStore(
        voiceSettingsDeclarationRegistry.subscribe ?? (() => () => {}),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
    );
    return React.useMemo(() => getVoiceContributedSettingsDeclarations(voiceSettingsDeclarationRegistry, localize)
        .filter((page) => page.pageId === pageId), [localize, pageId, revision]);
}

/** The renderer consumes the same admitted fields and route identities as search and Actions. */
export function useVoiceContributedSettingRefs(providerId: string): (path: string) => SettingRef | undefined {
    const pathname = usePathname();
    const declarations = useVoiceContributedSettingsDeclarations(pathname === SETTINGS_ROUTES.voiceDictation ? 'voiceDictation' : 'voiceConversations');
    const declaration = declarations.find((page) => page.sections[`provider.${providerId}`]);
    return React.useCallback((path) => declaration?.settings[`provider.${providerId}.${path}`], [declaration, providerId]);
}
