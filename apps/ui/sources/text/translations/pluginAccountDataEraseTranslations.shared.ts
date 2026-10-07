

export const english = {
    accountDataErase: {
        installedGroupTitle: 'Account data',
        installedGroupFooter: 'This affects retained data for the current Account only. It does not uninstall this plugin from any machine.',
        installedEntryTitle: 'Erase Account data',
        installedEntrySubtitle: 'Permanently remove this plugin’s retained data from the current Account.',
        orphanedGroupTitle: 'Retained plugin data',
        orphanedGroupFooter: 'Use a plugin ID to remove retained Account data after a plugin has been removed.',
        orphanedEntryTitle: 'Erase retained plugin data',
        orphanedEntrySubtitle: 'Enter an installed or removed plugin ID to permanently erase its current Account data.',
        promptTitle: 'Plugin ID',
        promptBody: 'Enter the ID of the plugin whose retained data you want to erase from the current Account.',
        promptPlaceholder: 'com.example.plugin',
        invalidTitle: 'Enter a plugin ID',
        invalidBody: 'Use the exact plugin ID before continuing.',
        confirmTitle: 'Erase Account plugin data?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `This permanently removes retained data for ${pluginId} from the current Account. It does not uninstall the plugin from your machines.`,
        confirm: 'Erase data',
        completedTitle: 'Account plugin data erased',
        completedChanged: 'Retained plugin data has been removed from the current Account.',
        completedEmpty: 'No retained plugin data was found for this plugin in the current Account.',
        partialTitle: 'Some plugin data remains',
        partialBody: 'Some retained data could not be erased. Nothing will retry automatically; retry to erase the remaining data.',
        failedTitle: 'Plugin data was not erased',
        failedBody: 'The retained data could not be erased. Retry after checking the current Account connection.',
        unavailableTitle: 'Plugin data is unavailable',
        unavailableBody: 'The current Account changed or is unavailable. Reopen this action after the Account is ready.',
    },
} as const;


export const pluginAccountDataEraseTranslationsEnglish = { en: english } as const;