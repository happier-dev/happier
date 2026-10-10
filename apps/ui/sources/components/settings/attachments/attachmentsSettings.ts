import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `attachments` page. Rows render their labels from these declarations. */
export const ATTACHMENTS_SETTINGS = defineSettingsPage({
    pageId: 'attachments',
    sections: {
        uploadLocation: {
            titleKey: 'settingsAttachments.uploadLocation.title',
            settings: {
                uploadLocation: {},
                uploadsDirectory: {},
            },
        },
        sourceControlIgnore: {
            titleKey: 'settingsAttachments.sourceControlIgnore.title',
            settings: {
                ignoreStrategy: {},
                writeIgnoreRules: {},
            },
        },
        limits: {
            titleKey: 'settingsAttachments.limits.title',
            settings: {
                maxAttachmentSize: {},
            },
        },
    },
});
