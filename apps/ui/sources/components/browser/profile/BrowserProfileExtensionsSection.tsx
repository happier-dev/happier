import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';


import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { readWebStoreExtensionId, useBrowserExtensionsInventory, type InstalledBrowserExtensionEntryRow } from '@/components/store/catalog/storeBrowserExtensions';
import { RowMark } from '@/components/store/inventory/ManagedInventoryDirectory';
import { submitBrowserExtensionMutation } from '@/components/store/submitBrowserExtensionMutation';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';


type MutationActionId =
  | 'browser.extensions.enable'
  | 'browser.extensions.disable'
  | 'browser.extensions.remove';

/**
 * One persistent browser profile's Extensions: what is installed with on/off and Remove, the Store opened for this
 * profile, and an install from a pasted Chrome Web Store link. Every control runs the same `browser.extensions.*`
 * Action an agent runs; the browser owner decides permission review and restart, and this section only asks.
 */
export function BrowserProfileExtensionsSection(
  props: Readonly<{
    scope: ServerAccountScope | null;
    serverId?: string;
    machineId: string;
    profileId: string;
    testID: string;
  }>,
): React.ReactElement {
  const { machineId, profileId, testID } = props;
  const machineIds = React.useMemo(() => [machineId], [machineId]);
  const inventory = useBrowserExtensionsInventory({
    scope: props.scope,
    machineIds,
    profileId,
    presented: true,
  });
  const { execution, refresh } = inventory;
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const router = useRouter();
  // The section's own flow (review, restart, the Action) ends when the section unmounts, not when the
  // execution owner replays its lifetime effect on a re-render.
  const flow = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    flow.current = new AbortController();
    return () => flow.current?.abort();
  }, []);

  const run = React.useCallback(
    async (
      key: string,
      actionId: MutationActionId | 'browser.extensions.install',
      input: Readonly<Record<string, unknown>>,
    ) => {
      setPendingId(key);
      try {
        const result = await submitBrowserExtensionMutation({
          actionId,
          input: { machineId, profileId, ...input },
          machineId,
          execute: execution.execute,
          signal: flow.current?.signal ?? AbortSignal.abort(),
          confirmText:
            actionId === 'browser.extensions.install'
              ? t('capabilities.store.add')
              : t('common.continue'),
        });
        if (result.ok) refresh();
        else if ('code' in result && result.code) {
          const fallback = t('capabilities.store.browserExtensionProfile.failed');
          Modal.alert(
            t('common.error'),
            resolveActionExecutionFailureMessage({ ...result, errorCode: result.code }, fallback) ?? fallback,
          );
        }
      } finally {
        setPendingId(null);
      }
    },
    [execution.execute, machineId, profileId, refresh],
  );

  const setEnabled = React.useCallback(
    (extensionId: string, enabled: boolean) => {
      fireAndForget(
        run(
          extensionId,
          enabled ? 'browser.extensions.enable' : 'browser.extensions.disable',
          { extensionId },
        ),
        { tag: 'BrowserProfileExtensionsSection.toggle' },
      );
    },
    [run],
  );

  const remove = React.useCallback(
    (extensionId: string, name: string) => {
      fireAndForget(
        (async () => {
          if (
            !(await Modal.confirm(
              t('capabilities.store.browserExtensionProfile.removeTitle'),
              t('capabilities.store.browserExtensionProfile.removeBody', { name }),
              { confirmText: t('common.remove'), destructive: true },
            ))
          )
            return;
          // This one confirmation states the restart, so the browser owner doesn't ask again.
          await run(extensionId, 'browser.extensions.remove', { extensionId, restartConfirmed: true });
        })(),
        { tag: 'BrowserProfileExtensionsSection.remove' },
      );
    },
    [run],
  );

  const addFromLink = React.useCallback(() => {
    fireAndForget(
      (async () => {
        const text = await Modal.prompt(
          t('capabilities.store.browserExtensionProfile.linkTitle'),
          t('capabilities.store.browserExtensionProfile.linkBody'),
          { confirmText: t('capabilities.store.add') },
        );
        if (text === null) return;
        const extensionId = readWebStoreExtensionId(text);
        if (!extensionId) {
          Modal.alert(
            t('capabilities.store.browserExtensionProfile.linkTitle'),
            t('capabilities.store.browserExtensionProfile.linkInvalid'),
          );
          return;
        }
        await run(extensionId, 'browser.extensions.install', {
          source: { kind: 'webStore', extensionId },
        });
      })(),
      { tag: 'BrowserProfileExtensionsSection.addFromLink' },
    );
  }, [run]);

  const browse = React.useCallback(() => {
    const href = buildPluginsHomeRoute('app', {
      view: 'kind',
      kind: 'browserExtension',
      browserProfile: profileId,
      ...(props.serverId
        ? { machine: { serverId: props.serverId, machineId } }
        : {}),
    });
    const result = runGuardedNavigation(() => router.push(href as never));
    if (result !== true)
      fireAndForget(result, { tag: 'BrowserProfileExtensionsSection.browse' });
  }, [machineId, profileId, props.serverId, router]);

  const coverage = inventory.coverage;
  const failure =
    typeof coverage === 'object' && 'unavailable' in coverage
      ? coverage.unavailable[0]
      : undefined;
  const temporary =
    failure?.reason.kind === 'browser' &&
    failure.reason.value.code === 'persistent_profile_required';
  // A named profile that does not exist yet has no extensions; installing the first one creates it.
  const notCreated =
    failure?.reason.kind === 'browser' &&
    failure.reason.value.code === 'profile_not_found';
  const usable = !failure || notCreated;

  return (
    <>
    {/* A person's own install, toggle or remove can wait on its approval; say so and open it. */}
    {execution.approval.approvalPending ? (
      <ActionApprovalPendingNotice
        message={t('approvals.waitingForYou')}
        summary={execution.approval.approvalSummary}
        onOpenApproval={execution.approval.openApproval}
      />
    ) : null}
    <ItemGroup
      testID={testID}
      title={t('capabilities.store.browserExtensionProfile.title')}
      description={t('capabilities.store.browserExtensionProfile.description')}
      action={
        usable ? (
          <SectionActionButton
            testID={`${testID}.browse`}
            title={t('capabilities.store.browserExtensionProfile.browse')}
            destination
            onPress={browse}
          />
        ) : undefined
      }
    >
      {coverage === 'loading' && inventory.rows.length === 0 ? (
        <SkeletonRows rows={2} testID={`${testID}.loading`} />
      ) : null}
      {failure && !notCreated ? (
        // The one shared inline notice (OWNER-UI-1115B A2): a temporary profile says why it has none;
        // a failed read says so with Retry inline.
        <SurfaceStateCard
          testID={`${testID}.unavailable`}
          size="line"
          kind={temporary ? 'unavailable' : 'error'}
          title={
            temporary
              ? t('capabilities.store.browserExtensionProfile.temporary')
              : t('capabilities.store.browserExtensionProfile.unavailable')
          }
          {...(temporary ? {} : {
            accessibilitySemantics: 'alert' as const,
            action: { label: t('capabilities.store.retry'), onPress: refresh, testID: `${testID}.retry` },
          })}
        />
      ) : null}
      {usable && coverage !== 'loading' && inventory.rows.length === 0 ? (
        <Item
          testID={`${testID}.empty`}
          title={t('capabilities.store.browserExtensionProfile.empty')}
          mode="info"
          showChevron={false}
        />
      ) : null}
      {inventory.rows.map((row) => row.subject !== 'extension' ? null : (
        <ExtensionRow
          key={row.key}
          row={row}
          scope={props.scope}
          testID={`${testID}.row.${row.native.extension.id}`}
          pending={pendingId === row.native.extension.id}
          onEnabledChange={setEnabled}
          onRemove={remove}
        />
      ))}
      {usable && coverage !== 'loading' ? (
        <ItemAddRow
          testID={`${testID}.addLink`}
          title={t('capabilities.store.browserExtensionProfile.addLink')}
          disabled={pendingId !== null}
          onPress={addFromLink}
        />
      ) : null}
    </ItemGroup>
    </>
  );
}

