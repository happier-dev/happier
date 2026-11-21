import { definePlugin } from '@happier-dev/plugin-sdk';

export const { manifest, activate } = definePlugin({
    id: 'happier.asciinema',
    version: '0.1.0',
    engines: { happier: '>=0.3.0-0' },
    displayName: 'Asciinema',
    description: 'Play terminal recordings from .cast files.',
    openableContentViewers: {
        cast: { destination: 'recording', extensions: ['.cast'], contentClasses: ['text'] },
    },
    ui: {
        views: [{
            id: 'recording', title: 'Asciinema', container: 'detailsTab', target: { kind: 'session' },
            renderer: 'player', instancePolicy: 'singleton',
        }],
        renderers: [{
            id: 'player', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'player' },
            requiredHostMethods: ['context', 'statOpenableContent', 'readOpenableContent'],
        }],
    },
});
