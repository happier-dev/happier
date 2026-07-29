import { describe, expect, it } from 'vitest';

import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '../preview/registry';
import { createHostedWebStaticAssetPreviewResource } from './hostedWeb';

describe('hosted-web plugin local-service adapter', () => {
    it('registers canonical static asset server endpoints as plugin-owned local-service preview resources', () => {
        const resource = createHostedWebStaticAssetPreviewResource({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-1',
            machineId: 'machine-1',
            endpoint: {
                scheme: 'http',
                host: '127.0.0.1',
                port: 49152,
            },
            title: 'Preview web',
        });

        expect(resource).toMatchObject({
            previewId: 'plugin-static:acme.preview:preview-web:session-1:machine-1',
            owner: { kind: 'plugin', id: 'acme.preview' },
            target: {
                scheme: 'http',
                host: '127.0.0.1',
                port: 49152,
            },
            initialPath: { pathname: '/' },
            originMode: 'path',
        });

        const registry = createLocalServicePreviewRegistry();
        expect(registerLocalServicePreview(registry, resource)).toMatchObject({
            ok: true,
            resource: {
                browserTarget: {
                    kind: 'localServicePreview',
                    targetId: 'plugin-static:acme.preview:preview-web:session-1:machine-1',
                },
            },
        });
    });
});
