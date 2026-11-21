import * as React from 'react';

import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  normalizeActionsSettingsV1,
  type ActionApprovalScopeV1,
} from '@happier-dev/protocol/actions/actionSettings';
import { isSessionApprovalConsentEligibleV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentPolicyV1';
import type { SessionApprovalConsentModeChangeV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import { useEnvironmentName } from '@/components/projects/deployments/useEnvironmentName';
import {
  ActionScopedApprovalRow,
  type ActionScopedApprovalMode,
} from '@/components/settings/actions/ActionScopedApprovalRow';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
  ACTION_SETTINGS_PROJECTION_SECTIONS,
  buildActionSettingsContributedActions,
  buildActionSettingsEntries,
  type ActionSettingsContributedAction,
} from '@/components/settings/actions/buildActionSettingsEntries';
import { useActionSettingsAvailability } from '@/components/settings/actions/useActionSettingsAvailability';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
  useSessionApprovalConsents,
  type SessionApprovalConsentsState,
} from '@/hooks/approvals/useSessionApprovalConsents';
import {
  useServerScopedMachineLabel,
  useSetting,
} from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

/** Session overrides are offered for agents, like the Account's per-Machine preferences. */
const AUDIENCE = 'agent' as const;
const NO_ITEMS: readonly never[] = Object.freeze([]);

type SetRow = (
  change: SessionApprovalConsentModeChangeV1,
) => Promise<Readonly<{ ok: boolean }>>;
type RowTarget = Readonly<{ actionId: string; scope?: ActionApprovalScopeV1 }>;

function rowKey(row: RowTarget): string {
  return JSON.stringify([
    row.actionId,
    row.scope?.kind ?? null,
    row.scope?.kind === 'machine'
      ? row.scope.machineId
      : row.scope?.kind === 'environment'
        ? row.scope.environmentId
        : null,
  ]);
}

/** The Session Machine's contributed Actions, read from the same daemon projection Settings › Actions reads. */
export type SessionAllowedActionsCatalog = Readonly<{
  actions: readonly ActionSettingsContributedAction[];
  pluginTitles: ReadonlyMap<string, string>;
}>;

/**
 * The Action's title as the Account's Action catalog names it. A contributed Action whose plugin is not
 * loaded here reads as an Action from its plugin, never as its id.
 */
export function sessionConsentActionTitle(actionId: string, catalog: SessionAllowedActionsCatalog | null): string {
  const builtIn = ActionIdSchema.safeParse(actionId);
  if (builtIn.success) return getActionSpec(builtIn.data).title;
  const contributed = parseQualifiedPluginActionId(actionId);
  const declared = contributed ? catalog?.actions.find((action) =>
    action.pluginId === contributed.pluginId && action.localId === contributed.localId) : undefined;
  if (declared) return declared.title;
  const plugin = contributed ? catalog?.pluginTitles.get(contributed.pluginId) : undefined;
  return plugin ? t('sessionRemotePermissionGrants.consent.actionFromPlugin', { plugin })
    : t('sessionRemotePermissionGrants.consent.pluginAction');
}

/**
 * Session › Allowed › Actions: the Session's own "allow for this Session" rows. The record is read
 * through its key-scoped owner; each change is one row write through the policy Action, saved
 * without a second confirmation (the change is the approval).
 */
export const SessionAllowedActionsSection = React.memo(
  function SessionAllowedActionsSection(
    props: Readonly<{
      address: SessionAddress;
      /** The Session's Machine, whose contributed Actions the rows and "Add an Action" name. */
      machineId: string | null;
    }>,
  ) {
    const { state, setRow, ready } = useSessionApprovalConsents(props.address);
    // The Machine's projection is read only while a plugin row is listed or the add menu is open.
    const [addDemand, setAddDemand] = React.useState(false);
    const pluginRow = state.status === 'ready'
      && state.rows.some((row) => parseQualifiedPluginActionId(row.actionId) !== null);
    const projection = useDaemonMergedProjectionInputs({
      machineId: props.machineId,
      serverId: props.address.serverId,
      enabled: props.machineId !== null && (pluginRow || addDemand),
      sections: ACTION_SETTINGS_PROJECTION_SECTIONS,
    });
    const byId = projection.inputs?.pluginProjectionById;
    const catalog = React.useMemo((): SessionAllowedActionsCatalog | null => byId ? {
      actions: buildActionSettingsContributedActions(byId).filter((action) => !action.resource),
      pluginTitles: new Map(Object.values(byId).map((plugin) => [plugin.pluginId, plugin.title] as const)),
    } : null, [byId]);
    return (
      <SessionAllowedActionsGroup
        serverId={props.address.serverId}
        state={state}
        setRow={setRow}
        ready={ready}
        catalog={catalog}
        onCatalogDemand={setAddDemand}
      />
    );
  },
);

