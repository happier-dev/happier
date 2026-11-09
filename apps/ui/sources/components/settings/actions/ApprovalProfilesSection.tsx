import * as React from 'react';
import { View } from 'react-native';
import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';

import { presentApprovalProfile } from '@/components/approvals/approvalProfilePresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { Modal } from '@/modal';
import { t } from '@/text';

import { ApprovalProfileEditor } from './ApprovalProfileEditor';

/**
 * Settings → Actions "Approval profiles" (OPS-AUTOMATIONS-1102 D4): the Account's profiles, built-ins
 * first. A custom profile opens its editor; New profile opens an empty one. Writes go through the
 * profile Action only.
 */
export const ApprovalProfilesSection = React.memo(
  function ApprovalProfilesSection() {
    const { profiles, ready, upsertProfile, deleteProfile } =
      useApprovalProfiles();
    const anchor = React.useRef<View>(null);
    const [editing, setEditing] = React.useState<Readonly<{
      profile: ApprovalProfileV1 | null;
    }> | null>(null);
    const close = React.useCallback(() => setEditing(null), []);
    const save = async (profile: ApprovalProfileV1) =>
      (await upsertProfile(profile)).ok;
    const confirmDelete = (id: string) => {
      void Modal.alert(
        t('workflows.triggers.guided.profile.deleteTitle'),
        t('workflows.triggers.guided.profile.deleteMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('common.delete'),
            style: 'destructive',
            onPress: async () => {
              const result = await deleteProfile(id);
              if (result.ok) close();
              else
                void Modal.alert(
                  t('common.error'),
                  t('workflows.triggers.section.saveFailed'),
                );
            },
          },
        ],
      );
    };
    const editingProfile = editing?.profile ?? null;
    return (
      <ItemGroup
        testID="settings-actions:approval-profiles"
        title={t('workflows.triggers.guided.profile.sectionTitle')}
        // What profiles are for, then the boundary they are not: Agent isolation.
      description={`${t('workflows.triggers.guided.profile.sectionDescription')} ${t('workflows.triggers.guided.profile.isolationNotice')}`}
        action={
          <View ref={anchor} collapsable={false}>
            <RoundButton
              testID="settings-actions:approval-profile-add"
              size="small"
              display="inverted"
              title={t('workflows.triggers.guided.profile.add')}
              disabled={!ready}
              onPress={() => setEditing({ profile: null })}
            />
          </View>
        }
      >
        {(ready
          ? profiles
          : profiles.filter((profile) => profile.id.startsWith('builtin:'))
        ).map((profile) => {
          const presented = presentApprovalProfile(profile);
          return (
            <Item
              key={profile.id}
              testID={`settings-actions:approval-profile:${profile.id}`}
              title={presented.title}
              {...(presented.subtitle ? { subtitle: presented.subtitle } : {})}
              subtitleLines={0}
              {...(presented.builtIn
                ? {
                    detail: t('workflows.triggers.guided.profile.builtIn'),
                    showChevron: false,
                  }
                : { onPress: () => setEditing({ profile }) })}
            />
          );
        })}
        {editing ? (
          <ApprovalProfileEditor
            key={editingProfile?.id ?? 'new'}
            anchorRef={anchor}
            profile={editingProfile}
            onSave={save}
            {...(editingProfile
              ? { onDelete: () => confirmDelete(editingProfile.id) }
              : {})}
            onRequestClose={close}
          />
        ) : null}
      </ItemGroup>
    );
  },
);

