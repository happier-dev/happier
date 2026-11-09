/**
 * The one PRs & Issues settings page, and the identity a source supplies to get it.
 *
 * This is the page a person actually uses to put a source into PRs & Issues. It
 * does exactly three things, and deliberately nothing else:
 *
 *  1. it asks THAT source for the accounts and scopes it can reach, through the
 *     source's own `listInstances` Action, and selectable units through its
 *     optional `listScopeUnits` Action;
 *  2. it asks the TARGET which of them that source has already configured,
 *     through the public `happier.triage/sources/read-configured-v1` Action;
 *  3. it asks the TARGET to create, update, remove or restore the one the user
 *     chose, through the single public `happier.triage/sources/administer-v1`
 *     Action.
 *
 * It never writes `source-instances`, never sees or renders a credential, never
 * enumerates host accounts, and holds no second record of what is configured.
 * The account a candidate binds arrives inside the draft the source produced
 * from its own purpose-bound Connected Account listing. The caller-scoped read
 * hands back the source's own opaque configuration token as part of the stored
 * record. The source editor receives that configuration with the current
 * discovered binding and locator, or the exact retained fields when the source
 * declares its instance-key stability; only the source's codec interprets its bytes.
 *
 * The administration Action's shared approval policy owns every lifecycle
 * change, including Remove. This page adds no question or consent bit of its
 * own, so an explicit Allowed preference is honored here too.
 *
 * Configuration is reversible, and it survives closing the page. The target's own
 * caller-scoped read is what a row's state comes from, so a source configured in
 * an earlier visit offers Update and Remove, and one removed in an earlier visit
 * offers Restore — which is the only arm that may revive a retired row and does
 * so under that row's exact stable ref. A press made here wins over that read
 * only when the target settled it successfully; a refused press teaches this page
 * nothing.
 *
 * A configured instance a source can no longer see is still listed and removable.
 * Sources that qualify a retained draft also keep configuration editing available.
 * Dropping it would leave a person with entries that
 * never arrive and no way to remove the source producing them.
 *
 * Every state it can be in is a distinct sentence. A listing that could not be
 * completed still renders its rows and says so; an exact account that failed is
 * named beside the accounts that worked; an outcome nobody knows is never
 * offered as a retry. A page that renders any of those as "nothing here" would
 * tell the user their account is gone.
 *
 * ## Why this page lives here and not in each source
 *
 * Every source's page reads the same three published contracts and reaches the
 * same conclusions from the same bytes. The only source-specific facts on it are
 * the three in `TriageSourceSettingsSurfaceIdentityV1`. Written per source it was
 * six byte-identical copies of the model and six copies of this component, of
 * which one carried a test — so a correction applied to five and forgotten in one
 * was invisible, and the remount fix above would have been written six times.
 * A source contributes its identity; the page is one.
 */

import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  Badge,
  Banner,
  BrandMark,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Item,
  ItemGroup,
  LoadingState,
  PageHeader,
  Screen,
  ScrollArea,
  defineUiSurface,
  useExecutePluginAction,
  usePluginHostApi,
  usePluginHostReadiness,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  type TriageSourceAdministrationActionInputV1,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

import {
  UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
  advanceTriageSourceSettingsRowLifecycle,
  describeTriageSourceConfiguredRead,
  describeTriageSourceFailure,
  projectTriageSourceSettingsRows,
  readTriageSourceConfiguration,
  readTriageSourceConfiguredInstances,
  readTriageSourceDiscovery,
  type TriageSourceSettingsConfigurationV1,
  type TriageSourceSettingsDiscoveryV1,
  type TriageSourceSettingsRowControlV1,
  type TriageSourceSettingsRowLifecycleV1,
  type TriageSourceSettingsRowV1,
} from './model.js';
import { TriageSourceScopeSelectionEditor } from './scopeSelectionEditor.js';
import type { TriageSourceSettingsScopeSelectionV1, TriageSourceSettingsDraftFieldsPropsV1 } from './scopeSelection.js';

/**
 * Everything one source contributes to its own settings page.
 *
 * Identity, source-owned login copy and optional draft editing stay with the
 * contribution. Lifecycle, row matching and submission remain shared.
 */
