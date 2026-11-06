import { definePlugin } from '@happier-dev/plugin-sdk';

/** Cold packaged releases; previewing these descriptors never activates this plugin. */
export const botTemplateAuthoring = definePlugin({
    id: 'com.example.bot-templates',
    version: '1.0.0',
    displayName: 'Bot templates author reference',
    botTemplates: {
        researcher: { path: 'templates/researcher.json' },
        reviewer: { path: './templates/reviewer.json' },
    },
});