const ExtensionRow = React.memo(function ExtensionRow(
  props: Readonly<{
    row: InstalledBrowserExtensionEntryRow;
    scope: ServerAccountScope | null;
    testID: string;
    pending: boolean;
    onEnabledChange: (extensionId: string, enabled: boolean) => void;
    onRemove: (extensionId: string, name: string) => void;
  }>,
) {
  const { extension, restartRequired } = props.row.native;
  const { onEnabledChange, onRemove } = props;
  const actions = React.useMemo(
    (): ItemAction[] => [
      {
        id: 'remove',
        title: t('common.remove'),
        icon: 'trash',
        destructive: true,
        disabled: props.pending,
        onPress: () => onRemove(extension.id, extension.name),
      },
    ],
    [extension.id, extension.name, onRemove, props.pending],
  );
  const description = restartRequired
    ? `${extension.version}  ·  ${t('capabilities.store.browserExtensionProfile.restartPending')}`
    : extension.version;
  return (
    <CapabilityRow
      testID={props.testID}
      title={extension.name}
      description={description}
      mark={
        <RowMark
          row={props.row}
          title={extension.name}
          input={{ scope: props.scope, machine: null, projectKey: null }}
        />
      }
      divider={false}
      action={
        <View style={styles.controls}>
          <ItemRowActions
            title={extension.name}
            actions={actions}
            overflowOnly
            overflowTriggerTestID={`${props.testID}.more`}
          />
          <Switch
            testID={`${props.testID}.enabled`}
            value={extension.enabled}
            disabled={props.pending}
            accessibilityLabel={extension.name}
            onValueChange={(next) => onEnabledChange(extension.id, next)}
          />
        </View>
      }
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
