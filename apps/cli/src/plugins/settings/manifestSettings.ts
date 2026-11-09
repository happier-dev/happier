import type { ParsedPluginManifestV2 } from '@happier-dev/protocol';
import type { ResolvedNotificationChannelContribution } from '@/plugins/projection/registry/types';

import { admitLocalSettingsDeclarations } from './localSettingsContributions';
import { resolveNotificationChannelSettingsContributions } from './notificationChannelSettings';

/** One semantic Settings owner for author refusal and host contribution withdrawal. */
export function readPluginManifestSettingsErrors(manifest: ParsedPluginManifestV2) {
    const settings = manifest.contributes.settings.map(definition => ({ pluginId: manifest.id, definition }));
    const channels = resolveNotificationChannelSettingsContributions(manifest.contributes.notificationChannels.map(definition => ({
        pluginId: manifest.id, definition, provenance: 'external', source: { kind: 'path' },
    } satisfies ResolvedNotificationChannelContribution)));
    const { errors } = admitLocalSettingsDeclarations({ settings: [...settings, ...channels] });
    return errors;
}

export function assertPluginManifestSettingsValid(manifest: ParsedPluginManifestV2): void {
    const errors = readPluginManifestSettingsErrors(manifest);
    if (errors[0]) throw errors[0];
}
