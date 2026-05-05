export async function activate(api) {
    api.registerResource({
        kindVersion: 1,
        id: 'examples.ui.prompt',
        type: 'prompt',
        title: 'Example Review Prompt',
        path: 'resources/review-prompt.md',
        contentType: 'text/markdown'
    });

    api.registerUiDescriptor({
        kindVersion: 1,
        id: 'examples.ui.settings',
        surface: 'settings',
        title: 'Example Plugin Settings',
        description: 'Host-rendered descriptor registered during activation.',
        fields: [
            {
                id: 'enabled',
                kind: 'boolean',
                title: 'Enabled'
            },
            {
                id: 'profile',
                kind: 'select',
                title: 'Profile',
                options: [
                    { value: 'fast', label: 'Fast' },
                    { value: 'safe', label: 'Safe' }
                ]
            }
        ]
    });
}
