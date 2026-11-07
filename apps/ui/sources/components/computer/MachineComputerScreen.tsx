import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SESSION_VIEWER_DEFAULT_ASPECT, SESSION_VIEWER_PERMISSION_MIN_BODY } from '@/components/sessions/viewer/sessionViewerGeometry';
import type { ComputerMachinePersonScope } from '@/sync/domains/computer/computerControlClient';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { ComputerScreenViewer } from './ComputerScreenViewer';
import { useMachineComputerScreen } from './useComputerScreen';

const styles = StyleSheet.create(() => ({
    picture: { width: '100%', aspectRatio: SESSION_VIEWER_DEFAULT_ASPECT, minHeight: SESSION_VIEWER_PERMISSION_MIN_BODY },
}));

/** The Machine page binds the same Computer owner to its signed-in person, without an agent Session. */
export function MachineComputerScreen(props: Readonly<{ serverId: string; machineId: string }>) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(props.serverId);
    const scope = React.useMemo<ComputerMachinePersonScope | null>(() => binding ? {
        serverId: props.serverId, machineId: props.machineId,
        source: { kind: 'machine-person', personId: binding.scope.accountId },
    } : null, [binding, props.machineId, props.serverId]);
    return (
        <ItemGroup surface="none">
            <View style={styles.picture}>
                {scope && binding ? <MachineComputerScreenBody scope={scope} accountLifetime={binding} /> : (
                    <SurfaceStateCard testID="machine-computer-screen-binding" kind={resolution.kind === 'resolving' ? 'loading' : 'unavailable'}
                        title={t(resolution.kind === 'resolving' ? 'common.loading' : 'computerUse.presentation.tabFallback')} />
                )}
            </View>
        </ItemGroup>
    );
}

function MachineComputerScreenBody(props: Readonly<{ scope: ComputerMachinePersonScope; accountLifetime: ServerAccountScopeLifetime }>) {
    const { resolveChooseWindow: _anchoredPicker, ...model } = useMachineComputerScreen(props);
    const compact = useDeviceType() === 'phone';
    return <ComputerScreenViewer {...model} compact={compact} testID="machine-computer-screen" />;
}
