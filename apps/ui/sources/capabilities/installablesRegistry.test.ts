import { describe, expect, it } from 'vitest';
import { INSTALLABLES_CATALOG } from '@happier-dev/protocol/installables';

import { getInstallablesRegistryEntries } from './installablesRegistry';

describe('getInstallablesRegistryEntries', () => {
    it('returns the expected built-in installables', () => {
        const entries = getInstallablesRegistryEntries();

        expect(entries.map((e) => e.key)).toEqual(INSTALLABLES_CATALOG.map((e) => e.key));
        expect(entries.map((e) => e.capabilityId)).toEqual(INSTALLABLES_CATALOG.map((e) => e.capabilityId));
        expect(entries.map((e) => e.installSpecSettingKey)).toEqual(['codexMcpResumeInstallSpec', 'codexAcpInstallSpec']);
        expect(entries.map((e) => e.defaultPolicy)).toEqual([
            { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
            { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
        ]);
    });
});
