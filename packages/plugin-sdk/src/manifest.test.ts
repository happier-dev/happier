import { describe, expect, expectTypeOf, it } from 'vitest';

import * as sdk from './index';
import type {
    PluginBackendContributionV2,
    PluginEventContributionV1,
    PluginManifestV2,
    PluginPermissionDeclarationV1,
    PluginRequestInterceptorContributionV1,
    PluginSystemToolContributionV1,
} from './index';

describe('definePluginManifest', () => {
    it('preserves manifest literals while using protocol-owned manifest types', () => {
        const input = {
            schemaVersion: 2,
            id: 'acme.sdk-helper',
            version: '1.0.0',
            displayName: 'SDK Helper',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1, capabilities: ['backends'] },
            capabilities: {
                permissions: [
                    {
                        capability: 'reviews.comments.write.direct',
                        reason: 'Write user-approved review comments directly.',
                    },
                ],
                optionalPermissions: [],
            },
            contributes: {
                events: [
                    {
                        id: 'review/comment-written',
                        payloadSchema: { type: 'object', additionalProperties: true },
                    },
                ],
                requestInterceptors: [
                    {
                        id: 'plugin-fetch-audit',
                        order: 100,
                        targets: [{ scope: 'plugin-fetch' }],
                    },
                ],
                systemTools: [
                    {
                        toolId: 'acme-tool',
                        displayName: 'Acme Tool',
                        source: 'system',
                        lookupNames: ['acme-tool'],
                        defaultArgs: [],
                    },
                ],
                backends: [],
            },
        } satisfies PluginManifestV2;

        const definePluginManifest = (sdk as Readonly<{
            definePluginManifest?: <const TManifest extends PluginManifestV2>(manifest: TManifest) => TManifest;
        }>).definePluginManifest;

        expect(definePluginManifest).toBeTypeOf('function');
        const manifest = definePluginManifest!(input);

        expect(manifest).toBe(input);
        expectTypeOf(manifest.id).toEqualTypeOf<'acme.sdk-helper'>();
        expectTypeOf(manifest.contributes.events[0]).toMatchTypeOf<PluginEventContributionV1>();
        expectTypeOf(manifest.contributes.requestInterceptors[0]).toMatchTypeOf<PluginRequestInterceptorContributionV1>();
        expectTypeOf(manifest.contributes.systemTools[0]).toMatchTypeOf<PluginSystemToolContributionV1>();
        expectTypeOf(manifest.contributes.backends).toMatchTypeOf<readonly PluginBackendContributionV2[]>();
        expectTypeOf(manifest.capabilities.permissions[0]).toMatchTypeOf<PluginPermissionDeclarationV1>();
    });
});
