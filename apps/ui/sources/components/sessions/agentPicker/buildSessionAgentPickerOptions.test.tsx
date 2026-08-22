import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import { buildSessionAgentPickerOptions } from './buildSessionAgentPickerOptions';

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: () => 1,
}));

function entry(
    backendId: string,
    overrides: Partial<ResolvedBackendCatalogEntry> = {},
): ResolvedBackendCatalogEntry {
    return {
        backendTarget: { kind: 'backend', backendId },
        backendTargetKey: `backend:${backendId}`,
        kind: 'builtInAgent',
        backendId,
        agentId: backendId,
        catalogAgentId: backendId as ResolvedBackendCatalogEntry['catalogAgentId'],
        builtInAgentId: backendId as ResolvedBackendCatalogEntry['builtInAgentId'],
        iconAgentId: backendId as ResolvedBackendCatalogEntry['iconAgentId'],
        title: backendId,
        subtitle: null,
        ...overrides,
    };
}

const availablePresentation = { disabled: false, muted: false } as const;

describe('buildSessionAgentPickerOptions', () => {
    it('leads with favorites, then applicable rows, then blocked rows', () => {
        const options = buildSessionAgentPickerOptions({
            entries: [entry('claude'), entry('codex'), entry('gemini'), entry('kimi')],
            favoriteBackendTargetKeys: ['backend:gemini'],
            leadingOptions: [{ id: 'favorite-models', label: 'Favorites' }],
            resolvePresentation: (candidate) => {
                if (candidate.backendId === 'kimi') {
                    return { subtitle: 'CLI not detected', disabled: true, muted: true };
                }
                if (candidate.backendId === 'codex') {
                    return { subtitle: 'Not signed in', disabled: false, muted: true };
                }
                return availablePresentation;
            },
            resolveBehavior: () => ({}),
        });

        expect(options.map((option) => option.id)).toEqual([
            'favorite-models',
            'backend:gemini',
            'backend:claude',
            'backend:codex',
            'backend:kimi',
        ]);
    });

    it('carries the caller-owned explanation, availability, and behavior onto each row', () => {
        const onSelectImmediate = vi.fn();
        const options = buildSessionAgentPickerOptions({
            entries: [entry('codex'), entry('kimi')],
            resolvePresentation: (candidate) => (candidate.backendId === 'kimi'
                ? { subtitle: 'Update the CLI', disabled: true, muted: true }
                : availablePresentation),
            resolveBehavior: ({ presentation, entry: candidate }) => (presentation.disabled
                ? { detailTitle: candidate.title, detailDescription: presentation.subtitle }
                : { closeOnSelectImmediate: false, onSelectImmediate }),
        });

        const [codexOption, kimiOption] = options;
        expect(codexOption).toMatchObject({
            id: 'backend:codex',
            label: 'codex',
            disabled: false,
            muted: false,
            closeOnSelectImmediate: false,
        });
        expect(kimiOption).toMatchObject({
            id: 'backend:kimi',
            disabled: true,
            muted: true,
            subtitle: 'Update the CLI',
            detailDescription: 'Update the CLI',
        });
        expect(kimiOption?.onSelectImmediate).toBeUndefined();

        codexOption?.onSelectImmediate?.();
        expect(onSelectImmediate).toHaveBeenCalledTimes(1);
    });

    it('reports whether a row is a favorite so callers can render its rail action', () => {
        const railActionContexts: Array<Readonly<{ id: string; favorite: boolean }>> = [];
        buildSessionAgentPickerOptions({
            entries: [entry('claude'), entry('codex')],
            favoriteBackendTargetKeys: ['backend:codex'],
            resolvePresentation: () => availablePresentation,
            resolveRailAction: ({ entry: candidate, favorite }) => {
                railActionContexts.push({ id: candidate.backendTargetKey, favorite });
                return undefined;
            },
            resolveBehavior: () => ({}),
        });

        expect(railActionContexts).toEqual([
            { id: 'backend:codex', favorite: true },
            { id: 'backend:claude', favorite: false },
        ]);
    });

    it('falls back to a neutral icon for a target with no Agent identity', () => {
        const [option] = buildSessionAgentPickerOptions({
            entries: [entry('ultracode', {
                kind: 'configuredBackend',
                catalogAgentId: null,
                builtInAgentId: null,
                iconAgentId: null,
            })],
            resolvePresentation: () => availablePresentation,
            resolveBehavior: () => ({}),
        });

        expect(React.isValidElement(option?.icon)).toBe(true);
    });
});
