import { definePlugin } from '@happier-dev/plugin-sdk';

async function indexFile(_path: string): Promise<void> {
    // Replace this with the plugin's real long-running work. The operation
    // remains owned by the host while this promise is pending.
    await Promise.resolve();
}

export const { manifest, activate } = definePlugin({
    id: 'com.example.tracked-action',
    version: '0.1.0',
    entrypoints: { daemon: './dist/index.js' },
    actions: {
        'rebuild-index': {
            title: 'Rebuild index',
            description: 'Rebuilds a local index while reporting honest progress.',
            execution: { target: 'daemon' },
            surfaces: ['ui', 'cli'],
            operation: {
                version: 1,
                visibility: 'activity',
                progress: 'reported',
                presentation: { onStart: 'current' },
            },
            async run(_input, context) {
                const paths = ['notes.md', 'decisions.md'];

                context.operation?.update({
                    phase: 'discovering',
                    label: 'Discovering files',
                });

                for (const [index, path] of paths.entries()) {
                    await indexFile(path);
                    context.operation?.update({
                        phase: 'indexing',
                        label: 'Indexing files',
                        current: index + 1,
                        total: paths.length,
                    });
                }

                return { indexed: paths.length };
            },
        },
    },
});
