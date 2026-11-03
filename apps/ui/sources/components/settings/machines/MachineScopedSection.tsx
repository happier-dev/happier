import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    presentMachineAdministrationTargetState,
    useMachineAdministrationTargetFilter,
    type MachineAdministrationTargetSelectorProps,
} from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** One machine sentence in the secondary ink with its one small control; it wraps, never cut (lab PD3). */
function MachineScopedLine(props: Readonly<{ testID: string; title: string; control: React.ReactNode }>) {
    const { theme } = useUnistyles();
    // A sentence, not a row title: body weight in the secondary ink.
    const titleStyle = React.useMemo(() => ({ ...Typography.default(), color: theme.colors.text.secondary }), [theme.colors.text.secondary]);
    return (
        <Item
            testID={props.testID}
            title={props.title}
            titleStyle={titleStyle}
            titleLines={0}
            mode="info"
            showChevron={false}
            rightElement={props.control}
            rightElementOutsidePressable
            accessoryLayout="adaptive"
        />
    );
}

/**
 * The line a surface shows when it needs a machine and none is chosen: what the machine is for, and the
 * one control that fixes it — the machine chooser itself, or, with no machine to choose, the way to set
 * one up. Choosing persists through the selection's own owner, so the surface reads the choice and moves on.
 */
export const MachineChoiceLine = React.memo(function MachineChoiceLine(props: Readonly<{
    selection: MachineAdministrationTargetSelectorProps['selection'];
    /** What a computer is needed for here. */
    invitation: string;
    testIDPrefix: string;
    resolveCandidateAvailability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability'];
}>) {
    const router = useRouter();
    const setUpComputer = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push('/(app)/settings/machines' as never));
        if (result !== true) fireAndForget(result, { tag: 'MachineChoiceLine.setUpComputer' });
    }, [router]);
    const filter = useMachineAdministrationTargetFilter({
        selection: props.selection,
        resolveCandidateAvailability: props.resolveCandidateAvailability,
        testIDPrefix: props.testIDPrefix,
    });
    return (
        <MachineScopedLine
            testID={`${props.testIDPrefix}.state`}
            title={props.invitation}
            control={props.selection.candidates.length > 0 ? (
                <SelectionListFilterChip
                    filter={{
                        ...filter,
                        // The selector's own unselected label, so the chip reads the same everywhere it appears.
                        valueLabel: t('newSession.selectMachineTitle'),
                        icon: undefined,
                        muted: false,
                        testID: `${props.testIDPrefix}.choose`,
                    }}
                />
            ) : (
                <RoundButton
                    testID={`${props.testIDPrefix}.setUp`}
                    size="small"
                    display="secondary"
                    title={t('settingsMachines.scopeSetUpComputer')}
                    onPress={setUpComputer}
                />
            )}
        />
    );
});

/**
 * The part of an Account page that runs on one computer ("On this computer", "Setup and status"):
 * a section whose header carries the machine chip, so the page around it never waits for a machine.
 *
 * Its rows render only while the chosen machine is online. With no machine it says what one is
 * needed for, and the line's one small control is the machine chooser itself (or, with no machine
 * to choose, leads to setting one up); no header chip repeats it. With an offline or unusable
 * machine it names the machine, keeps the last known fact when the caller has one, and offers
 * another; the chip stays in the header, because it is the control that recovers those states.
 * On a phone the line's control moves beneath its sentence.
 *
 * Untitled, it is a page's one machine line rather than a section: nothing while the chosen machine
 * is usable and there is nothing to run there, otherwise the line alone, its own chooser recovering
 * every state (no header to carry a chip).
 */
export const MachineScopedSection = React.memo(function MachineScopedSection(props: Readonly<{
    title?: string;
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
    /**
     * The line only, for a caller that already owns the sheet it belongs to (an Account's Sign-in group):
     * the machine's state then joins that group's rows instead of drawing a second sheet.
     */
    embedded?: boolean;
    children?: React.ReactNode;
}>) {
    const [chipOpen, setChipOpen] = React.useState(false);
    const openChip = React.useCallback(() => setChipOpen(true), []);
    // One machine filter: the header chip, which also recovers an offline or unusable machine.
    const filter = useMachineAdministrationTargetFilter({
        selection: props.selection,
        resolveCandidateAvailability: props.resolveCandidateAvailability,
        testIDPrefix: props.testIDPrefix,
        chipOpen,
        onChipOpenChange: setChipOpen,
    });
    const state = props.selection.state;
    const lineTestID = `${props.testIDPrefix}.state`;

    const untitled = props.title === undefined;
    let body: React.ReactNode;
    if (state.kind === 'online') {
        if (props.children == null || props.children === false) return null;
        body = props.children;
    } else if (state.kind === 'unselected') {
        body = (
            <MachineChoiceLine
                selection={props.selection}
                invitation={props.unselectedInvitation}
                testIDPrefix={props.testIDPrefix}
                resolveCandidateAvailability={props.resolveCandidateAvailability}
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
        body = <MachineScopedLine testID={lineTestID} title={title} control={untitled ? (
            <SelectionListFilterChip
                filter={{
                    ...filter,
                    valueLabel: t('settingsPlugins.targetSelection.chooseAnother'),
                    icon: undefined,
                    muted: false,
                    testID: `${props.testIDPrefix}.chooseAnother`,
                }}
            />
        ) : (
            <RoundButton
                testID={`${props.testIDPrefix}.chooseAnother`}
                size="small"
                display="secondary"
                title={t('settingsPlugins.targetSelection.chooseAnother')}
                onPress={openChip}
            />
        )} />;
    }

    if (props.embedded) return <>{body}</>;
    return (
        <ItemGroup
            title={props.title}
            description={props.description}
            action={state.kind === 'unselected' || untitled ? undefined : <SelectionListFilterChip filter={filter} />}
        >
            {body}
        </ItemGroup>
    );
});
