import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type {
  ProjectSourceV1,
  SourceAttachmentV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { openProjectSetupShare } from '@/components/projects/projectSetup/ProjectSetupShareSheet';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
  resolveWorkspaceRefByAddress,
  selectSourceCheckoutWorkspaceRefs,
} from '@/sync/domains/workspaces/workspaceRefs';
import { t } from '@/text';
import { writeClipboardStringFromUi } from '@/utils/ui/clipboard';
import { fireAndForget } from '@/utils/system/fireAndForget';

type SetupAttachment = Extract<SourceAttachmentV1, { purpose: 'setup' }>;

/** The Source's shared setup attachment, when it carries one. */
export function readSourceSetupAttachment(
  source: ProjectSourceV1 | null,
): SetupAttachment | null {
  return (
    source?.attachments?.find(
      (attachment): attachment is SetupAttachment =>
        attachment.purpose === 'setup',
    ) ?? null
  );
}

/** This person's checkouts opened from the Source that this device can still resolve, in census order. */
export function useSourceCheckouts(
  sourceId: string | null,
  serverId: string,
): readonly WorkspaceAddressV2[] {
  const refs = useWorkspaceRefs();
  return React.useMemo(() => {
    const list = Array.isArray(refs) ? refs : [];
    return sourceId
      ? selectSourceCheckoutWorkspaceRefs(list, sourceId, serverId)
          .map(workspaceAddressFromRefV2)
          .filter(
            (address) =>
              resolveWorkspaceRefByAddress(list, address).kind === 'resolved',
          )
      : [];
  }, [refs, serverId, sourceId]);
}

/**
 * "Project setup" on a Source (lab L6 share/import, plan A §7): what the Source shares for setup and the
 * ways to act on it. Using it goes through Open and the checkout's own review; sharing goes through the
 * one Share setup sheet on a checkout of this Source; the link is the Home's own, from the Source read.
 */
export const SourceSetupSection = React.memo(function SourceSetupSection(
  props: Readonly<{
    source: ProjectSourceV1;
    serverId: string;
    canEdit: boolean;
    /** The link the Home renders for this Source's setup; null when this Home cannot render one. */
    setupLink: string | null;
    audience: string;
    onOpenSourceSharing: () => void;
    onDetach: (attachment: SetupAttachment) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const setup = readSourceSetupAttachment(props.source);
  const checkouts = useSourceCheckouts(props.source.id, props.serverId);
  const homes = React.useMemo(() => [props.serverId], [props.serverId]);
  const binding =
    useServerCredentialAccountScopeBindings(homes).get(props.serverId) ?? null;
  const { execute } = useMountedActionExecution(props.serverId);
  const shareFrom =
    checkouts.find(
      (
        address,
      ): address is Extract<WorkspaceAddressV2, { machineId: string }> =>
        !('kind' in address),
    ) ?? null;
  const { source, audience, onOpenSourceSharing, setupLink } = props;
  const share = React.useCallback(() => {
    if (!binding || !shareFrom) return;
    openProjectSetupShare({
      workspace: shareFrom,
      binding,
      source: { id: source.id, name: source.name, revision: source.revision },
      audience,
      onOpenSourceSharing,
    });
  }, [
    binding,
    shareFrom,
    source.id,
    source.name,
    source.revision,
    audience,
    onOpenSourceSharing,
  ]);
  const copy = React.useCallback(() => {
    if (!setupLink) return;
    fireAndForget(
      writeClipboardStringFromUi(setupLink, execute).then((result) => {
        if (result.ok)
          publishPresentationNotice({
            key: `project-source-setup-link:${source.id}`,
            severity: 'info',
            message: t('projects.sources.setupLinkCopied'),
          });
      }),
      { tag: 'SourceSetupSection.copyLink' },
    );
  }, [execute, setupLink, source.id]);
  const canShare = props.canEdit && binding !== null && shareFrom !== null;
  if (!setup && !canShare) return null;
  const icon = (name: 'link' | 'users' | 'wrench') => (
    <Icon name={name} size={18} color={theme.colors.text.secondary} />
  );
  return (
    <ItemGroup
      title={t('projects.sources.setupTitle')}
      description={t('projects.sources.setupDescription')}
    >
      {setup ? (
        <Item
          testID="projects.sources.detail.setup"
          icon={icon('wrench')}
          title={t('projects.sources.setupRowTitle')}
          subtitle={t('projects.sources.setupRevision', {
            revision: setup.contentRevision.bodyVersion,
          })}
          showChevron={false}
          rightElementOutsidePressable={props.canEdit}
          rightElement={
            props.canEdit ? (
              <RoundButton
                testID="projects.sources.detail.setup.detach"
                size="small"
                display="secondary"
                title={t('projects.sources.detach')}
                onPress={() => props.onDetach(setup)}
              />
            ) : undefined
          }
        />
      ) : (
        <Item
          testID="projects.sources.detail.setup.none"
          mode="info"
          title={t('projects.sources.setupNone')}
          showChevron={false}
        />
      )}
      {setup && setupLink ? (
        <Item
          testID="projects.sources.detail.setup.copyLink"
          icon={icon('link')}
          title={t('projects.sources.copySetupLink')}
          showChevron={false}
          onPress={copy}
        />
      ) : null}
      {canShare ? (
        <Item
          testID="projects.sources.detail.setup.share"
          icon={icon('users')}
          title={t('projects.scripts.share.menu')}
          onPress={share}
        />
      ) : null}
    </ItemGroup>
  );
});
