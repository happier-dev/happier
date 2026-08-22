import { definePlugin } from '@happier-dev/plugin-sdk';

export const { manifest, activate } = definePlugin({
    id: 'com.example.echo',
    version: '0.1.0',
    entrypoints: { daemon: './dist/index.js' },
    actions: {
        echo: {
            title: 'Echo',
            execution: { target: 'daemon' },
            inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
            },
            async run(input) {
                return input;
            },
        },
    },
});