export function SessionAllowedActionsGroup(
  props: Readonly<{
    serverId: string;
    state: SessionApprovalConsentsState;
    setRow: SetRow;
    ready: boolean;
    catalog: SessionAllowedActionsCatalog | null;
    /** The add menu opened or closed: the contributed catalog is read while it is open. */
    onCatalogDemand?: (open: boolean) => void;
  }>,
) {
  const { state, setRow, catalog, onCatalogDemand } = props;
  // Rows touched in this visit stay listed (at Default after a removal), as on the Settings Machine rows.
  const [kept, setKept] = React.useState<readonly RowTarget[]>(NO_ITEMS);
  const [pending, setPending] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [addOpen, setAddOpenState] = React.useState(false);
  const setAddOpen = React.useCallback((open: boolean) => {
    setAddOpenState(open);
    onCatalogDemand?.(open);
  }, [onCatalogDemand]);
  const stored = state.status === 'ready' ? state.rows : NO_ITEMS;
  const rows = React.useMemo(() => {
    const byKey = new Map<
      string,
      Readonly<{ target: RowTarget; mode: ActionScopedApprovalMode }>
    >();
    for (const row of stored) {
      if (row.audience === AUDIENCE)
        byKey.set(rowKey(row), { target: row, mode: row.mode });
    }
    for (const target of kept) {
      if (!byKey.has(rowKey(target)))
        byKey.set(rowKey(target), { target, mode: 'default' });
    }
    return [...byKey.entries()]
      .map(([key, row]) => ({
        key,
        ...row,
        title: sessionConsentActionTitle(row.target.actionId, catalog),
      }))
      .sort(
        (left, right) =>
          left.title.localeCompare(right.title) ||
          left.key.localeCompare(right.key),
      );
  }, [catalog, kept, stored]);

  const change = React.useCallback(
    (target: RowTarget, mode: ActionScopedApprovalMode) => {
      const key = rowKey(target);
      setKept((current) =>
        current.some((row) => rowKey(row) === key)
          ? current
          : [...current, target],
      );
      setPending(key);
      setFailed(false);
      void setRow({
        actionId: target.actionId,
        audience: AUDIENCE,
        ...(target.scope ? { scope: target.scope } : {}),
        mode,
      })
        .then(
          (result) => {
            if (!result.ok) setFailed(true);
          },
          () => setFailed(true),
        )
        .finally(() => setPending(null));
    },
    [setRow],
  );
  const add = React.useCallback(
    (actionId: string) => {
      setAddOpen(false);
      // A new row starts as Allowed: adding an Action here is the person's own choice to allow it.
      change({ actionId }, 'allowed');
    },
    [change, setAddOpen],
  );

  const disabled = !props.ready || state.status !== 'ready';
  const listed = React.useMemo(
    () =>
      new Set(
        rows
          .filter((row) => !row.target.scope)
          .map((row) => row.target.actionId),
      ),
    [rows],
  );
  return (
    <ItemGroup
      title={t('sessionRemotePermissionGrants.consent.actionsTitle')}
      description={t(
        'sessionRemotePermissionGrants.consent.actionsDescription',
      )}
      action={
        <SessionAllowedAddAction
          open={addOpen}
          onOpenChange={setAddOpen}
          listed={listed}
          contributed={catalog?.actions ?? NO_ITEMS}
          disabled={disabled}
          onSelect={add}
        />
      }
    >
      {failed ? (
        <SurfaceFreshnessLine
          testID="session-allowed-actions-save-failed"
          tone="warning"
          reason={t('sessionRemotePermissionGrants.consent.saveFailed')}
        />
      ) : null}
      {state.status === 'loading' ? (
        <SurfaceStateCard
          testID="session-allowed-actions-loading"
          size="line"
          kind="loading"
          title={t('sessionRemotePermissionGrants.consent.loadingTitle')}
          accessibilitySemantics="status"
        />
      ) : state.status === 'unavailable' ? (
        <SurfaceStateCard
          testID="session-allowed-actions-unavailable"
          size="line"
          kind="unavailable"
          title={t('sessionRemotePermissionGrants.consent.unavailableTitle')}
          reason={t('sessionRemotePermissionGrants.consent.unavailableReason')}
          accessibilitySemantics="alert"
        />
      ) : rows.length === 0 ? (
        <SurfaceStateCard
          testID="session-allowed-actions-empty"
          size="line"
          kind="empty"
          title={t('sessionRemotePermissionGrants.consent.emptyTitle')}
          reason={t('sessionRemotePermissionGrants.consent.emptyReason')}
          accessibilitySemantics="status"
        />
      ) : (
        rows.map((row) => (
          <SessionAllowedActionRow
            key={row.key}
            rowKey={row.key}
            serverId={props.serverId}
            title={row.title}
            target={row.target}
            mode={row.mode}
            disabled={disabled || pending === row.key}
            onChange={change}
          />
        ))
      )}
    </ItemGroup>
  );
}

