import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    MachineAdministrationTargetSelector,
    presentMachineAdministrationTargetState,
    type MachineAdministrationTargetSelectorProps,
} from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The part of an Account page that runs on one computer ("On this computer", "Setup and status"):
 * a section whose header carries the machine chip, so the page around it never waits for a machine.
 *
 * Its rows render only while the chosen machine is online. With no machine it says what one is
 * needed for and opens the chip's list (or, with no machine to choose, leads to setting one up);
 * with an offline or unusable machine it names the machine,
 * keeps the last known fact when the caller has one, and offers another. The chip stays in the
 * header through every state, because it is the control that recovers them.
 */
export const MachineScopedSection = React.memo(function MachineScopedSection(props: Readonly<{
    title: string;
    description?: string;
    selection: MachineAdministrationTargetSelectorProps['selection'];
    resolveCandidateAvailability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability'];
    /** What a computer is needed for here, said when none is chosen. */
    unselectedInvitation: string;
    /** The last known fact for an offline machine ("Last test: working, yesterday 18:20."). */
    offlineDetail?: string | null;
    /** Why the chosen machine is locked, when the domain knows ("Locked by its owner"). */
    lockedReason?: string | null;
    testIDPrefix: string;
    children: React.ReactNode;
}>) {
    const router = useRouter();
    const [chipOpen, setChipOpen] = React.useState(false);
    const openChip = React.useCallback(() => setChipOpen(true), []);
    const setUpComputer = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push('/(app)/settings/machines' as never));
        if (result !== true) fireAndForget(result, { tag: 'MachineScopedSection.setUpComputer' });
    }, [router]);
    const state = props.selection.state;
    const lineTestID = `${props.testIDPrefix}.state`;

    let body: React.ReactNode;
    if (state.kind === 'online') {
        body = props.children;
    } else if (state.kind === 'unselected') {
        body = (
            <EmptyState
                testID={lineTestID}
                layout="line"
                title={props.unselectedInvitation}
                primaryAction={state.candidates.length > 0 ? {
                    testID: `${props.testIDPrefix}.choose`,
                    label: t('settingsMachines.scopeChooseComputer'),
                    onPress: openChip,
                } : {
                    testID: `${props.testIDPrefix}.setUp`,
                    label: t('settingsMachines.scopeSetUpComputer'),
                    onPress: setUpComputer,
                }}
            />
        );
    } else if (state.kind === 'missing' && state.inventoryKnown === false && (state.inventoryStatus ?? 'loading') === 'loading') {
        // The machine's Home has not listed its machines yet: not known to be gone.
        body = <SurfaceStateCard testID={lineTestID} size="line" kind="loading" title={t('common.loading')} />;
    } else {
        const presentation = presentMachineAdministrationTargetState(state);
        const title = state.kind === 'offline'
            ? [t('settingsMachines.scopeOffline', { machine: presentation.title }), props.offlineDetail]
                .filter(Boolean)
                .join(' ')
            : [presentation.title, state.kind === 'locked' ? props.lockedReason : null, presentation.detail]
                .filter(Boolean)
                .join(' · ');
        body = (
            <EmptyState
                testID={lineTestID}
                layout="line"
                title={title}
                primaryAction={{
                    testID: `${props.testIDPrefix}.chooseAnother`,
                    label: t('settingsPlugins.targetSelection.chooseAnother'),
                    onPress: openChip,
                }}
            />
        );
    }

    return (
        <ItemGroup
            title={props.title}
            description={props.description}
            action={(
                <MachineAdministrationTargetSelector
                    selection={props.selection}
                    presentation="chip"
                    resolveCandidateAvailability={props.resolveCandidateAvailability}
                    testIDPrefix={props.testIDPrefix}
                    chipOpen={chipOpen}
                    onChipOpenChange={setChipOpen}
                />
            )}
        >
            {body}
        </ItemGroup>
    );
});
