import {
    MachineRetentionPolicyV1Schema,
    updateMachineRetentionCategoryPreferenceV1,
    type MachineRetentionCategoryV1,
} from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { getMachineRetentionCategoryDefaultV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { defineSettingsPage, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { Settings } from '@/sync/domains/settings/settings';

function categoryBinding(category: MachineRetentionCategoryV1): SettingStorageBinding {
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: settings => settings.machineRetentionDefaultsV1[category] ?? null,
        parse: value => {
            if (value === null) return { success: true, value: null };
            const parsed = MachineRetentionPolicyV1Schema.safeParse(value);
            return parsed.success ? { success: true, value: parsed.data } : { success: false };
        },
        mutate: (settings, value) => ({
            machineRetentionDefaultsV1: updateMachineRetentionCategoryPreferenceV1(
                settings.machineRetentionDefaultsV1,
                category,
                value === null ? null : MachineRetentionPolicyV1Schema.parse(value),
            ),
        }),
    };
}

/** One declaration supplies search, Settings Actions and the later Defaults screen's rows. */
export const MACHINES_DEFAULTS_SETTINGS = defineSettingsPage({
    pageId: 'machines',
    subpage: { id: 'defaults', route: SETTINGS_ROUTES.machineDefaults, titleKey: 'settingsMachines.defaultsTitle' },
    sections: {
        categories: {
            titleKey: 'managedRetention.noWorkTitle', descriptionKey: 'managedRetention.noWorkDescription',
            settings: {
                local: { titleKey: 'settingsMachines.localVirtualMachines', storage: categoryBinding('local') },
                runningOnly: { titleKey: 'settingsMachines.runningOnly', storage: categoryBinding('running-only') },
                stoppedBilled: { titleKey: 'settingsMachines.stoppedBilled', storage: categoryBinding('stopped-billed') },
                unknown: { titleKey: 'settingsMachines.billingUnknown', storage: categoryBinding('unknown') },
            },
        },
        creation: {
            titleKey: 'managedMachines.creation.sectionTitle',
            settings: {
                creationEnabled: {
                    titleKey: 'managedMachines.creation.allow',
                    descriptionKey: 'managedMachines.creation.allowHelp',
                    storage: { scope: 'account', access: 'read_write', key: 'managedMachineCreationEnabled' },
                },
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
