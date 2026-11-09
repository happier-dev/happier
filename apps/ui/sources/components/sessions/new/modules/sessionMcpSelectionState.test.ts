import { describe, expect, it } from 'vitest';

import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1} from '@happier-dev/protocol/mcp/servers/previewV1';
import type {
    SessionMcpSelectionV1,
} from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';

import {
    countSelectedSessionMcpPreviewEntries,
    setManagedSessionMcpServersEnabled,
    toggleManagedSessionMcpSelection,
    setSessionCapabilitySelectionItem,
} from '@/sync/domains/capabilities/session/sessionCapabilitySelectionState';

function createSelection(input?: Partial<SessionMcpSelectionV1>) {
    return { mcp: SessionMcpSelectionV1Schema.parse(input ?? {}) };
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
    it('updates library and native skill overrides without changing MCP and restores inheritance', () => {
        const selection = createSelection({ forceIncludeServerIds: ['server-a'] });
        const included = setSessionCapabilitySelectionItem(selection, 'skill', 'skill-a', 'on');
        const excluded = setSessionCapabilitySelectionItem(included, 'skill', 'skill-a', 'off');
        expect(excluded).toMatchObject({ mcp: selection.mcp, skills: { forceIncludeSkillIds: [], forceExcludeSkillIds: ['skill-a'] } });
        const native = setSessionCapabilitySelectionItem(excluded, 'native_skill', 'native-a', 'off');
        expect(native).toMatchObject({ mcp: selection.mcp, skills: { forceExcludeSkillIds: ['skill-a'], excludeNativeSkillNames: ['native-a'] } });
        expect(setSessionCapabilitySelectionItem(native, 'native_skill', 'native-a', 'inherit').skills?.excludeNativeSkillNames).toEqual([]);
        expect(setSessionCapabilitySelectionItem(native, 'skill', 'skill-a', 'inherit').skills?.forceExcludeSkillIds).toEqual([]);
    });

    it('keeps skill overrides when the draft changes its managed MCP selection', () => {
        const selection = {
            mcp: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] },
            skills: { v: 1 as const, forceIncludeSkillIds: ['skill-a'], forceExcludeSkillIds: ['skill-b'], excludeNativeSkillNames: ['native-a'] },
        };
        expect(setManagedSessionMcpServersEnabled(selection, false)).toEqual({
            ...selection, mcp: { ...selection.mcp, managedServersEnabled: false },
        });
        expect(toggleManagedSessionMcpSelection(selection, {
            serverId: 'server-a', selected: false, selectable: true, defaultSelected: false,
        })).toEqual({ ...selection, mcp: { ...selection.mcp, forceIncludeServerIds: ['server-a'] } });
    });

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

        expect(next).toEqual({ mcp: {
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: ['server-1'],
        } });
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

        expect(next).toEqual({ mcp: {
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: ['server-1'],
            forceExcludeServerIds: [],
        } });
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

        expect(next).toEqual({ mcp: {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-2'],
            forceExcludeServerIds: ['server-3'],
        } });
    });
});
