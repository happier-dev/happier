import { describe, expect, it } from 'vitest';

import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1,
    SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol';

import {
    countSelectedSessionMcpPreviewEntries,
    setManagedSessionMcpServersEnabled,
    toggleManagedSessionMcpSelection,
} from './sessionMcpSelectionState';

function createSelection(input?: Partial<SessionMcpSelectionV1>): SessionMcpSelectionV1 {
    return SessionMcpSelectionV1Schema.parse(input ?? {});
}

function createManagedEntry(overrides?: Partial<ManagedMcpPreviewEntryV1>): ManagedMcpPreviewEntryV1 {
    return {
        key: 'managed:server-1',
        serverId: 'server-1',
        name: 'playwright',
        title: 'Playwright',
        transport: 'stdio',
        authMode: 'none',
        selected: true,
        selectable: true,
        availability: 'active',
        sourceKind: 'managed',
        scopeKind: 'allMachines',
        reasonCode: 'active_by_default',
        portability: 'portable',
        defaultSelected: true,
        ...overrides,
    };
}

describe('sessionMcpSelectionState', () => {
    it('counts managed and detected preview entries that are selected (excluding built-ins)', () => {
        const preview: Extract<DaemonMcpServersPreviewResponse, { ok: true }> = {
            ok: true,
            builtIn: [{
                key: 'built-in:happier',
                name: 'happier',
                title: 'Happier',
                transport: 'stdio',
                authMode: 'none',
                selected: true,
                selectable: false,
                availability: 'active',
                sourceKind: 'builtIn',
                scopeKind: 'builtIn',
            }],
            managed: [
                createManagedEntry(),
                createManagedEntry({
                    key: 'managed:hidden-builtin',
                    serverId: 'hidden-builtin',
                    name: 'happier',
                    title: 'Happier',
                    selected: true,
                    selectable: false,
                    availability: 'active',
                    reasonCode: 'active_by_default',
                    defaultSelected: true,
                }),
                createManagedEntry({
                    key: 'managed:server-2',
                    serverId: 'server-2',
                    name: 'context7',
                    selected: false,
                    availability: 'available',
                    reasonCode: 'available_portable',
                    defaultSelected: false,
                }),
            ],
            detected: [{
                key: 'detected:codex:sequential-thinking',
                name: 'sequential-thinking',
                transport: 'stdio',
                authMode: 'unknown',
                selected: true,
                selectable: false,
                availability: 'readOnly',
                sourceKind: 'detected',
                scopeKind: 'providerUser',
                provider: 'codex',
                enabled: true,
                envKeyCount: 1,
                headerKeyCount: 0,
                sourcePath: '/Users/test/.codex/config.toml',
            }],
        };

        expect(countSelectedSessionMcpPreviewEntries(preview, {
            visibleManagedServerIds: new Set(['server-1', 'server-2']),
        })).toBe(1);
    });

    it('turns off a default-selected server by forcing an exclusion', () => {
        const next = toggleManagedSessionMcpSelection(createSelection(), createManagedEntry());

        expect(next).toEqual({
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: ['server-1'],
        });
    });

    it('turns on an available portable server by forcing an inclusion', () => {
        const next = toggleManagedSessionMcpSelection(
            createSelection(),
            createManagedEntry({
                selected: false,
                defaultSelected: false,
                availability: 'available',
                reasonCode: 'available_portable',
            }),
        );

        expect(next).toEqual({
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: ['server-1'],
            forceExcludeServerIds: [],
        });
    });

    it('ignores toggle requests for non-selectable servers', () => {
        const selection = createSelection({ forceExcludeServerIds: ['server-1'] });

        const next = toggleManagedSessionMcpSelection(
            selection,
            createManagedEntry({
                selected: false,
                selectable: false,
                availability: 'unavailable',
                reasonCode: 'not_portable',
                portability: 'machine_scoped',
                defaultSelected: false,
            }),
        );

        expect(next).toEqual(selection);
    });

    it('toggles the managed-servers power state without touching include or exclude lists', () => {
        const next = setManagedSessionMcpServersEnabled(
            createSelection({
                forceIncludeServerIds: ['server-2'],
                forceExcludeServerIds: ['server-3'],
            }),
            false,
        );

        expect(next).toEqual({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-2'],
            forceExcludeServerIds: ['server-3'],
        });
    });
});