/** One override: its Action, where it applies, and Default | Ask first | Allowed (Default removes it). */
const SessionAllowedActionRow = React.memo(function SessionAllowedActionRow(
  props: Readonly<{
    rowKey: string;
    serverId: string;
    title: string;
    target: RowTarget;
    mode: ActionScopedApprovalMode;
    disabled: boolean;
    onChange: (target: RowTarget, mode: ActionScopedApprovalMode) => void;
    showDivider?: boolean;
  }>,
) {
  const where = useSessionConsentScopeLabel(props.serverId, props.target.scope);
  const { onChange, target } = props;
  return (
    <ActionScopedApprovalRow
      testIDPrefix={`session-allowed-action:${props.rowKey}`}
      title={props.title}
      subtitle={where}
      value={props.mode}
      disabled={props.disabled}
      onChange={(mode) => onChange(target, mode)}
      showDivider={props.showDivider}
    />
  );
});

/** The name the person knows for a row's Machine or Environment (its id while the name is unknown). */
export function useSessionConsentScopeName(serverId: string | null, scope: ActionApprovalScopeV1 | null | undefined): string | null {
    const machineLabel = useServerScopedMachineLabel(serverId, scope?.kind === 'machine' ? scope.machineId : null);
    const environment = useEnvironmentName(serverId, scope?.kind === 'environment' ? scope.environmentId : null);
    if (!scope) return null;
    return scope.kind === 'machine' ? machineLabel ?? scope.machineId : environment.name ?? scope.environmentId;
}

/** "Anywhere", or "On {Machine}" / "On {Environment}". */
function useSessionConsentScopeLabel(serverId: string | null, scope: ActionApprovalScopeV1 | null | undefined): string {
    const name = useSessionConsentScopeName(serverId, scope);
    return name === null ? t('sessionRemotePermissionGrants.consent.anywhere')
        : t('sessionRemotePermissionGrants.consent.onTarget', { target: name });
}

/** "Add an Action": the Account's own Action catalog, built only while the menu is open. */
function SessionAllowedAddAction(
  props: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    listed: ReadonlySet<string>;
    /** The Session Machine's contributed Actions, offered alongside the host catalog as Settings › Actions does. */
    contributed: readonly ActionSettingsContributedAction[];
    disabled: boolean;
    onSelect: (actionId: string) => void;
  }>,
) {
  const raw = useSetting('actionsSettingsV1');
  const availability = useActionSettingsAvailability();
  const { open, listed, contributed } = props;
  const items = React.useMemo(() => {
    if (!open) return NO_ITEMS;
    return buildActionSettingsEntries({
      query: '',
      settings: normalizeActionsSettingsV1(raw),
      availability,
      contributedActions: contributed,
      translate: t,
    })
      .filter(
        (entry) =>
          !listed.has(entry.actionId) &&
          entry.targets.some((target) => target.id === AUDIENCE) &&
          isSessionApprovalConsentEligibleV1(entry.actionId),
      )
      .map((entry) => ({
        id: entry.actionId,
        title: entry.title,
        testID: `session-allowed-actions:add:${entry.actionId}`,
      }));
  }, [availability, contributed, listed, open, raw]);
  return (
    <DropdownMenu
      testID="session-allowed-actions:add"
      open={open}
      onOpenChange={props.onOpenChange}
      items={items}
      onSelect={props.onSelect}
      search
      emptyLabel={t('sessionRemotePermissionGrants.consent.noActionsToAdd')}
      matchTriggerWidth={false}
      popoverAccessibilityLabel={t(
        'sessionRemotePermissionGrants.consent.addAction',
      )}
      trigger={({ toggle }) => (
        <SectionActionButton
          testID="session-allowed-actions:add:trigger"
          title={t('sessionRemotePermissionGrants.consent.addAction')}
          icon="plus"
          expanded={open}
          disabled={props.disabled}
          onPress={toggle}
        />
      )}
    />
  );
}
