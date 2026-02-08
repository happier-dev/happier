import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import type { Metadata } from './storageTypes';

import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeOptionsForAgentType,
    getPermissionModeOptionsForSession,
    normalizePermissionModeForAgentType,
} from './permissionModeOptions';

describe('permissionModeOptions', () => {
    it('exposes canonical intents in option lists', () => {
        const claude = getPermissionModeOptionsForAgentType('claude').map((o) => o.value);
        expect(claude).toContain('safe-yolo');
        expect(claude).toContain('yolo');
        expect(claude).not.toContain('acceptEdits');
        expect(claude).not.toContain('bypassPermissions');
    });

    it('normalizes unsupported modes per agent group', () => {
        expect(normalizePermissionModeForAgentType('read-only', 'claude')).toBe('read-only');
        expect(normalizePermissionModeForAgentType('acceptEdits', 'codex')).toBe('safe-yolo');
        expect(normalizePermissionModeForAgentType('plan', 'codex')).toBe('read-only');
    });

    it('does not include plan in codex option lists', () => {
        expect(getPermissionModeOptionsForAgentType('claude').map((o) => o.value)).toContain('plan');
        expect(getPermissionModeOptionsForAgentType('codex').map((o) => o.value)).not.toContain('plan');

        expect(getPermissionModeOptionsForSession('claude', { path: '/tmp', host: 'h' } as Metadata).map((o) => o.value)).toContain('plan');
        expect(getPermissionModeOptionsForSession('codex', { path: '/tmp', host: 'h' } as Metadata).map((o) => o.value)).not.toContain('plan');
    });

    it('does not treat ACP session modes as permission modes', () => {
        const metadata = {
            path: '/tmp',
            host: 'h',
            acpSessionModesV1: {
                v: 1,
                provider: 'codex',
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

    it('returns a badge label for plan when the agent supports surfacing plan mode', () => {
        expect(getPermissionModeBadgeLabelForAgentType('claude', 'plan' as PermissionMode)).not.toBe('');
    });
});