export type TriageSourceSettingsSurfaceIdentityV1 = Readonly<{
  /** The contributing source plugin's own id, exactly as the host knows it. */
  pluginId: string;
  /** The contribution id that identifies this source in configured instances. */
  sourceLocalId: string;
  /** That plugin's local id for its own read-only `listInstances` Action. */
  listInstancesLocalActionId: string;
  /** That plugin's Connected Account service contribution local id. */
  connectedAccountServiceLocalId: string;
  /** The HostAccess purpose consumed by this source's discovery Action. */
  connectedAccountPurpose: string;
  /** The source's display name, exactly as its own descriptor spells it. */
  sourceDisplayName: string;
  /** Source-owned localized presentation of an offered machine-native login. */
  nativeLoginLabel?: Readonly<{ key: string; fallback: string }>;
  /** Repair guidance stays with the source that owns the native login. */
  nativeAuthenticationFailureLabel?: Readonly<{ key: string; fallback: string }>;
  /**
   * Optional source-native editor for facts the opaque draft alone cannot expose.
   * Lifecycle and submission remain here. The editor receives the stored or
   * committed configuration with the discovered or qualified retained draft's other fields.
   */
  DraftEditor?: React.ComponentType<TriageSourceSettingsDraftEditorPropsV1>;
  /** Source-native token translation for the one shared All / Selected editor. */
  scopeSelection?: TriageSourceSettingsScopeSelectionV1;
  /** Source-specific non-selection fields, under the shared Save and Cancel. */
  DraftFields?: React.ComponentType<TriageSourceSettingsDraftFieldsPropsV1>;
  /** Source-owned stability of retained instance keys, enabling edits without fresh discovery. */
  configuredInstanceKeyStability?: TriageSourceInstanceDraftV1['keyStability'];
}>;

export type TriageSourceSettingsDraftEditorPropsV1 = Readonly<{
  draft: TriageSourceInstanceDraftV1;
  busy: boolean;
  onSubmit: (draft: TriageSourceInstanceDraftV1) => Promise<void>;
  onCancel: () => void;
}>;

type ConfigurationOutcomes = Readonly<Record<string, TriageSourceSettingsConfigurationV1>>;
type RowLifecycles = Readonly<Record<string, TriageSourceSettingsRowLifecycleV1>>;
type DraftEdit = Readonly<{
  row: TriageSourceSettingsRowV1;
  control: Exclude<TriageSourceSettingsRowControlV1['id'], 'remove'>;
}>;

function isSettledConfigurationSuccess(outcome: TriageSourceSettingsConfigurationV1): boolean {
  return outcome.kind === 'configured'
    || outcome.kind === 'alreadyConfigured'
    || outcome.kind === 'reconfigured'
    || outcome.kind === 'restored';
}

/**
 * The settings surface entry a source's UI artifact exports.
 *
 * Call it once at module scope: the returned surface closes over a frozen action
 * ref, so the discovery execution the page subscribes to is stable for the life
 * of the mount without a hook to keep it that way.
 */
