import { describe, expect, it } from 'vitest';

import { createProviderMessageMetaOverrideBuilderFromDescriptor } from './providerMessageMetaDescriptors';

describe('createProviderMessageMetaOverrideBuilderFromDescriptor', () => {
    it('adds a session config option override when no explicit meta override exists', () => {
        const { buildOverrides, diagnostics } = createProviderMessageMetaOverrideBuilderFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {},
            message: {
                metaOverrides: [
                    {
                        id: 'reasoning-effort',
                        targetKey: 'reasoningEffort',
                        value: {
                            kind: 'sessionConfigOptionOverride',
                            key: 'reasoning_effort',
                        },
                        normalize: 'trimLowercase',
                    },
                ],
            },
            components: { slots: [] },
        });

        expect(diagnostics).toEqual([]);
        expect(buildOverrides({
            session: {
                metadata: {
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        overrides: {
                            reasoning_effort: { value: ' HIGH ' },
                        },
                    },
                },
            },
            metaOverrides: {},
        })).toEqual({ reasoningEffort: 'high' });
    });

    it('does not materialize legacy descriptor ids without inline descriptor data', () => {
        const { buildOverrides, diagnostics } = createProviderMessageMetaOverrideBuilderFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {},
            message: {
                metaDescriptorIds: ['claude.reasoningEffort.v1'],
            },
            components: { slots: [] },
        });

        expect(buildOverrides({
            session: {
                metadata: {
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        overrides: {
                            reasoning_effort: { value: ' HIGH ' },
                        },
                    },
                },
            },
            metaOverrides: {},
        })).toEqual({});
        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'message.metaDescriptorIds.0',
        }));
    });

    it('fails closed for unsupported descriptor kinds', () => {
        const { buildOverrides, diagnostics } = createProviderMessageMetaOverrideBuilderFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {},
            message: {
                metaDescriptorIds: ['claude.unknownMeta.v1'],
            },
            components: { slots: [] },
        });

        expect(buildOverrides({ session: {}, metaOverrides: { keep: true } })).toEqual({ keep: true });
        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'message.metaDescriptorIds.0',
        }));
    });
});
