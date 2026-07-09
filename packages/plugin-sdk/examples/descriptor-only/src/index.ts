import {
    definePluginManifest,
    type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

export const manifest = definePluginManifest({
    schemaVersion: 2,
    id: 'examples.descriptor-only',
    version: '0.1.0',
    displayName: 'Descriptor-Only Example',
    description: 'Pure manifest descriptor plugin with settings and permission review states.',
    engines: { happier: '^0.2.0' },
    uses: ['uiDescriptors'],
    entrypoints: { main: './dist/index.js' },
    permissions: {
        required: [
            {
                capability: 'filesystem.read',
                reason: 'Read project metadata for the descriptor preview.',
            },
        ],
        optional: [
            {
                capability: 'network',
                reason: 'Optionally validate links shown in the descriptor preview.',
            },
        ],
    },
    contributes: {
        uiDescriptors: [
            {
                id: 'examples.descriptorOnly.settings',
                surface: 'settings',
                title: 'Descriptor-only settings',
                description: 'Host-rendered settings declared in plugin.json.',
                tone: 'info',
                fields: [
                    { id: 'enabled', type: 'boolean', title: 'Enabled' },
                    {
                        id: 'mode',
                        type: 'select',
                        title: 'Mode',
                        options: [
                            { value: 'quiet', label: 'Quiet' },
                            { value: 'verbose', label: 'Verbose' },
                        ],
                    },
                ],
            },
        ],
    },
} satisfies PluginManifestV2);
