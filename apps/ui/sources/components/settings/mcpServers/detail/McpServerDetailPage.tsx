import * as React from 'react';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';

import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { PageLeaveActions } from '@/components/ui/layout/PageLeaveActions';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { Modal } from '@/modal';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { ValueRefEditorModal, getValueRefEditorModalTitle } from '@/components/ui/forms/valueRefs/ValueRefEditorModal';
import { createMcpServerRecovery } from './mcpServerRecovery';
import { useMcpServerInstallLink } from './useMcpServerInstallLink';

import { McpServerConfigurationSection, type McpConfigurationSaveState } from '../McpServerConfigurationSection';
import { mcpServerMissingKeyNames, type McpSavedSecretAvailability } from '../status/mcpServerStatus';
import { mcpServerDisplayName } from '../collection/mcpServerCollectionModel';
import { HappierBrandMark, type HostCatalogMark } from '@/components/ui/media/HappierBrandMark';
import { McpServerConflictReview, type McpServerConflict } from './McpServerConflictReview';
import { McpServerMachineDifferences } from './McpServerMachineDifferences';
import { McpServerUpdateSection } from './McpServerUpdateSection';
import { McpSignInSection } from '../signIn/McpSignInSection';
import {
  McpServerBanner,
  McpServerMachinesAndDetails,
  McpServerWhereAndTools,
  useMcpServerDetail,
} from './McpServerDetailBody';

const INSTALL_LINK_NOTICE_KEY = 'mcp.server.installLinkCopy';

/**
 * A saved MCP server (md A order): who it is, the one thing blocking it, Where it's on, its Tools, its
 * Configuration, what it looks like on each machine, the Details, and the way out.
 */
