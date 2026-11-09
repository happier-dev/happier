import { describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

import {
    resolveStablePluginStructuredMessage,
    resolveStablePluginStructuredMessageConsumer,
} from './structuredMessageConsumer';

function createRegistry(): ResolvedContributionRegistry {
    return {
        structuredMessages: [{
            provenance: 'first_party',
            source: { kind: 'bundled' },
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
            definition: { id: 'open-preview', title: 'Open preview', execution: { target: 'daemon' } },
        }],
        resources: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            definition: { kindVersion: 1, id: 'preview-icon', type: 'staticAsset' },
        }],
        agents: [],
        promptAssets: [],
        activationTargets: [],
        occurrenceIdsByPluginId: { 'acme.preview': 'occurrenceId-7' },
        actionsById: new Map(),
        resourcesById: new Map(),
                catalogEntriesById: {},
        agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: {},
    } as unknown as ResolvedContributionRegistry;
}

describe('production structured-message consumer', () => {
    it('requires the runtime owner to supply the current activation occurrenceId', () => {
        expect(() => resolveStablePluginStructuredMessage({
            registry: createRegistry(),
            expectedContributorOccurrenceId: 'occurrenceId-6',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).toThrowError(expect.objectContaining({ code: 'plugin_structured_message_occurrence_retired' }));
    });

    it('normalizes a valid payload and every renderer/action/resource identity before rendering', () => {
        const resolution = resolveStablePluginStructuredMessageConsumer({
            registry: createRegistry(),
            expectedContributorOccurrenceId: 'occurrenceId-7',
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
                occurrenceId: 'occurrenceId-7',
            },
            renderer: {
                identity: { pluginId: 'acme.preview', localId: 'summary-card' },
                qualifiedId: 'acme.preview/summary-card',
                occurrenceId: 'occurrenceId-7',
            },
            actions: [{
                identity: { pluginId: 'acme.preview', localId: 'open-preview' },
                qualifiedId: 'acme.preview/open-preview',
                occurrenceId: 'occurrenceId-7',
                enabled: true,
            }],
            resources: [{
                identity: { pluginId: 'acme.preview', localId: 'preview-icon' },
                qualifiedId: 'acme.preview/preview-icon',
                occurrenceId: 'occurrenceId-7',
            }],
            visible: true,
            fallback: { kind: 'summary', template: 'Preview unavailable' },
        });
        expect(resolution.renderer).toMatchObject({
            identity: { qualifiedId: 'acme.preview/summary-card', occurrenceId: 'occurrenceId-7' },
            visible: true,
            root: { kind: 'status', label: 'Preview', value: 'Ready' },
        });
    });

    it('rejects a payload through the canonical JSON Schema validator before producing a render model', () => {
        expect(() => resolveStablePluginStructuredMessage({
            registry: createRegistry(),
            expectedContributorOccurrenceId: 'occurrenceId-7',
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
            expectedContributorOccurrenceId: 'occurrenceId-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).toThrowError(expect.objectContaining({ code: 'plugin_declarative_action_missing' }));
    });

    it('rejects an exclusive structured-message kind claimed by two plugins instead of silently picking one', () => {
        const registry = createRegistry();
        const declaring = registry.structuredMessages![0]!;
        const contested = {
            ...registry,
            structuredMessages: [
                declaring,
                {
                    ...declaring,
                    pluginId: 'other.preview',
                    definition: {
                        ...declaring.definition,
                        fallback: { kind: 'summary' as const, template: 'Other preview unavailable' },
                    },
                },
            ],
        } as ResolvedContributionRegistry;

        expect(() => resolveStablePluginStructuredMessage({
            registry: contested,
            expectedContributorOccurrenceId: 'occurrenceId-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).toThrowError(expect.objectContaining({ code: 'plugin_structured_message_kind_ambiguous' }));

        // Negative control: the SAME two contributions on DIFFERENT kinds are
        // not ambiguous, so the rejection is about the contested kind and not
        // about the presence of a second declaration.
        const distinct = {
            ...contested,
            structuredMessages: [
                declaring,
                {
                    ...contested.structuredMessages![1]!,
                    definition: {
                        ...contested.structuredMessages![1]!.definition,
                        kind: 'other.preview/preview-card.v1',
                    },
                },
            ],
        } as ResolvedContributionRegistry;

        expect(resolveStablePluginStructuredMessage({
            registry: distinct,
            expectedContributorOccurrenceId: 'occurrenceId-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        }).identity.pluginId).toBe('acme.preview');
    });

    it('fails closed for a stale contributor occurrence and unavailable policy facts', () => {
        expect(() => resolveStablePluginStructuredMessage({
            registry: createRegistry(),
            expectedContributorOccurrenceId: 'occurrenceId-6',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).toThrowError(expect.objectContaining({ code: 'plugin_structured_message_occurrence_retired' }));

        expect(resolveStablePluginStructuredMessage({
            registry: createRegistry(),
            expectedContributorOccurrenceId: 'occurrenceId-7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: { 'plugin.enabled': true },
        }).visible).toBe(false);
    });
});
