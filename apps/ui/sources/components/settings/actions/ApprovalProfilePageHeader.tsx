import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ApprovalProfileV1, ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';

import { Stack, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { HEADER_ACTIONS_GAP_PX, PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { t } from '@/text';

import { confirmDeleteApprovalProfile, renameApprovalProfile, setApprovalProfileMachineDefault,
    type ApprovalProfileWriter } from './approvalProfileWrites';
import { useApprovalProfileMachineNames } from './useApprovalProfileMachineNames';

const stylesheet = StyleSheet.create(() => ({
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: HEADER_ACTIONS_GAP_PX },
}));

/**
 * A profile's page head: its name and what it changes, Rename and Delete in "…", then the Machines where it is my
 * Sessions' default. A deleted or unknown profile says so instead of showing an Actions list it cannot edit.
 */
export const ApprovalProfilePageHeader = React.memo(function ApprovalProfilePageHeader(props: Readonly<{
    profileRow: ReadableApprovalProfileV1 | null;
    machineApprovalProfiles: Readonly<Record<string, string>> | undefined;
    write: ApprovalProfileWriter;
    machineChip: React.ReactNode;
}>) {
    const router = useRouter();
    const { profileRow, write } = props;
    const profile = profileRow?.profile ?? null;
    const title = profile?.name ?? t('workflows.triggers.guided.profile.notFoundTitle');
    const screenOptions = React.useMemo(() => ({ headerTitle: title }), [title]);
    const menu = React.useMemo<PageHeaderMenuAction[]>(() => profileRow ? [
        { id: 'rename', testID: 'settings-actions:approval-profile-page:rename', title: t('workflows.triggers.guided.profile.rename'),
            onSelect: () => renameApprovalProfile(write, profileRow) },
        { id: 'delete', testID: 'settings-actions:approval-profile-page:delete', title: t('common.delete'), destructive: true,
            // The profile's page has nothing left to show, so it returns to the Actions list it came from.
            onSelect: async () => { if (await confirmDeleteApprovalProfile(write, profileRow)) router.replace('/settings/actions'); } },
    ] : [], [profileRow, router, write]);
    return (
        <>
            <Stack.Screen options={screenOptions} />
            <PageHeader
                testID="settings-actions:approval-profile-page:header"
                title={title}
                description={profile ? t('workflows.triggers.guided.profile.pageDescription')
                    : t('workflows.triggers.guided.profile.notFoundDescription')}
                actions={profile ? (
                    <View style={stylesheet.headerActions}>
                        {props.machineChip}
                        <PageHeaderMenu testID="settings-actions:approval-profile-page:menu" actions={menu} />
                    </View>
                ) : undefined}
            />
            {profile ? <ApprovalProfileDefaultOn profile={profile} machineApprovalProfiles={props.machineApprovalProfiles} write={write} /> : null}
        </>
    );
});

/** "Default on": the Machines whose Sessions of mine use this profile; the menu turns each one on or off. */
function ApprovalProfileDefaultOn(props: Readonly<{
    profile: ApprovalProfileV1;
    machineApprovalProfiles: Readonly<Record<string, string>> | undefined;
    write: ApprovalProfileWriter;
}>) {
    const [open, setOpen] = React.useState(false);
    const machines = useApprovalProfileMachineNames(props.machineApprovalProfiles);
    const defaultOn = machines.defaultOn(props.profile.id);
    const items = React.useMemo<DropdownMenuItem[]>(() => machines.all.map(machine => ({
        id: machine.id,
        testID: `settings-actions:approval-profile-page:default-on:${machine.id}`,
        title: machine.name,
        multiSelect: true,
        checked: props.machineApprovalProfiles?.[machine.id] === props.profile.id,
    })), [machines.all, props.machineApprovalProfiles, props.profile.id]);
    const toggle = (machineId: string) => {
        const on = props.machineApprovalProfiles?.[machineId] === props.profile.id;
        void setApprovalProfileMachineDefault(props.write, machineId, on ? null : props.profile.id);
    };
    return (
        <ItemGroup testID="settings-actions:approval-profile-page:default-on-group">
            <DropdownMenu
                testID="settings-actions:approval-profile-page:default-on"
                open={open}
                onOpenChange={setOpen}
                items={items}
                allowEmptySelection
                onSelect={(id) => toggle(id)}
                itemTrigger={{
                    title: t('workflows.triggers.guided.profile.defaultOnTitle'),
                    subtitle: t('workflows.triggers.guided.profile.defaultOnDescription'),
                    detailFormatter: () => defaultOn.length > 0 ? defaultOn.join(', ') : t('workflows.triggers.guided.profile.defaultOnNone'),
                    showSelectedSubtitle: false,
                }}
            />
        </ItemGroup>
    );
}