export const McpServerDetailPage = React.memo(function McpServerDetailPage(
  props: Readonly<{
    server: McpServerCatalogEntryV1;
    brandMark?: HostCatalogMark;
    draftServer: McpServerCatalogEntryV1;
    configurationBaseServer?: McpServerCatalogEntryV1 | null;
    catalogRevision: number | 'absent' | null;
    secrets: SavedSecret[];
    secretAvailability: McpSavedSecretAvailability;
    scope: AccountSettingsScope | null | undefined;
    /** A Configuration value was committed (blur, a type or secret chosen): save it now. */
    onCommitConfiguration: () => void;
    configurationSaveState: McpConfigurationSaveState;
    /** The open edit met another writer's change: this page presents Changed elsewhere · Review. */
    configurationConflict?: McpServerConflict | null;
    onRemove: () => void;
    onDuplicate: () => void | Promise<void>;
    approvalNotice: React.ReactNode;
    onChangeServer: (
      updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1,
    ) => void;
  }>,
) {
  const { server } = props;
  const { secretAvailability } = props;
  const router = useRouter();
  const recovery = React.useMemo(() => createMcpServerRecovery({
    server: props.draftServer,
    missingKeys: mcpServerMissingKeyNames(props.draftServer, secretAvailability),
    isMissingReference: ref => secretAvailability.resolveReference(ref).status !== 'ready',
    scopeServerId: props.scope?.serverId,
    onChangeServer: props.onChangeServer,
    onCommit: props.onCommitConfiguration,
    openRoute: route => router.push(route as never),
    openEditor: editor => Modal.show({ component: ValueRefEditorModal,
      props: { ...editor, lockKey: true, secrets: props.secrets, scope: props.scope },
      chrome: { kind: 'card', title: getValueRefEditorModalTitle(editor.kind), dimensions: { size: 'lg' } }, closeOnBackdrop: true }),
  }), [props.draftServer, props.onChangeServer, props.onCommitConfiguration, props.scope, props.secrets, router, secretAvailability]);
  const detail = useMcpServerDetail(
    server,
    props.catalogRevision,
    secretAvailability,
    recovery,
  );
  const installLink = useMcpServerInstallLink(detail.execution, server.id, props.catalogRevision);
  const { onDuplicate } = props;
  const writeClipboard = useClipboardWrite(props.scope);
  // Rare operations behind the header's ⋯. The link is offered only when the Home produced one.
  const menuItems = React.useMemo((): readonly PageHeaderMenuAction[] => [
    {
      id: 'duplicate',
      testID: 'mcp.server.duplicate',
      title: t('capabilities.mcp.detail.duplicate'),
      onSelect: onDuplicate,
    },
    ...(installLink
      ? [{
          id: 'copyInstallLink',
          testID: 'mcp.server.copyInstallLink',
          title: t('capabilities.mcp.detail.copyInstallLink'),
          onSelect: async () => {
            const copied = await writeClipboard(installLink);
            publishPresentationNotice({
              key: INSTALL_LINK_NOTICE_KEY,
              severity: copied ? 'info' : 'error',
              message: copied
                ? t('items.copiedToClipboard', { label: t('capabilities.mcp.detail.installLinkLabel') })
                : t('items.failedToCopyToClipboard'),
            });
          },
        }]
      : []),
  ], [installLink, onDuplicate, writeClipboard]);
  const missingKeys = React.useMemo(
    () => mcpServerMissingKeyNames(server, secretAvailability),
    [secretAvailability, server],
  );
  const name = mcpServerDisplayName(server);
  const list = detail.tools.list;
  const toolCount =
    list?.snapshot?.tools.length ?? server.toolsSnapshot?.tools.length;
  // The registry by its name ("MCP Registry"), never its id; a built-in one is named before the list is read.
  const { sources: registrySources } = useRegistrySources('mcpServer');
  const registrySourceId = server.origin?.kind === 'registry' ? server.origin.provenance.sourceId : null;
  const registryTitle = registrySourceId === null ? null
    : ([...registrySources, ...BUILT_IN_REGISTRY_SOURCES_V1].find((source) => source.id === registrySourceId)?.title ?? registrySourceId);
  const facts = React.useMemo(
    () => ({
      source:
        server.origin?.kind === 'registry'
          ? {
              kind: 'registry' as const,
              label: registryTitle ?? server.origin.provenance.sourceId,
            }
          : server.origin?.kind === 'machine'
            ? {
                kind: 'machine' as const,
                machineName: detail.names.machineName(server.origin.machineId),
              }
            : { kind: 'you' as const },
      extra: [
        server.transport === 'stdio'
          ? t('capabilities.mcp.local')
          : t('capabilities.mcp.remote'),
      ],
      ...(toolCount !== undefined
        ? {
            cost: {
              toolCount,
              ...(list?.tokens != null ? { tokensPerTurn: list.tokens } : {}),
            },
          }
        : {}),
    }),
    [detail.names, list?.tokens, registryTitle, server.origin, server.transport, toolCount],
  );
  const registryId =
    server.origin?.kind === 'registry'
      ? server.origin.provenance.itemId
      : undefined;

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <CapabilityDetailHeader
        testID="mcp.server.editor.header"
        mark={<HappierBrandMark brand={props.brandMark ?? { displayName: name }} pixelSize={28} externallyLabelled />}
        title={name}
        purpose={server.description}
        facts={facts}
        mono={registryId}
        menuItems={menuItems}
      />
      {props.approvalNotice}
      {props.configurationConflict ? (
        <McpServerConflictReview
          conflict={props.configurationConflict}
          draftServer={props.draftServer}
          secrets={props.secrets}
        />
      ) : null}
      <McpServerBanner detail={detail} name={name} toolCount={toolCount} />
      {detail.signIn.view ? (
        <McpSignInSection key={JSON.stringify([props.scope?.serverId, props.scope?.accountId, server.id])} name={name} signIn={{ ...detail.signIn, view: detail.signIn.view }} onUseApiKey={recovery.useApiKey} />
      ) : null}
      <McpServerWhereAndTools detail={detail} />
      <McpServerConfigurationSection
        title={t('capabilities.mcp.detail.configurationTitle')}
        description={t('capabilities.mcp.detail.configurationDescription')}
        draftServer={props.draftServer}
        committedServer={props.configurationBaseServer}
        secrets={props.secrets}
        scope={props.scope}
        mode="edit"
        onCommit={props.onCommitConfiguration}
        saveState={props.configurationSaveState}
        attentionKeys={missingKeys}
        onChangeServer={props.onChangeServer}
      />
      <McpServerMachineDifferences
        server={props.draftServer}
        machineName={detail.names.machineName}
        machines={detail.placeMachines}
        secrets={props.secrets}
        scope={props.scope}
        onChangeServer={props.onChangeServer}
        onCommit={props.onCommitConfiguration}
      />
      <McpServerMachinesAndDetails detail={detail} server={server} />
      {server.origin?.kind === 'registry' ? (
        <McpServerUpdateSection
          testID="mcp.server.update"
          update={detail.update}
          secrets={props.secrets}
          scope={props.scope ?? null}
        />
      ) : null}
      <PageLeaveActions
        testID="mcp.server.leave"
        footnote={t('capabilities.mcp.detail.removeFootnote')}
        actions={[
          {
            testID: 'mcp.server.editor.remove',
            display: 'bordered',
            icon: 'trash',
            label: t('capabilities.mcp.detail.removeServer'),
            onPress: props.onRemove,
          },
        ]}
      />
    </ItemList>
  );
});
