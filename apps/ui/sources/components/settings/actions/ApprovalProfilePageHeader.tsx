import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ApprovalProfileV1, ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';

import { Stack, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { APPROVAL_PROFILE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { HEADER_ACTIONS_GAP_PX, PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { t } from '@/text';

import { confirmDeleteApprovalProfile, createApprovalProfileFromStart, renameApprovalProfile, setApprovalProfileMachineDefault,
    type ApprovalProfileWriter } from './approvalProfileWrites';
import { buildApprovalProfileSettingsRoute } from './approvalProfileSettingsRoute';
import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useApprovalProfileMachineNames } from './useApprovalProfileMachineNames';
import { useApprovalProfileAudience } from './useApprovalProfileAudience';
import { joinList } from '@/utils/text/joinList';

const stylesheet = StyleSheet.create(() => ({
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: HEADER_ACTIONS_GAP_PX },
}));

/**
 * A profile's page head: its name and what it changes, then the Machines where it is my Sessions' default. Its owner
 * shares it (the Artifact share sheet owns grants) and keeps Rename and Delete in "…". Someone it was shared with sees
 * who shared it and what they may do; a person who can only use it duplicates it to change it.
 * A deleted or unknown profile says so instead of showing an Actions list it cannot edit.
 */
export const ApprovalProfilePageHeader = React.memo(function ApprovalProfilePageHeader(props: Readonly<{
    profileRow: ReadableApprovalProfileV1 | null;
    machineApprovalProfiles: Readonly<Record<string, string>> | undefined;
    write: ApprovalProfileWriter;
    machineChip: React.ReactNode;
}>) {
    const router = useRouter();
    const { profileRow, write } = props;
    // The profile's Automations read its own Home: the Account this settings page belongs to.
    const serverId = useActiveServerAccountScope()?.serverId;
    const profile = profileRow?.profile ?? null;
    const title = profile?.name ?? t('workflows.triggers.guided.profile.notFoundTitle');
    const screenOptions = React.useMemo(() => ({ headerTitle: title }), [title]);
    const access = profileRow?.access ?? null;
    const manages = access === 'owner' || access === 'admin';
    const changes = manages || access === 'edit';
    const menu = React.useMemo<PageHeaderMenuAction[]>(() => profileRow && changes ? [
        { id: 'rename', testID: 'settings-actions:approval-profile-page:rename', title: t('workflows.triggers.guided.profile.rename'),
            onSelect: () => renameApprovalProfile(write, profileRow) },
        ...(manages ? [{ id: 'delete', testID: 'settings-actions:approval-profile-page:delete', title: t('common.delete'), destructive: true,
            // The profile's page has nothing left to show, so it returns to the Actions list it came from.
            onSelect: async () => { if (await confirmDeleteApprovalProfile(write, profileRow)) router.replace('/settings/actions'); } }] : []),
    ] : [], [changes, manages, profileRow, router, write]);
    const share = React.useCallback((event?: unknown) => {
        if (!profileRow) return;
        showDocumentShareSheet({ anchor: resolvePressTriggerAnchor(event), kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1,
            artifactId: profileRow.id, name: profileRow.profile.name, linkPath: buildApprovalProfileSettingsRoute(profileRow.id),
            kindLabel: t('workflows.triggers.guided.profile.title'), description: t('workflows.triggers.guided.profile.shareDescription') });
    }, [profileRow]);
    const duplicate = React.useCallback(async () => {
        if (!profileRow) return;
        const created = await createApprovalProfileFromStart(write, profileRow.profile);
        if (created) router.push(buildApprovalProfileSettingsRoute(created.id));
    }, [profileRow, router, write]);
    // Its owner reads who it is shared with from the profile's own grant roster; nothing reads defaults back from a
    // profile (Plan 03 R19), so the line names its audience only.
    const audience = useApprovalProfileAudience(manages ? profileRow?.id ?? null : null);
    const sharedWith = React.useMemo(() => {
        const names = audience?.grants?.flatMap(grant => grant.display.name?.trim() || grant.display.username?.trim() || []) ?? [];
        return names.length > 0 ? t('workflows.triggers.guided.profile.sharedWith', { names: joinList(names) }) : null;
    }, [audience]);
    const meta = React.useMemo<PageHeaderMetaFact[] | undefined>(() => !profileRow ? undefined
        : manages ? (sharedWith ? [{ key: 'audience', text: sharedWith }] : undefined) : [
        ...(profileRow.ownerDisplayName ? [{ key: 'owner', text: t('workflows.triggers.guided.profile.sharedBy', { name: profileRow.ownerDisplayName }) }] : []),
        { key: 'access', text: t(changes ? 'workflows.triggers.guided.profile.sharedWithYouToChange' : 'workflows.triggers.guided.profile.sharedWithYouToUse') },
    ], [changes, manages, profileRow, sharedWith]);
    return (
        <>
            <Stack.Screen options={screenOptions} />
            <PageHeader
                testID="settings-actions:approval-profile-page:header"
                title={title}
                description={profile ? t('workflows.triggers.guided.profile.pageDescription')
                    : t('workflows.triggers.guided.profile.notFoundDescription')}
                {...(meta ? { meta } : {})}
                actions={profile ? (
                    <View style={stylesheet.headerActions}>
                        {manages ? (
                            <SectionActionButton testID="settings-actions:approval-profile-page:share" icon="users"
                                title={t('workflows.triggers.guided.profile.share')} onPress={share} />
                        ) : changes ? null : (
                            <SectionActionButton testID="settings-actions:approval-profile-page:duplicate" icon="copy"
                                title={t('workflows.triggers.guided.profile.duplicateToChange')} onPress={() => { void duplicate(); }} />
                        )}
                        {props.machineChip}
                        {menu.length > 0 ? <PageHeaderMenu testID="settings-actions:approval-profile-page:menu" actions={menu} /> : null}
                    </View>
                ) : undefined}
            />
            {profile ? <ApprovalProfileDefaultOn profile={profile} machineApprovalProfiles={props.machineApprovalProfiles} write={write} /> : null}
            {profile && serverId ? (
                <SubjectTriggersSection subject={{ kind: 'approvalProfile', serverId, profileId: profile.id }} subjectName={profile.name} />
            ) : null}
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
