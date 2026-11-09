import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import type { Metadata } from '@happier-dev/session-core/state';

import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeLabelForAgentType,
    getPermissionModeTitleForAgentType,
    getPermissionModesForAgentType,
    getPermissionModeOptionsForAgentType,
    getPermissionModeOptionsForSession,
    normalizePermissionModeForAgentType,
    restrictPermissionModeOptions,
} from './permissionModeOptions';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { t } from '@/text';

describe('permissionModeOptions', () => {
    it('retains installed native planning through the daemon and resolved catalog descriptor (01C)', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            'acme.agent': { id: 'acme.agent', sessionModeDescriptor: {
                source: 'provider-native', semantics: 'agent-modes', runtimeSwitch: 'provider-native',
            } },
        } });
        const inputs = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        const resolved = resolveAgentCatalogProjection('acme.agent', { enabledAgentIds: ['acme.agent'], ...inputs });
        expect(normalizePermissionModeForAgentType('plan', resolved.agentId, resolved.sessionModeDescriptor)).toBe('plan');
        expect(normalizePermissionModeForAgentType('plan', 'acme.agent')).toBe('read-only');
    });
    it('exposes canonical intents in option lists', () => {
        const claude = getPermissionModeOptionsForAgentType('claude').map((o) => o.value);
        expect(claude).toContain('safe-yolo');
        expect(claude).toContain('yolo');
        expect(claude).not.toContain('acceptEdits');
        expect(claude).not.toContain('bypassPermissions');
    });

    it('normalizes unsupported planning without discarding declared Agent-mode behavior', () => {
        expect(normalizePermissionModeForAgentType('read-only', 'claude')).toBe('read-only');
        expect(normalizePermissionModeForAgentType('acceptEdits', 'codex')).toBe('safe-yolo');
        expect(normalizePermissionModeForAgentType('plan', 'codex')).toBe('read-only');
        expect(normalizePermissionModeForAgentType('plan', 'claude')).toBe('plan');
        expect(normalizePermissionModeForAgentType('plan', 'acme.agent')).toBe('read-only');
        expect(normalizePermissionModeForAgentType('plan', 'acme.agent', {
            source: 'provider-native', semantics: 'agent-modes', runtimeSwitch: 'provider-native',
        })).toBe('plan');
    });

    it('does not include legacy plan in option lists', () => {
        expect(getPermissionModeOptionsForAgentType('claude').map((o) => o.value)).not.toContain('plan');
        expect(getPermissionModeOptionsForAgentType('codex').map((o) => o.value)).not.toContain('plan');

        expect(getPermissionModeOptionsForSession('claude', { path: '/tmp', host: 'h' } as Metadata).map((o) => o.value)).not.toContain('plan');
        expect(getPermissionModeOptionsForSession('codex', { path: '/tmp', host: 'h' } as Metadata).map((o) => o.value)).not.toContain('plan');
    });

    it('does not treat ACP session modes as permission modes', () => {
        const metadata = {
            path: '/tmp',
            host: 'h',
            acpSessionModesV1: {
                v: 1,
                agentId: 'codex',
                updatedAt: 1,
                currentModeId: 'code',
                availableModes: [
                    { id: 'code', name: 'Code' },
                    { id: 'plan', name: 'Plan' },
                ],
            },
        } as Metadata;

        expect(getPermissionModeOptionsForSession('codex', metadata).map((o) => o.value)).not.toContain('plan');
    });

    it('returns empty badge for default mode', () => {
        expect(getPermissionModeBadgeLabelForAgentType('claude', 'default')).toBe('');
        expect(getPermissionModeBadgeLabelForAgentType('codex', 'default')).toBe('');
    });

    it('returns a non-empty badge label for non-default supported modes', () => {
        expect(getPermissionModeBadgeLabelForAgentType('claude', 'safe-yolo' as PermissionMode)).not.toBe('');
        expect(getPermissionModeBadgeLabelForAgentType('codex', 'read-only' as PermissionMode)).not.toBe('');
        expect(getPermissionModeBadgeLabelForAgentType('gemini', 'safe-yolo' as PermissionMode)).not.toBe('');
    });

    it('maps legacy plan badge to the read-only badge', () => {
        expect(getPermissionModeBadgeLabelForAgentType('claude', 'plan' as PermissionMode)).toBe(
            getPermissionModeBadgeLabelForAgentType('claude', 'read-only' as PermissionMode),
        );
    });

    it('keeps a catalog-projected external Agent neutral without borrowing Claude permission facts', () => {
        const projection = resolveAgentCatalogProjection('acme.agent', {
            enabledAgentIds: ['acme.agent'],
            mergedProviderProjectionById: {
                'acme.agent': {
                    agentId: 'acme.agent',
                    title: 'Acme Agent',
                    channel: 'plugin',
                    isBuiltIn: false,
                },
            },
        });

        expect(projection).toEqual(expect.objectContaining({
            agentId: 'acme.agent',
            catalogAgentId: null,
            isBuiltIn: false,
        }));
        expect(getPermissionModesForAgentType(projection.agentId)).toEqual([]);
        expect(getPermissionModeOptionsForSession(projection.agentId, null)).toEqual([]);
        expect(getPermissionModeBadgeLabelForAgentType(projection.agentId, 'safe-yolo')).toBe('');
        expect(getPermissionModeTitleForAgentType(projection.agentId)).toBe(
            t('settingsSession.permissions.title'),
        );
        expect(getPermissionModeLabelForAgentType(projection.agentId, 'default')).toBe(t('common.default'));
        expect(getPermissionModeLabelForAgentType(projection.agentId, 'safe-yolo')).toBe('safe-yolo');
    });

    it('restricts the options to an allowed subset (an embed grant) without adding any', () => {
        const all = getPermissionModeOptionsForAgentType('claude');
        const restricted = restrictPermissionModeOptions(all, ['default', 'read-only', 'not-a-mode' as PermissionMode]);

        expect(restricted.map((option) => option.value)).toEqual(all.map((option) => option.value).filter((mode) => mode === 'default' || mode === 'read-only'));
        expect(restrictPermissionModeOptions(all, null)).toBe(all);
        expect(restrictPermissionModeOptions(all, ['acceptEdits', 'bypassPermissions']).map((option) => option.value))
            .toEqual(['safe-yolo', 'yolo']);
    });
});
