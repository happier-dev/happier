import { getMachineRetentionCategoryDefaultV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { Settings } from '@/sync/domains/settings/settings';

import { categoryBinding } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

/** One declaration supplies search, Settings Actions and the later Defaults screen's rows. */
export const MACHINES_DEFAULTS_SETTINGS = defineSettingsPage({
    pageId: 'machines',
    subpage: { id: 'defaults', route: SETTINGS_ROUTES.machineDefaults, titleKey: 'settingsMachines.defaultsTitle' },
    sections: {
        categories: {
            titleKey: 'managedRetention.noWorkTitle', descriptionKey: 'managedRetention.noWorkDescription',
            settings: {
                local: { storage: categoryBinding('local') },
                runningOnly: { storage: categoryBinding('running-only') },
                stoppedBilled: { storage: categoryBinding('stopped-billed') },
                unknown: { storage: categoryBinding('unknown') },
            },
        },
        creation: {
            titleKey: 'managedMachines.creation.sectionTitle',
            settings: {
                creationEnabled: {},
            },
        },
    },
});

/** Pure read model: the visual lane binds the Account setting's existing narrow subscription. */
export function readMachineRetentionDefaultsModel(settings: Pick<Settings, 'machineRetentionDefaultsV1'>) {
    return ([
        ['local', 'local'], ['running-only', 'runningOnly'],
        ['stopped-billed', 'stoppedBilled'], ['unknown', 'unknown'],
    ] as const).map(([category, settingId]) => ({
        category,
        setting: MACHINES_DEFAULTS_SETTINGS.settings[settingId],
        inherited: settings.machineRetentionDefaultsV1[category] === undefined,
        policy: settings.machineRetentionDefaultsV1[category] ?? getMachineRetentionCategoryDefaultV1(category),
    }));
}
