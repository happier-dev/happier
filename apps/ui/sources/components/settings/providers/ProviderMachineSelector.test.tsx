import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

describe('ProviderMachineSelector', () => {
    afterEach(standardCleanup);

    it('names machines through the machine naming owner: unnamed is never the raw id, same names are told apart', async () => {
        const { ProviderMachineSelector } = await import('./ProviderMachineSelector');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { t } = await import('@/text');
        const screen = await renderScreen(
            <ProviderMachineSelector
                serverId={null}
                machines={[
                    { id: 'f98b860d-63e0', metadata: {} },
                    { id: 'a1b2c3d4-0000', metadata: { displayName: 'Build' } },
                    { id: 'e5f6a7b8-0000', metadata: { displayName: 'Build' } },
                ]}
                selectedId={null}
                onSelect={() => {}}
            />,
        );
        const titles = screen.findByType(DropdownMenu).props.items.map((item: { title: string }) => item.title);
        expect(titles[0]).toBe(t('machine.unnamedMachine'));
        expect(new Set(titles.slice(1)).size).toBe(2);
        expect(titles.join('\n')).not.toContain('f98b860d');
    });
});
