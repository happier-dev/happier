import * as React from 'react';
import { credentialBrokeredSourceUseMessage } from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import {
  teamCredentialCreatePath,
  type TeamCredentialSourceHint,
} from '@/components/settings/teams/teamsRoutes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { Icon } from '@/components/ui/icons/Icon';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import { ShareSheet } from '../ShareSheet';
import { presentShareSheet, type ShareSheetAnchor } from '../presentShareSheet';
import type {
  ShareLevelPresentation,
  ShareSheetActions,
  ShareSheetAdapter,
  ShareSheetModel,
} from '../shareSheetTypes';

const NO_TEAM_CONTEXTS: readonly [] = [];
const NO_OPERATIONS = Object.freeze({});
const NO_GRANTS: ShareSheetModel['grants'] = [];

/**
 * A credential's meaning of the one share sheet: one level, "Can use it". Recipients' agents use it
 * through the owner's machine and never see it; giving the value itself is not offered here.
 */
function createCredentialShareAdapter(source: TeamCredentialSourceHint): ShareSheetAdapter {
  const canUse: ShareLevelPresentation = {
    label: t('shareSheet.credentials.levels.canUse'),
    help: t('shareSheet.credentials.help.use'),
  };
  return {
    namespace: 'credential-share',
    title: t('shareSheet.credentials.title'),
    description: credentialBrokeredSourceUseMessage(source.kind === 'connected_account' ? source.account.service
      : source.kind === 'connected_pool' ? source.service : undefined) ?? t('shareSheet.credentials.description'),
    levels: {
      view: canUse,
      edit: { label: canUse.label },
      admin: { label: canUse.label },
    },
    showsLevelLock: () => true,
  };
}

/**
 * Adding a Team opens that Team's existing credential offer with this source chosen: the offer owns
 * where use runs (broker placement), the audience and the one create write (teams.credentials.create).
 */
function CredentialShareModal(
  props: CustomModalInjectedProps &
    Readonly<{ scope: ServerAccountScope; source: TeamCredentialSourceHint }>,
) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const directory = useSessionAccessDirectory({
    scope: props.scope,
    availability: 'available',
    contextTeams: NO_TEAM_CONTEXTS,
    operations: NO_OPERATIONS,
    revision: 0,
    enabled: true,
  });
  // Credentials are offered to Teams (their members and Groups are chosen in the offer).
  const sections = React.useMemo(
    () => directory.sections.filter((section) => section.kind === 'team'),
    [directory.sections],
  );
  const [adapter] = React.useState(() => createCredentialShareAdapter(props.source));
  const { onClose, scope, source } = props;
  const actions = React.useMemo<ShareSheetActions>(
    () => ({
      setQuery,
      retryDirectory: directory.retry,
      loadMore: directory.loadMore,
      addPrincipal: (principal) => {
        if (principal.kind !== 'team') return;
        onClose();
        router.push(
          teamCredentialCreatePath(
            { serverId: scope.serverId, teamId: principal.teamId },
            source,
          ) as never,
        );
      },
      retryMutation: () => {},
      setAccessLevel: () => {},
      requestRemove: () => {},
      confirmRemove: () => {},
      cancelRemove: () => {},
      explain: () => {},
    }),
    [
      directory.loadMore,
      directory.retry,
      onClose,
      router,
      scope.serverId,
      source,
    ],
  );
  const model = React.useMemo<ShareSheetModel>(
    () => ({
      revision: 0,
      editable: true,
      stale: false,
      owner: null,
      grants: NO_GRANTS,
      directory: { query, sections },
    }),
    [query, sections],
  );
  return (
    <ShareSheet
      model={model}
      actions={actions}
      adapter={adapter}
      presentation="full"
      onRequestClose={onClose}
      testID="credential-share"
    />
  );
}

/** One credential Share action, consumed by header buttons and overflow menus. */
export function useCredentialShareAction(props: Readonly<{
  name: string;
  source?: TeamCredentialSourceHint;
}>): ((anchor?: ShareSheetAnchor) => void) | null {
  const resolution = useServerCredentialAccountScopeResolution(props.source?.serverId);
  if (resolution.kind !== 'bound' || !props.source) return null;
  const scope = resolution.scope;
  const source = props.source;
  return (anchor) => {
    presentShareSheet({
      component: CredentialShareModal,
      props: { scope, source },
      title: t('shareSheet.documents.shareTitle', { name: props.name }),
      testID: 'credential-share-modal',
      ...(anchor ? { anchor } : {}),
    });
  };
}

/** A credential's secondary Share button, absent without a bound Home Account. */
export const CredentialShareButton = React.memo(function CredentialShareButton(
  props: Readonly<{
    testID: string;
    name: string;
    source: TeamCredentialSourceHint;
    disabled?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const share = useCredentialShareAction(props);
  if (!share) return null;
  return (
    <RoundButton
      testID={props.testID}
      size="small"
      display="secondary"
      title={t('secretsSettings.share')}
      leading={
        <Icon name="share" size={14} color={theme.colors.text.primary} />
      }
      disabled={props.disabled}
      onPress={(event?: unknown) => {
        share(resolvePressTriggerAnchor(event));
      }}
    />
  );
});
