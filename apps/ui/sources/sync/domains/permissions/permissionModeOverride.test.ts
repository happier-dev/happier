import { describe, expect, it } from 'vitest';

import { getPermissionModeOverrideForSpawn } from './permissionModeOverride';
import { resolvePermissionModeSeedForAgentStart } from '../../../../../cli/src/settings/permissions/permissionModeSeed';
import { createSessionFixture } from '@/dev/testkit';

describe('getPermissionModeOverrideForSpawn', () => {
    it('preserves requested planning until the selected Agent seed normalizes it once (01C)', () => {
        const session = createSessionFixture({
            permissionMode: 'plan', permissionModeUpdatedAt: 11,
            metadata: { path: '/tmp', host: 'h', permissionModeUpdatedAt: 10 },
        });
        const requested = getPermissionModeOverrideForSpawn(session);
        expect(requested).toEqual({ permissionMode: 'plan', permissionModeUpdatedAt: 11 });
        expect(resolvePermissionModeSeedForAgentStart({
            agentId: 'acme.agent', explicitPermissionMode: requested?.permissionMode, accountSettings: null,
            sessionModeDescriptor: { source: 'provider-native', semantics: 'agent-modes', runtimeSwitch: 'provider-native' },
        })).toEqual({ mode: 'plan', source: 'explicit' });
        expect(resolvePermissionModeSeedForAgentStart({
            agentId: 'acme.agent', explicitPermissionMode: requested?.permissionMode, accountSettings: null,
        })).toEqual({ mode: 'read-only', source: 'explicit' });
    });
    it('returns null when local permissionModeUpdatedAt is missing', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'ask',
            // permissionModeUpdatedAt missing
            metadata: { permissionModeUpdatedAt: 1 },
        } as any)).toBeNull();
    });

    it('returns null when local updatedAt is not newer than metadata updatedAt', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'ask',
            permissionModeUpdatedAt: 10,
            metadata: { permissionModeUpdatedAt: 10 },
        } as any)).toBeNull();
    });

    it('returns override when local updatedAt is newer than metadata updatedAt', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'ask',
            permissionModeUpdatedAt: 11,
            metadata: { permissionModeUpdatedAt: 10 },
        } as any)).toEqual({
            permissionMode: 'default',
            permissionModeUpdatedAt: 11,
        });
    });

    it('defaults permissionMode to default when local mode is empty', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: '',
            permissionModeUpdatedAt: 11,
            metadata: { permissionModeUpdatedAt: 10 },
        } as any)).toEqual({
            permissionMode: 'default',
            permissionModeUpdatedAt: 11,
        });
    });

    it('preserves requested planning for the selected Agent seed to normalize', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'plan',
            permissionModeUpdatedAt: 11,
            metadata: { permissionModeUpdatedAt: 10, flavor: 'codex' },
        } as any)).toEqual({
            permissionMode: 'plan',
            permissionModeUpdatedAt: 11,
        });
    });

    it('preserves planning for Claude sessions', () => {
        expect(getPermissionModeOverrideForSpawn({
            id: 's1',
            permissionMode: 'plan',
            permissionModeUpdatedAt: 11,
            metadata: { permissionModeUpdatedAt: 10, flavor: 'claude' },
        } as any)).toEqual({
            permissionMode: 'plan',
            permissionModeUpdatedAt: 11,
        });
    });
});
