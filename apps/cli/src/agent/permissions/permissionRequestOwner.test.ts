import { describe, expect, it } from 'vitest';

import {
    normalizePermissionRequestOwner,
} from './permissionRequestOwner';

const sourceAuthority = {
    kind: 'mediatedExternal',
    mediatorPluginId: 'happier.channels',
    sourceRef: 'binding:ops',
    sourceRevisionOrEpoch: '42',
    admittedPermissionCeiling: 'default',
    remoteApprovalMaxScope: 'session',
} as const;

describe('permission request owner', () => {
    it('retains a strict host-stamped mediated source authority with the existing request owner', () => {
        expect(normalizePermissionRequestOwner({
            kind: 'plugin',
            pluginId: 'provider.codex',
            runtimeId: 'provider.codex/runtime',
            sourceAuthority,
        })).toEqual({
            kind: 'plugin',
            pluginId: 'provider.codex',
            runtimeId: 'provider.codex/runtime',
            sourceAuthority,
        });
    });

    it('rejects malformed authority instead of silently treating it as a legacy request owner', () => {
        expect(normalizePermissionRequestOwner({
            kind: 'plugin',
            pluginId: 'provider.codex',
            sourceAuthority: {
                ...sourceAuthority,
                admittedPermissionCeiling: 'unbounded',
            },
        })).toBeNull();
    });
});
