import { definePlugin } from '@happier-dev/plugin-sdk';
import { BOT_TEMPLATES_BUNDLE_ID, bundledBotTemplateContributions } from './catalog.js';

export const { manifest: PLUGIN_MANIFEST } = definePlugin({
    id: BOT_TEMPLATES_BUNDLE_ID,
    version: '0.0.0',
    displayName: 'Bot templates',
    description: 'Ready-made Bots from Happier.',
    botTemplates: bundledBotTemplateContributions,
});

export const manifest = PLUGIN_MANIFEST;
