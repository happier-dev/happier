import type { AgentAccountSettingsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ResolvedCatalogEntry } from '@/agent/catalog/types';
import { logger } from '@/utils/logger';
import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';
import { createStablePluginSettingsModels } from '@happier-dev/protocol/plugins/contributions/ui/settingsDescriptors';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

/** One projection for local application and the private same-build member launch frame. */
function projectAgentAccountSettingsApplication(input: Readonly<{
  pluginId: string;
  localAgentId: string;
  declarations: readonly PluginSettingsContributionV2[];
  settingLocalIds: readonly string[];
  pluginSettings: AgentCliSessionCommandPluginSettingsV1;
}>): AgentCliSessionCommandPluginSettingsV1 {
  const fields = createStablePluginSettingsModels({ pluginId: input.pluginId, contributions: input.declarations })
    .get('account')?.fields ?? [];
  const requested = new Set(input.settingLocalIds);
  const account = Object.fromEntries(fields.flatMap(({ id, descriptor }) => {
    if (!requested.has(id) || descriptor.secret || descriptor.target.kind !== 'agent'
      || descriptor.target.agent.pluginId !== input.pluginId
      || descriptor.target.agent.localId !== input.localAgentId
      || !Object.hasOwn(input.pluginSettings.account ?? {}, id)) return [];
    return [[id, StrictJsonValueSchema.parse(input.pluginSettings.account![id])]];
  }));
  return Object.freeze({ account: Object.freeze(account) });
}

/** Applies one admitted Agent's own Account settings to host-selected directories. */
export function projectAgentAccountSettingsCatalogEntry(params: Readonly<{
    accountSettings: AgentAccountSettingsContributionV1;
    pluginId: string;
    localAgentId: string;
    declarations: readonly import('@happier-dev/protocol').PluginSettingsContributionV2[];
    isCurrent(): boolean;
    resolvePluginSettings(): Promise<AgentCliSessionCommandPluginSettingsV1 | null>;
}>): Pick<ResolvedCatalogEntry, 'applyAccountSettings' | 'resolveAccountSettingsApplication'> {
    const resolveAccountSettingsApplication: NonNullable<ResolvedCatalogEntry['resolveAccountSettingsApplication']> = async context => {
        if (!params.isCurrent()) throw new Error('Agent Account settings generation is retired');
        // An explicit custody-bound snapshot never falls back to the daemon Account.
        const pluginSettings = context ? context.pluginSettings : await params.resolvePluginSettings();
        if (!params.isCurrent()) throw new Error('Agent Account settings generation is retired');
        return pluginSettings ? projectAgentAccountSettingsApplication({ ...params,
            settingLocalIds: params.accountSettings.settingLocalIds, pluginSettings }) : null;
    };
    return Object.freeze({
        resolveAccountSettingsApplication,
        applyAccountSettings: async (targets, context) => {
            const pluginSettings = await resolveAccountSettingsApplication(context);
            if (!pluginSettings) {
                logger.warn('[PLUGIN RUNTIME] Optional Agent Account settings are unavailable; application skipped');
                return { status: 'error', reason: 'provider_settings_failed' };
            }
            return StrictJsonValueSchema.parse(await params.accountSettings.apply({ pluginSettings, targets }));
        },
    });
}
