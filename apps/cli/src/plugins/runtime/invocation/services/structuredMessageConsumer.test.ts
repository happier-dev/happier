import { describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

import {
    resolveStablePluginStructuredMessage,
    resolveStablePluginStructuredMessageConsumer,
} from './structuredMessageConsumer';

function createRegistry(): ResolvedContributionRegistry {
    return {
        generationId: 'generation-7',
        structuredMessages: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            definition: {
                id: 'preview-card',
                title: 'Preview',
                kind: 'acme.preview/preview-card.v1',
                payloadSchema: {
                    type: 'object',
                    required: ['previewId'],
                    properties: { previewId: { type: 'string' } },
                    additionalProperties: false,
                },
                renderer: 'summary-card',
                actions: ['open-preview'],
                fallback: { kind: 'summary', template: 'Preview unavailable' },
                availability: {
                    when: { fact: 'session.exists', operator: 'equals', value: true },
                },
            },
        }],
        uiRenderersV2: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            identity: { pluginId: 'acme.preview', localId: 'summary-card' },
            manifestPath: '/plugins/acme/plugin.json',
            manifestDigest: 'sha256:manifest',
            definition: {
                id: 'summary-card',
                kind: 'declarative',
                root: { kind: 'status', label: 'Preview', value: 'Ready' },
            },
        }],
        actions: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            definition: { id: 'open-preview' },
        }],
        resources: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            definition: { kindVersion: 1, id: 'preview-icon', type: 'staticAsset' },
        }],
        agents: [],
                tools: [],
        commands: [],
        promptAssets: [],
        activationTargets: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
                catalogEntriesById: {},
        agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: {},
    } as unknown as ResolvedContributionRegistry;
}

describe('production structured-message consumer', () => {
    it('normalizes a valid payload and every renderer/action/resource identity before rendering', () => {
        const resolution = resolveStablePluginStructuredMessageConsumer({
            registry: createRegistry(),
            expectedGeneration: 'generation-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            resourceRefs: ['preview-icon'],
            facts: { 'plugin.enabled': true, 'session.exists': true },
        });

        expect(resolution.model).toMatchObject({
            identity: {
                pluginId: 'acme.preview',
                localId: 'preview-card',
                qualifiedId: 'acme.preview/preview-card',
                generation: 'generation-7',
            },
            renderer: {
                identity: { pluginId: 'acme.preview', localId: 'summary-card' },
                qualifiedId: 'acme.preview/summary-card',
                generation: 'generation-7',
            },
            actions: [{
                identity: { pluginId: 'acme.preview', localId: 'open-preview' },
                qualifiedId: 'acme.preview/open-preview',
                generation: 'generation-7',
                enabled: true,
            }],
            resources: [{
                identity: { pluginId: 'acme.preview', localId: 'preview-icon' },
                qualifiedId: 'acme.preview/preview-icon',
                generation: 'generation-7',
            }],
            visible: true,
            fallback: { kind: 'summary', template: 'Preview unavailable' },
        });
        expect(resolution.renderer).toMatchObject({
            identity: { qualifiedId: 'acme.preview/summary-card', generation: 'generation-7' },
            visible: true,
            root: { kind: 'status', label: 'Preview', value: 'Ready' },
        });
    });

    it('rejects a payload through the canonical JSON Schema validator before producing a render model', () => {
        expect(() => resolveStablePluginStructuredMessage({
            registry: createRegistry(),
            expectedGeneration: 'generation-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 42 },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).toThrowError(expect.objectContaining({ code: 'plugin_structured_message_payload_invalid' }));
    });

    it('does not grant a renderer actions outside its structured-message descriptor', () => {
        const registry = createRegistry();
        const renderer = registry.uiRenderersV2![0]!;
        const actions = [...registry.actions, {
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            pluginId: 'acme.preview',
            definition: { id: 'delete-preview' },
        }];
        expect(() => resolveStablePluginStructuredMessageConsumer({
            registry: {
                ...registry,
                actions,
                uiRenderersV2: [{
                    ...renderer,
                    definition: {
                        id: 'summary-card',
                        kind: 'declarative',
                        root: { kind: 'action', action: 'delete-preview', label: 'Delete' },
                    },
                }],
            } as ResolvedContributionRegistry,
            expectedGeneration: 'generation-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).toThrowError(expect.objectContaining({ code: 'plugin_declarative_action_missing' }));
    });

    it('fails closed for stale generations and unavailable policy facts', () => {
        expect(() => resolveStablePluginStructuredMessage({
            registry: createRegistry(),
            expectedGeneration: 'generation-6',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).toThrowError(expect.objectContaining({ code: 'plugin_structured_message_generation_retired' }));

        expect(resolveStablePluginStructuredMessage({
            registry: createRegistry(),
            expectedGeneration: 'generation-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true },
        }).visible).toBe(false);
    });
});
