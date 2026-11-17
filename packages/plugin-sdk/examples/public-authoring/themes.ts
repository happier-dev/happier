import { definePlugin, type PluginThemeContributionV1 } from '@happier-dev/plugin-sdk';

/** Theme data is portable; plugin admission supplies its source and library identity. */
export const paperProfile = {
    schemaVersion: 1,
    id: 'paper',
    name: 'Paper',
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
    base: { light: 'light', dark: 'dark' },
    overrides: { light: {}, dark: {} },
    seeds: { canvas: '#ffffff', accent: '#2244aa' },
    style: { radius: 'sharp', fontFamily: 'Inter' },
    css: '[data-surface="button"][data-part="root"] { border-radius: 0; }',
} satisfies PluginThemeContributionV1['theme'];

/** One theme per contribution; a pack can include several without any runtime callback. */
export const themeAuthoring = definePlugin({
    id: 'org.example.palette',
    version: '1.0.0',
    displayName: 'Paper and Ink',
    themes: {
        paper: { theme: paperProfile },
        ink: { theme: { ...paperProfile, id: 'ink', name: 'Ink',
            seeds: { canvas: '#182028', accent: '#88aaff' }, style: { radius: 'round', fontFamily: 'Inter' } } },
    },
});