export function createTriageSourceSettingsSurface(
  identity: TriageSourceSettingsSurfaceIdentityV1,
): RenderSurface {
  const { sourceDisplayName } = identity;
  const scopeSelection = identity.scopeSelection;
  const DraftEditor = scopeSelection === undefined ? identity.DraftEditor
    : (props: TriageSourceSettingsDraftEditorPropsV1) => <TriageSourceScopeSelectionEditor {...props}
      pluginId={identity.pluginId} adapter={scopeSelection} {...(identity.DraftFields === undefined ? {} : { Fields: identity.DraftFields })} />;
  const listInstances = Object.freeze({
    pluginId: identity.pluginId,
    localId: identity.listInstancesLocalActionId,
  });
  const connectedAccountService = Object.freeze({
    pluginId: identity.pluginId,
    localId: identity.connectedAccountServiceLocalId,
  });

  function TriageSourceSettingsSurface(): React.ReactElement {
    // The page's own resolver. A failure sentence is the one piece of copy here
    // that is decided in the model rather than written in this JSX, so it is
    // handed the resolver instead of resolving a key it does not own.
    const text = usePluginTranslation();
    const hostApi = usePluginHostApi();
    const discovery = useExecutePluginAction(listInstances);
    const configuredRead = useExecutePluginAction(TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1);
    const administer = useExecutePluginAction(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1);
    // The source Action owns Account/native placement. Wait for its requester,
    // then let that owner decide whether this discovery needs a Machine.
    const discoveryReadiness = usePluginHostReadiness(false);
    const configuredReadiness = usePluginHostReadiness(false);

    const [outcomes, setOutcomes] = React.useState<ConfigurationOutcomes>({});
    const [learned, setLearned] = React.useState<RowLifecycles>({});
    const [submitting, setSubmitting] = React.useState<string | null>(null);
    const [draftEdit, setDraftEdit] = React.useState<DraftEdit | null>(null);
    const [navigationError, setNavigationError] = React.useState(false);

    const openConnectedAccounts = React.useCallback((accountId?: string) => {
      setNavigationError(false);
      void hostApi.openConnectedAccounts({
        service: connectedAccountService,
        ...(accountId === undefined ? { purpose: {
          consumer: listInstances,
          purpose: identity.connectedAccountPurpose,
        } } : {}),
        ...(accountId === undefined ? {} : { accountId }),
      }).catch(() => {
        setNavigationError(true);
      });
    }, [hostApi]);

    const runDiscovery = discovery.execute;
    const runConfiguredRead = configuredRead.execute;
    const activeDiscovery = React.useRef<Readonly<{
      controller: AbortController;
      invocation: ReturnType<typeof runDiscovery>;
    }> | null>(null);

    const startDiscovery = React.useCallback(() => {
      // `useExecutePluginAction` owns the action's in-flight guard. Keeping the
      // controller until that execution settles means a Refresh cannot start a
      // second request in the small cancellation-to-settlement gap.
      if (activeDiscovery.current !== null) return;
      const controller = new AbortController();
      const invocation = runDiscovery({ v: 1 }, { signal: controller.signal });
      const active = { controller, invocation };
      activeDiscovery.current = active;
      const settled = () => {
        if (activeDiscovery.current === active) activeDiscovery.current = null;
        // The mounted host/action boundary owns the settled execution outcome.
        controller.abort();
      };
      void invocation.then(settled, settled);
    }, [runDiscovery]);

    React.useEffect(() => {
      if (discoveryReadiness.pending || discoveryReadiness.ready === false) return;
      let current = true;
      const acquire = () => { if (current) startDiscovery(); };
      const previous = activeDiscovery.current;
      // A withdrawn execution still owns the action hook's in-flight guard
      // until it settles. Re-acquire afterwards, through the same read lifecycle.
      if (previous) void previous.invocation.then(acquire, acquire);
      else acquire();
      return () => {
        current = false;
        activeDiscovery.current?.controller.abort();
      };
    }, [discoveryReadiness.pending, discoveryReadiness.ready, discoveryReadiness.revision, startDiscovery]);

    // Account configuration waits for its requester, independently of Machine
    // discovery, and re-acquires through that requester's admission signal.
    React.useEffect(() => {
      if (configuredReadiness.pending || configuredReadiness.ready === false) return;
      void runConfiguredRead({ v: 1, source: { pluginId: identity.pluginId, localId: identity.sourceLocalId } });
    }, [configuredReadiness.pending, configuredReadiness.ready, configuredReadiness.revision, identity.pluginId, identity.sourceLocalId, runConfiguredRead]);

    const read = React.useCallback(() => {
      if (!discoveryReadiness.pending && discoveryReadiness.ready !== false) startDiscovery();
      if (!configuredReadiness.pending && configuredReadiness.ready !== false) void runConfiguredRead({
        v: 1, source: { pluginId: identity.pluginId, localId: identity.sourceLocalId },
      });
    }, [configuredReadiness.pending, configuredReadiness.ready, discoveryReadiness.pending, discoveryReadiness.ready, identity.pluginId, identity.sourceLocalId, runConfiguredRead, startDiscovery]);

    const refresh = React.useCallback(() => {
      // Everything this page learned from its own presses is discarded, because the
      // read about to run observes the same rows AFTER those presses committed. It
      // is the newer fact, and keeping a press result beside it is how a row that
      // changed on another device keeps showing this page's stale answer.
      setOutcomes({});
      setLearned({});
      read();
    }, [read]);

    const administerExecute = administer.execute;
    const submit = React.useCallback(async (
      key: string,
      input: TriageSourceAdministrationActionInputV1,
    ): Promise<TriageSourceSettingsConfigurationV1> => {
      setSubmitting(key);
      const settled = await administerExecute(input);
      setSubmitting(null);
      const outcome = readTriageSourceConfiguration(settled);
      setOutcomes((previous) => ({ ...previous, [key]: outcome }));
      setLearned((previous) => {
        const current = previous[key] ?? UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1;
        const next = advanceTriageSourceSettingsRowLifecycle(current, outcome, input);
        // A refused, raced, unreadable or unknown arm teaches nothing, and recording
        // it here would shadow what the target's own read says about this row.
        return next === current ? previous : { ...previous, [key]: next };
      });
      return outcome;
    }, [administerExecute]);

    const submitDraft = React.useCallback(async (
      edit: DraftEdit,
      draft: TriageSourceInstanceDraftV1,
    ): Promise<void> => {
      const { row, control } = edit;
      let input: TriageSourceAdministrationActionInputV1;
      if (control === 'add') {
        input = { v: 1, kind: 'create', draft };
      } else {
        if (row.sourceInstanceId === null) return;
        input = control === 'restore'
          ? { v: 1, kind: 'reactivate', sourceInstanceId: row.sourceInstanceId, draft }
          : { v: 1, kind: 'reconfigure', sourceInstanceId: row.sourceInstanceId, draft };
      }
      const outcome = await submit(row.key, input);
      if (isSettledConfigurationSuccess(outcome)) setDraftEdit(null);
    }, [submit]);

    const runControl = React.useCallback((
      row: TriageSourceSettingsRowV1,
      control: TriageSourceSettingsRowControlV1['id'],
    ) => {
      // Remove names one exact row and nothing else, so it is the one arm that
      // works for a configured instance this source can no longer discover.
      if (control === 'remove') {
        if (row.sourceInstanceId === null) return;
        void submit(row.key, { v: 1, kind: 'remove', sourceInstanceId: row.sourceInstanceId });
        return;
      }
      // Every other arm submits a discovered or source-qualified retained draft, and all but `create`
      // also name the exact row the target minted. A control is not offered without
      // what it needs; this is the guard for the impossible press, not the policy.
      if (row.draft === null) return;
      if (DraftEditor !== undefined) {
        setDraftEdit({ row, control });
        return;
      }
      if (control === 'add') {
        void submit(row.key, { v: 1, kind: 'create', draft: row.draft });
        return;
      }
      if (row.sourceInstanceId === null) return;
      if (control === 'restore') {
        void submit(row.key, {
          v: 1,
          kind: 'reactivate',
          sourceInstanceId: row.sourceInstanceId,
          draft: row.draft,
        });
        return;
      }
      void submit(row.key, {
        v: 1,
        kind: 'reconfigure',
        sourceInstanceId: row.sourceInstanceId,
        draft: row.draft,
      });
    }, [DraftEditor, submit]);

    const discoveredRead = readTriageSourceDiscovery(discovery.execution);
    // A settled host refusal has no discovery request to fail. Present the
    // existing unavailable state without fabricating loading or dispatching a
    // request that the same host has already said it cannot execute.
    const discovered: TriageSourceSettingsDiscoveryV1 = !discoveryReadiness.pending
      && discoveryReadiness.ready === false && discoveredRead.kind === 'loading'
      ? { kind: 'unreachable', failure: null, message: null } : discoveredRead;
    const nativeLoginLabel = identity.nativeLoginLabel === undefined
      ? undefined
      : text(identity.nativeLoginLabel.key, identity.nativeLoginLabel.fallback);
    const nativeAuthenticationFailureLabel = identity.nativeAuthenticationFailureLabel === undefined
      ? undefined
      : text(identity.nativeAuthenticationFailureLabel.key, identity.nativeAuthenticationFailureLabel.fallback);
    const state = discovered.kind !== 'listed' || nativeLoginLabel === undefined
      ? discovered
      : { ...discovered, candidates: discovered.candidates.map((candidate) => (
          'account' in candidate.draft.binding ? candidate : {
            ...candidate, label: nativeLoginLabel, path: candidate.path ?? candidate.label,
          }
        )) };
    const configured = readTriageSourceConfiguredInstances(configuredRead.execution, identity.configuredInstanceKeyStability);
    const configuredNotice = describeTriageSourceConfiguredRead(configured, sourceDisplayName, text);
    const rows = projectTriageSourceSettingsRows({
      discovery: state,
      configured,
      outcomes,
      learned,
      sourceDisplayName,
      text,
    });

    // Each configured-read notice except "not admitted" warns that a row may
    // wrongly offer Add. With no Add on the page it would only repeat a failure
    // the section already states, so one cause is said once.
    const offersAdd = rows.some((row) => row.controls.some((control) => control.id === 'add'));
    const showConfiguredNotice = configuredNotice !== null
      && (configured.kind === 'sourceNotAdmitted' || offersAdd);
    const refreshControl = (
      <Button
        title={text('plugins.triage.sourceSettings.refresh', 'Refresh')}
        variant="plain"
        size="small"
        icon={<Icon name="refresh" size="small" tone="secondary" />}
        disabled={state.kind === 'loading'}
        onPress={refresh}
      />
    );

    return (
      <Screen safeArea>
        <ScrollArea>
          <PageHeader
            title={text('plugins.triage.sourceSettings.heading', '{source} in PRs & Issues', { source: sourceDisplayName })}
            description={text(
              'plugins.triage.sourceSettings.intro',
              'Choose which {source} accounts and scopes appear in PRs & Issues.',
              { source: sourceDisplayName },
            )}
            leading={<BrandMark size="medium" externallyLabelled />}
            actions={(
              <Button
                title={text('plugins.triage.sourceSettings.manageAccounts', 'Manage connected accounts')}
                variant="secondary"
                size="small"
                onPress={() => openConnectedAccounts()}
              />
            )}
          />

          {navigationError ? (
            <Banner
              tone="danger"
              title={text('plugins.triage.sourceSettings.navigationUnavailable', 'Connected Accounts could not be opened.')}
            />
          ) : null}

          {showConfiguredNotice && configuredNotice !== null ? (
            <Banner tone={configuredNotice.tone} title={configuredNotice.title} description={configuredNotice.description} />
          ) : null}

          {state.kind === 'listed' && !state.complete ? (
            <Banner
              tone="warning"
              title={text('plugins.triage.sourceSettings.incomplete.title', 'This list may be incomplete')}
              description={state.listingFailure === null
                ? text('plugins.triage.sourceSettings.incomplete.description', 'Some accounts or scopes could not be enumerated, so one you expect may be missing.')
                : describeTriageSourceFailure(state.listingFailure, text)}
            />
          ) : null}

          {/*
            One section, one sheet. Its state lines sit where the rows would be,
            so the section keeps its place through loading and failure, and the
            rows are not conditioned on the discovery arm: a configured instance
            the target named is a live product fact even when this source cannot
            enumerate anything right now, and hiding it would leave the user
            unable to remove it.
          */}
          <ItemGroup
            title={text('plugins.triage.sourceSettings.section.title', 'Accounts and scopes')}
            description={text('plugins.triage.sourceSettings.section.description', 'Each one you add appears in PRs & Issues.')}
            accessibilityLabel={text('plugins.triage.sourceSettings.scopesLabel', '{source} scopes', { source: sourceDisplayName })}
            action={refreshControl}
          >
            {state.kind === 'loading' && rows.length === 0 ? (
              <LoadingState
                rows={2}
                title={text('plugins.triage.sourceSettings.loading.title', 'Reading {source} accounts', { source: sourceDisplayName })}
              />
            ) : null}

            {state.kind === 'outcomeUnknown' ? (
              <ErrorState
                layout="line"
                title={text('plugins.triage.sourceSettings.outcomeUnknown.title', 'This read did not finish')}
                description={text('plugins.triage.sourceSettings.outcomeUnknown.description', 'It may still be running. Refresh to ask again.')}
              />
            ) : null}

            {state.kind === 'unreadable' ? (
              <ErrorState
                layout="line"
                title={text('plugins.triage.sourceSettings.unreadable.title', 'This version cannot read the response')}
                description={text('plugins.triage.sourceSettings.unreadable.description', 'The {source} source returned a result outside the published contract.', { source: sourceDisplayName })}
              />
            ) : null}

            {state.kind === 'unreachable' ? (
              <ErrorState
                layout="line"
                title={text('plugins.triage.sourceSettings.unreachable.title', '{source} could not be read', { source: sourceDisplayName })}
                description={state.failure === null
                  ? state.message ?? text('plugins.triage.sourceSettings.unreachable.noMachine', 'No machine answered this read.')
                  : describeTriageSourceFailure(state.failure, text)}
                {...(state.failure === null ? {} : { details: state.failure.code })}
                action={<Button title={text('plugins.triage.sourceSettings.tryAgain', 'Try again')} variant="secondary" size="small" onPress={refresh} />}
              />
            ) : null}

            {rows.length === 0 && state.kind === 'listed' ? (
              <EmptyState
                layout="line"
                title={text('plugins.triage.sourceSettings.empty.title', 'No {source} scopes to add', { source: sourceDisplayName })}
                description={text('plugins.triage.sourceSettings.empty.description', 'Connect your {source} account, then refresh.', { source: sourceDisplayName })}
                action={<Button title={text('plugins.triage.sourceSettings.connectAccount', 'Connect account')} variant="primary" size="small" onPress={() => openConnectedAccounts()} />}
              />
            ) : null}

            {rows.map((row) => {
              const busy = submitting === row.key;
              const editing = DraftEditor !== undefined && draftEdit !== null
                && draftEdit.row.key === row.key && draftEdit.row.draft !== null;
              const inline = row.controls.filter((control) => control.id !== 'remove');
              const remove = row.controls.find((control) => control.id === 'remove');
              return (
                <Item
                  key={row.key}
                  title={row.title}
                  {...(row.status === null ? {} : { subtitle: row.status })}
                  {...(row.locator === null ? {} : { detail: row.locator })}
                  tone={row.tone}
                  expanded={editing}
                  expandedContent={editing && DraftEditor !== undefined && draftEdit !== null && draftEdit.row.draft !== null ? (
                    // The row becomes its editor in place: what the user pressed is
                    // what opens, and Cancel folds it back to the same row.
                    <DraftEditor
                      key={JSON.stringify([draftEdit.row.key, draftEdit.row.configuredConfiguration ?? draftEdit.row.draft.configuration])}
                      draft={draftEdit.row.configuredConfiguration === null
                        ? draftEdit.row.draft
                        : { ...draftEdit.row.draft, configuration: draftEdit.row.configuredConfiguration }}
                      busy={submitting === draftEdit.row.key}
                      onSubmit={async (draft) => {
                        await submitDraft(draftEdit, draft);
                      }}
                      onCancel={() => {
                        if (submitting === null) setDraftEdit(null);
                      }}
                    />
                  ) : undefined}
                  accessoryOutsidePressable
                  accessory={editing ? undefined : (
                    <>
                      {row.keyFollowsProviderName ? (
                        <Badge tone="neutral" value={text('plugins.triage.sourceSettings.followsProviderName', 'Follows the provider name')} />
                      ) : null}
                      {inline.map((control) => (
                        <Button
                          key={control.id}
                          title={control.label}
                          variant={control.variant}
                          size="small"
                          busy={busy}
                          disabled={submitting !== null}
                          accessibilityLabel={control.accessibilityLabel}
                          onPress={() => {
                            runControl(row, control.id);
                          }}
                        />
                      ))}
                    </>
                  )}
                  {...(remove === undefined ? {
                    secondaryActions: undefined,
                    onSecondaryAction: undefined,
                  } : {
                    secondaryActions: [{
                      id: 'remove',
                      label: remove.accessibilityLabel,
                      destructive: true,
                      disabled: submitting !== null,
                    }],
                    secondaryActionAccessibilityLabel: text(
                      'plugins.triage.sourceSettings.control.moreActions',
                      'More actions for {title}',
                      { title: row.title },
                    ),
                    onSecondaryAction: () => {
                      runControl(row, 'remove');
                    },
                  })}
                />
              );
            })}
          </ItemGroup>

          {state.kind !== 'listed' || state.failures.length === 0 ? null : (
            <ItemGroup title={text('plugins.triage.sourceSettings.failures.title', 'Accounts that could not be read')}>
              {state.failures.map((entry) => (
                <Item
                  key={entry.key}
                  title={entry.localInstanceKey ?? entry.accountId ?? nativeLoginLabel ?? sourceDisplayName}
                  subtitle={describeTriageSourceFailure(entry.failure, entry.accountId === null && nativeAuthenticationFailureLabel !== undefined
                    ? (key, fallback, values) => key === 'plugins.triage.sourceSettings.failure.authentication'
                      ? nativeAuthenticationFailureLabel
                      : text(key, fallback, values)
                    : text)}
                  tone="danger"
                  accessoryOutsidePressable
                  accessory={entry.failure.class === 'authentication' && entry.accountId !== null
                    ? (
                        <Button
                          title={text('plugins.triage.sourceSettings.reconnectAccount', 'Reconnect')}
                          variant="secondary"
                          size="small"
                          onPress={() => { if (entry.accountId !== null) openConnectedAccounts(entry.accountId); }}
                        />
                      )
                    : undefined}
                />
              ))}
            </ItemGroup>
          )}
        </ScrollArea>
      </Screen>
    );
  }

  return defineUiSurface(TriageSourceSettingsSurface);
}
