import * as React from 'react';

import { MachineComputerUseSectionView } from '@/components/machines/computer/MachineComputerUseSection';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { ComputerProviderSettingsRow } from '@/sync/domains/computer/computerProviderSettings';
import type { ComputerProviderSettingsMutation } from '@/sync/domains/computer/useComputerProviderSettings';
import { t } from '@/text';
import type { ComputerUseSettingsV1 } from '@happier-dev/protocol/computer/v1';

type SpecimenState = Readonly<{
    preferences: ComputerUseSettingsV1 | null;
    providers: readonly ComputerProviderSettingsRow[];
    mutation?: ComputerProviderSettingsMutation;
    online?: boolean;
    unavailable?: boolean;
}>;

const CUA_ONLY = { enabledProviders: ['cua'], defaultProvider: 'cua' } as const satisfies ComputerUseSettingsV1;
const BOTH = { enabledProviders: ['cua', 'agent-desktop'], defaultProvider: 'cua' } as const satisfies ComputerUseSettingsV1;
const cua = (overrides: Partial<ComputerProviderSettingsRow> = {}): ComputerProviderSettingsRow =>
    ({ provider: 'cua', enabled: true, isDefault: true, availability: 'ready', ...overrides });
const ad = (overrides: Partial<ComputerProviderSettingsRow> = {}): ComputerProviderSettingsRow =>
    ({ provider: 'agent-desktop', enabled: false, isDefault: false, availability: 'not_installed', ...overrides });

/** Every state the Computer control page shows, at static props (the real page body, no machine reads). */
export const COMPUTER_USE_SETTINGS_SPECIMEN_STATES: Readonly<Record<string, SpecimenState>> = {
    first: { preferences: CUA_ONLY, providers: [cua(), ad()] },
    both: { preferences: BOTH, providers: [cua(), ad({ enabled: true, availability: 'ready' })] },
    agentDesktopDefault: { preferences: { ...BOTH, defaultProvider: 'agent-desktop' },
        providers: [cua({ isDefault: false }), ad({ enabled: true, isDefault: true, availability: 'ready' })] },
    installing: { preferences: CUA_ONLY, providers: [cua(), ad()], mutation: { phase: 'installing', provider: 'agent-desktop' } },
    failed: { preferences: CUA_ONLY, providers: [cua(), ad()],
        mutation: { phase: 'failed', errorCode: 'install_failed', error: 'The download was interrupted', provider: 'agent-desktop' } },
    missing: { preferences: BOTH, providers: [cua(), ad({ enabled: true })] },
    unavailable: { preferences: CUA_ONLY, providers: [cua(), ad({ availability: 'unavailable', error: { code: 'unsupported_platform', message: 'Unsupported platform' } })] },
    offline: { preferences: CUA_ONLY, providers: [cua({ availability: 'unknown' }), ad({ availability: 'unknown' })], online: false },
    checking: { preferences: CUA_ONLY, providers: [cua({ availability: 'loading' }), ad({ availability: 'loading' })] },
    loading: { preferences: null, providers: [] },
    denied: { preferences: null, providers: [], unavailable: true },
};

const NOOP = () => undefined;

export function ComputerUseSettingsSpecimen(props: Readonly<{ state: string }>) {
    const state = COMPUTER_USE_SETTINGS_SPECIMEN_STATES[props.state] ?? COMPUTER_USE_SETTINGS_SPECIMEN_STATES.first!;
    const machine = 'devbox';
    return (
        <ItemList pageColumn="wide" testID={`computer-use-settings-specimen-${props.state}`}>
            <MachineTabSubHead
                placement="page"
                title={t('machineDetailPage.subPages.computer')}
                back={{ label: machine, onPress: NOOP, testID: 'computer-use-settings-specimen-back' }}
                description={t('computerUse.providers.pageDescription', { machine })}
            />
            <MachineComputerUseSectionView
                machineName={machine}
                online={state.online ?? true}
                preferences={state.preferences}
                unavailable={state.unavailable ?? false}
                providers={state.providers}
                mutation={state.mutation ?? { phase: 'idle' }}
                onToggle={NOOP}
                onRepair={NOOP}
                onChooseDefault={NOOP}
            />
        </ItemList>
    );
}
