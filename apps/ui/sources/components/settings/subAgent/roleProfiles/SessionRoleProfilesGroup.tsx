import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
    addCustomSessionRoleProfileV1,
    createCustomSessionRoleIdV1,
    DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1,
    removeCustomSessionRoleProfileV1,
    SessionRoleBadgeColorV1Schema,
    SessionRoleProfilesV1Schema,
    setBuiltInSessionRoleDisplayNameV1,
    setBuiltInSessionRoleProfileV1,
    updateCustomSessionRoleProfileV1,
    type BuiltInSessionRole,
    type CustomSessionRoleId,
} from '@happier-dev/protocol';

import { resolveAssignableSessionRoleProfileDisplayName } from '@/components/sessions/roles/sessionRoleLabels';
import { listUiAssignableSessionRoleProfiles } from '@/components/sessions/roles/sessionRoleProfileOrder';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { storage, useSettingMutable } from '@/sync/domains/state/storage';
import { randomUUID } from '@/platform/randomUUID';
import { Modal } from '@/modal';
import { t } from '@/text';

import { showSessionRoleProfileEditorModal } from './showSessionRoleProfileEditorModal';

/**
 * Account-wide Planner/Project Manager/Worker/Reviewer instructions. Edits apply to future assignments and
 * explicit reapplies; sessions already holding a role keep their retained snapshot.
 */
export function SessionRoleProfilesGroup() {
    const { theme } = useUnistyles();
    const [profiles, setProfiles] = useSettingMutable('sessionRoleProfilesV1');

    const parsedProfiles = SessionRoleProfilesV1Schema.safeParse(profiles).data;
    const assignableProfiles = listUiAssignableSessionRoleProfiles({ sessionRoleProfilesV1: profiles });
    const updateLatestProfiles = React.useCallback((update: (latest: unknown) => unknown | null) => {
        const latest = storage.getState().settings.sessionRoleProfilesV1;
        const next = update(latest);
        if (next !== null) setProfiles(next as typeof profiles);
    }, [setProfiles]);

    const editBuiltInRole = React.useCallback(async (role: BuiltInSessionRole) => {
        const profile = listUiAssignableSessionRoleProfiles({ sessionRoleProfilesV1: profiles }).find((candidate) => candidate.id === role);
        if (!profile) return;
        const override = SessionRoleProfilesV1Schema.safeParse(profiles).data?.instructionsByRole[role]?.trim();
        const result = await showSessionRoleProfileEditorModal({
            role,
            displayName: profile.displayName,
            instructions: profile.instructions,
            color: profile.color,
            isCustom: Boolean(override),
        });
        if (!result) return;
        if (result.kind === 'delete') return;
        updateLatestProfiles((latest) => {
            if (result.kind === 'reset') {
                return setBuiltInSessionRoleDisplayNameV1(
                    setBuiltInSessionRoleProfileV1(latest, role, { instructions: null, color: null }),
                    role,
                    null,
                );
            }
            let next = setBuiltInSessionRoleProfileV1(latest, role, {
                instructions: result.instructions,
                ...(result.color ? { color: result.color } : {}),
            });
            if (result.displayName !== undefined) {
                next = setBuiltInSessionRoleDisplayNameV1(next, role, result.displayName);
            }
            return next;
        });
    }, [profiles, updateLatestProfiles]);

    const editCustomRole = React.useCallback(async (role: CustomSessionRoleId) => {
        const profile = SessionRoleProfilesV1Schema.safeParse(profiles).data?.customRoles?.find((candidate) => candidate.id === role);
        if (!profile) return;
        const result = await showSessionRoleProfileEditorModal({
            role,
            name: profile.name,
            instructions: profile.instructions,
            color: profile.color,
            isCustom: true,
            customProfile: true,
        });
        if (!result) return;
        if (result.kind === 'delete') {
            const confirmed = await Modal.confirm(
                t('sessionRole.profiles.deleteTitle'),
                t('sessionRole.profiles.deleteExistingSessionsUnchanged'),
                { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
            );
            if (confirmed) updateLatestProfiles((latest) => {
                const current = SessionRoleProfilesV1Schema.safeParse(latest).data?.customRoles?.some((candidate) => candidate.id === role);
                return current ? removeCustomSessionRoleProfileV1(latest, role) : null;
            });
            return;
        }
        if (result.kind === 'save' && result.name && result.color) {
            updateLatestProfiles((latest) => {
                const current = SessionRoleProfilesV1Schema.safeParse(latest).data?.customRoles?.some((candidate) => candidate.id === role);
                return current ? updateCustomSessionRoleProfileV1(latest, role, {
                    name: result.name!,
                    instructions: result.instructions,
                    color: result.color!,
                }) : null;
            });
        }
    }, [profiles, updateLatestProfiles]);

    const addCustomRole = React.useCallback(async () => {
        const result = await showSessionRoleProfileEditorModal({
            role: null,
            name: '',
            instructions: '',
            color: null,
            isCustom: true,
            customProfile: true,
        });
        if (result?.kind !== 'save' || !result.name || !result.color) return;
        const { name, instructions, color } = result;
        updateLatestProfiles((latest) => addCustomSessionRoleProfileV1(latest, {
            id: createCustomSessionRoleIdV1(randomUUID()),
            name,
            instructions,
            color: SessionRoleBadgeColorV1Schema.parse(color),
        }));
    }, [updateLatestProfiles]);

    return (
        <ItemGroup title={t('sessionRole.profiles.groupTitle')} footer={t('sessionRole.profiles.footer')}>
            {assignableProfiles.map((profile) => {
                if (profile.kind === 'custom') {
                    const role = profile.id as CustomSessionRoleId;
                    return (
                        <Item
                            key={role}
                            testID={`session-role-profile-${role}`}
                            title={profile.name}
                            subtitle={profile.instructions}
                            subtitleLines={2}
                            detail={t('sessionRole.profiles.customRole')}
                            icon={<Icon name="user-circle" size={29} color={profile.color ?? theme.colors.text.secondary} />}
                            onPress={() => { void editCustomRole(role); }}
                        />
                    );
                }
                const role = profile.id as BuiltInSessionRole;
                const isCustom = profile.instructions !== DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[role]
                    || profile.displayName !== null
                    || profile.color !== null;
                return (
                    <Item
                        key={role}
                        testID={`session-role-profile-${role}`}
                        title={resolveAssignableSessionRoleProfileDisplayName(profile)}
                        subtitle={profile.instructions}
                        subtitleLines={2}
                        detail={isCustom ? t('sessionRole.profiles.customized') : t('sessionRole.profiles.builtIn')}
                        icon={<Icon name="user-circle" size={29} color={profile.color ?? theme.colors.text.secondary} />}
                        onPress={() => { void editBuiltInRole(role); }}
                    />
                );
            })}
            <Item
                testID="session-role-profile-add-custom"
                title={t('sessionRole.profiles.addCustom')}
                subtitle={t('sessionRole.profiles.addCustomSubtitle')}
                icon={<Icon name="plus-circle" size={29} color={theme.colors.text.secondary} />}
                onPress={() => { void addCustomRole(); }}
            />
        </ItemGroup>
    );
}
