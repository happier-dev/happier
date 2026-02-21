import { describe, expect, it } from 'vitest';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import { resolveInstallablePolicy, applyInstallablePolicyOverride } from './installablesPolicy';

describe('installablesPolicy', () => {
    it('resolves defaults when there is no override', () => {
        const policy = resolveInstallablePolicy({
            settings: { installablesPolicyByMachineId: {} } as any,
            machineId: 'm1',
            installableKey: INSTALLABLE_KEYS.CODEX_ACP,
            defaults: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
        });
        expect(policy).toEqual({ autoInstallWhenNeeded: true, autoUpdateMode: 'auto' });
    });

    it('applies machine/key overrides while preserving unspecified defaults', () => {
        const policy = resolveInstallablePolicy({
            settings: {
                installablesPolicyByMachineId: {
                    m1: {
                        [INSTALLABLE_KEYS.CODEX_ACP]: { autoUpdateMode: 'notify' },
                    },
                },
            } as any,
            machineId: 'm1',
            installableKey: INSTALLABLE_KEYS.CODEX_ACP,
            defaults: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
        });
        expect(policy).toEqual({ autoInstallWhenNeeded: true, autoUpdateMode: 'notify' });
    });

    it('builds a next installablesPolicyByMachineId map with a key override', () => {
        const next = applyInstallablePolicyOverride({
            prev: {},
            machineId: 'm1',
            installableKey: INSTALLABLE_KEYS.CODEX_ACP,
            patch: { autoInstallWhenNeeded: false },
        });
        expect(next).toEqual({ m1: { [INSTALLABLE_KEYS.CODEX_ACP]: { autoInstallWhenNeeded: false } } });
    });
});
