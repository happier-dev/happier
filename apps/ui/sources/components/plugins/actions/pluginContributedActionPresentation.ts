import type { IconName } from '@/components/ui/icons/Icon';
import { ICON_REGISTRY } from '@/components/ui/icons/iconRegistry.generated';
import { PLUGIN_UI_ICON_FALLBACK } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';

/**
 * Plugin Action metadata is an open Protocol slug, whereas the application
 * bundles a deliberately curated icon registry. Keep that compatibility check
 * at the one render boundary rather than teaching callers a second catalog.
 */
export function resolvePluginContributedActionIconName(
    icon: string | null | undefined,
): IconName {
    return typeof icon === 'string' && Object.hasOwn(ICON_REGISTRY, icon)
        ? icon as IconName
        : PLUGIN_UI_ICON_FALLBACK;
}
