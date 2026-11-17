import * as React from 'react';
import type { ApprovalProfileV1, ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { createApprovalProfileFromStart, type ApprovalProfileWriter } from './approvalProfileWrites';
import { useApprovalProfileMachineNames } from './useApprovalProfileMachineNames';
import { buildApprovalProfileSettingsRoute } from './approvalProfileSettingsRoute';

const BLANK_START_ID = 'blank';

/** One line under a profile's name: how much it changes, then where it is the default. */
function describeProfile(profile: ApprovalProfileV1, defaultOn: readonly string[]): string {
    const changed = Object.keys({ ...profile.actions, ...profile.approvalWaivedSurfaces }).length;
    const parts = [changed === 0
        ? t('workflows.triggers.guided.profile.followsAccount')
        : t('workflows.triggers.guided.profile.actionsChanged', { count: changed })];
    if (defaultOn.length > 0) parts.push(t('workflows.triggers.guided.profile.defaultOnList', { machines: defaultOn.join(', ') }));
    return parts.join(' · ');
}

/**
 * Settings → Actions "Approval profiles": the Account's saved profiles. A profile opens the Actions list in its own
 * context; New profile starts Blank or as a copy of one already saved.
 */
export const ApprovalProfilesSection = React.memo(function ApprovalProfilesSection(props: Readonly<{
    profileRows: readonly ReadableApprovalProfileV1[];
    machineApprovalProfiles: Readonly<Record<string, string>> | undefined;
    write: ApprovalProfileWriter;
}>) {
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const machineNames = useApprovalProfileMachineNames(props.machineApprovalProfiles);
    const starts = React.useMemo<DropdownMenuItem[]>(() => [
        { id: BLANK_START_ID, testID: 'settings-actions:approval-profile-add:blank', title: t('workflows.triggers.guided.profile.startBlank') },
        ...props.profileRows.map(({ profile }) => ({ id: profile.id, testID: `settings-actions:approval-profile-add:copy:${profile.id}`,
            title: t('workflows.triggers.guided.profile.startCopyOf', { name: profile.name }) })),
    ], [props.profileRows]);
    const start = async (startId: string) => {
        setOpen(false);
        const source = startId === BLANK_START_ID ? null : props.profileRows.find(row => row.id === startId)?.profile ?? null;
        const created = await createApprovalProfileFromStart(props.write, source);
        if (created) router.push(buildApprovalProfileSettingsRoute(created.id));
    };
    return (
        <ItemGroup
            testID="settings-actions:approval-profiles"
            title={t('workflows.triggers.guided.profile.sectionTitle')}
            description={t('workflows.triggers.guided.profile.sectionDescription')}
            action={(
                <DropdownMenu
                    testID="settings-actions:approval-profile-add-menu"
                    open={open}
                    onOpenChange={setOpen}
                    items={starts}
                    allowEmptySelection
                    onSelect={(id) => { void start(id); }}
                    placement="bottom"
                    popoverAnchorAlign="end"
                    variant="slim"
                    matchTriggerWidth={false}
                    trigger={({ toggle }) => (
                        <RoundButton
                            testID="settings-actions:approval-profile-add"
                            size="small"
                            display="inverted"
                            title={t('workflows.triggers.guided.profile.add')}
                            onPress={toggle}
                        />
                    )}
                />
            )}
        >
            {props.profileRows.length === 0 ? (
                <Item testID="settings-actions:approval-profiles:empty" title={t('workflows.triggers.guided.profile.empty')}
                    mode="info" showChevron={false} />
            ) : props.profileRows.map(({ profile }) => (
                <Item
                    key={profile.id}
                    testID={`settings-actions:approval-profile:${profile.id}`}
                    title={profile.name}
                    subtitle={describeProfile(profile, machineNames.defaultOn(profile.id))}
                    icon={<Icon name="list-checks" />}
                    onPress={() => router.push(buildApprovalProfileSettingsRoute(profile.id))}
                />
            ))}
        </ItemGroup>
    );
});

