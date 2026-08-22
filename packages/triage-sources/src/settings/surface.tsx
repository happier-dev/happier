/**
 * The one PRs & Issues settings page, and the identity a source supplies to get it.
 *
 * This is the page a person actually uses to put a source into PRs & Issues. It
 * does exactly three things, and deliberately nothing else:
 *
 *  1. it asks THAT source for the accounts and scopes it can reach, through the
 *     source's own `listInstances` Action;
 *  2. it asks the TARGET which of them that source has already configured,
 *     through the public `happier.triage/sources/read-configured-v1` Action;
 *  3. it asks the TARGET to create, update, remove or restore the one the user
 *     chose, through the single public `happier.triage/sources/administer-v1`
 *     Action.
 *
 * It never writes `source-instances`, never sees or renders a credential, never
 * enumerates host accounts, and holds no second record of what is configured.
 * The account a candidate binds arrives inside the draft the source produced
 * from its own purpose-bound Connected Account listing; this page copies that
 * draft through untouched. The caller-scoped read hands back the source's own
 * opaque configuration token as part of the record it stored; nothing here reads
 * or renders it, because a reconfiguration submits the freshly discovered draft
 * rather than replaying what was stored.
 *
 * The one thing it decides on its own is that removal is asked about first. The
 * arm is irreversible from this page's side, so the question goes through the
 * host's own confirmation owner before the Action runs; the page adds no dialog
 * and no confirmed bit of its own.
 *
 * Configuration is reversible, and it survives closing the page. The target's own
 * caller-scoped read is what a row's state comes from, so a source configured in
 * an earlier visit offers Update and Remove, and one removed in an earlier visit
 * offers Restore — which is the only arm that may revive a retired row and does
 * so under that row's exact stable ref. A press made here wins over that read
 * only when the target settled it successfully; a refused press teaches this page
 * nothing.
 *
 * A configured instance a source can no longer see is still listed, with the one
 * control that still works. Dropping it would leave a person with entries that
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
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Item,
  ItemGroup,
  LoadingState,
  Row,
  Screen,
  ScrollArea,
  Stack,
  Text,
  defineUiSurface,
  useExecutePluginAction,
  usePluginHostApi,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  type TriageSourceAdministrationActionInputV1,
} from '@happier-dev/triage-protocol/v1';

import {
  UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
  advanceTriageSourceSettingsRowLifecycle,
  describeTriageSourceConfiguredRead,
  describeTriageSourceFailure,
  describeTriageSourceRemovalConfirmation,
  describeTriageSourceRemovalUnconfirmable,
  projectTriageSourceSettingsRows,
  readTriageSourceConfiguration,
  readTriageSourceConfiguredInstances,
  readTriageSourceDiscovery,
  type TriageSourceSettingsConfigurationV1,
  type TriageSourceSettingsRowControlV1,
  type TriageSourceSettingsRowLifecycleV1,
  type TriageSourceSettingsRowV1,
} from './model.js';

/**
 * Everything one source contributes to its own settings page.
 *
 * These are the only three facts the page cannot derive from a published
 * contract: which plugin is asking, which of that plugin's Actions enumerates
 * what it can reach, and what to call the source in a sentence. Anything else a
 * source wanted to vary here would be a second page, not a parameter.
 */
export type TriageSourceSettingsSurfaceIdentityV1 = Readonly<{
  /** The contributing source plugin's own id, exactly as the host knows it. */
  pluginId: string;
  /** That plugin's local id for its own read-only `listInstances` Action. */
  listInstancesLocalActionId: string;
  /** The source's display name, exactly as its own descriptor spells it. */
  sourceDisplayName: string;
}>;

type ConfigurationOutcomes = Readonly<Record<string, TriageSourceSettingsConfigurationV1>>;
type RowLifecycles = Readonly<Record<string, TriageSourceSettingsRowLifecycleV1>>;

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
  const listInstances = Object.freeze({
    pluginId: identity.pluginId,
    localId: identity.listInstancesLocalActionId,
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

    const [outcomes, setOutcomes] = React.useState<ConfigurationOutcomes>({});
    const [learned, setLearned] = React.useState<RowLifecycles>({});
    const [submitting, setSubmitting] = React.useState<string | null>(null);

    const runDiscovery = discovery.execute;
    const runConfiguredRead = configuredRead.execute;
    const read = React.useCallback(() => {
      // Both reads run once on mount and again only on an explicit press. A
      // settings page that polled would spend the account's provider rate budget
      // for a reader who already has their answer.
      //
      // They are independent on purpose: what this source can reach and what it has
      // already configured are different questions with different failure modes, and
      // a page that waited for both would hide the answer it did get.
      void runDiscovery({ v: 1 });
      void runConfiguredRead({ v: 1 });
    }, [runConfiguredRead, runDiscovery]);

    React.useEffect(() => {
      read();
    }, [read]);

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
    ) => {
      setSubmitting(key);
      const settled = await administerExecute(input);
      setSubmitting(null);
      const outcome = readTriageSourceConfiguration(settled);
      setOutcomes((previous) => ({ ...previous, [key]: outcome }));
      setLearned((previous) => {
        const current = previous[key] ?? UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1;
        const next = advanceTriageSourceSettingsRowLifecycle(current, outcome);
        // A refused, raced, unreadable or unknown arm teaches nothing, and recording
        // it here would shadow what the target's own read says about this row.
        return next === current ? previous : { ...previous, [key]: next };
      });
    }, [administerExecute]);

    /**
     * Remove, asked first.
     *
     * Removal is the one arm this page cannot undo: the target retires the row,
     * and only an explicit Restore — offered only while this source can still
     * discover that scope — brings it back. So the question is put through the
     * host's own confirmation owner before the arm runs, exactly as
     * `core/SURFACE.md` requires of source Settings. There is no caller-supplied
     * confirmed bit and no page-local dialog: a second confirmation lifecycle
     * for one concept is what the host owner exists to prevent.
     *
     * Three answers, three different things. Approved runs the arm. Declined
     * runs nothing and teaches this page nothing, because the row did not
     * change. A rejection is neither: the host advertises no confirmation, the
     * mount retired, or the question was withdrawn — none of which is a decline
     * the user made, so nothing is removed and the row says so rather than
     * leaving a pressed button with no visible effect.
     */
    const requestRemoval = React.useCallback(async (
      row: TriageSourceSettingsRowV1,
      sourceInstanceId: string,
    ) => {
      const question = describeTriageSourceRemovalConfirmation(
        { rowTitle: row.title, sourceDisplayName },
        text,
      );
      let approved: boolean;
      try {
        approved = await hostApi.confirm(question.message, { title: question.title });
      } catch {
        setOutcomes((previous) => ({
          ...previous,
          [row.key]: describeTriageSourceRemovalUnconfirmable(text),
        }));
        return;
      }
      if (!approved) return;
      await submit(row.key, { v: 1, kind: 'remove', sourceInstanceId });
    }, [hostApi, submit, text]);

    const runControl = React.useCallback((
      row: TriageSourceSettingsRowV1,
      control: TriageSourceSettingsRowControlV1['id'],
    ) => {
      // Remove names one exact row and nothing else, so it is the one arm that
      // works for a configured instance this source can no longer discover.
      if (control === 'remove') {
        if (row.sourceInstanceId === null) return;
        void requestRemoval(row, row.sourceInstanceId);
        return;
      }
      // Every other arm submits a freshly discovered draft, and all but `create`
      // also name the exact row the target minted. A control is not offered without
      // what it needs; this is the guard for the impossible press, not the policy.
      if (row.draft === null) return;
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
    }, [requestRemoval, submit]);

    const state = readTriageSourceDiscovery(discovery.execution);
    const configured = readTriageSourceConfiguredInstances(configuredRead.execution);
    const configuredNotice = describeTriageSourceConfiguredRead(configured, sourceDisplayName);
    const rows = projectTriageSourceSettingsRows({
      discovery: state,
      configured,
      outcomes,
      learned,
      sourceDisplayName,
    });

    return (
      <Screen safeArea>
        <ScrollArea>
          <Stack gap="large">
            <Stack gap="small">
              <Heading level={2} value={`${sourceDisplayName} in PRs & Issues`} />
              <Text
                tone="secondary"
                value={`Choose which ${sourceDisplayName} accounts and scopes appear in PRs & Issues. Accounts come from Connected Accounts; nothing here sees a token.`}
              />
            </Stack>

            {state.kind === 'loading' ? (
              <LoadingState
                title={`Reading ${sourceDisplayName} accounts`}
                description="Asking this machine's authorized connection what it can reach."
              />
            ) : null}

            {state.kind === 'outcomeUnknown' ? (
              <ErrorState
                title="This read did not finish"
                description="It may still be running. Refresh to ask again."
                action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
              />
            ) : null}

            {state.kind === 'unreadable' ? (
              <ErrorState
                title="This version cannot read the response"
                description={`The ${sourceDisplayName} source returned a result outside the published contract.`}
                action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
              />
            ) : null}

            {state.kind === 'unreachable' ? (
              <ErrorState
                title={`${sourceDisplayName} could not be read`}
                description={state.failure === null
                  ? state.message ?? 'No machine answered this read.'
                  : describeTriageSourceFailure(state.failure, text)}
                action={<Button title="Try again" variant="secondary" onPress={refresh} />}
              />
            ) : null}

            {configuredNotice === null ? null : (
              <Banner
                tone={configuredNotice.tone}
                title={configuredNotice.title}
                description={configuredNotice.description}
              />
            )}

            <Stack gap="medium">
              {state.kind === 'listed' && !state.complete ? (
                <Banner
                  tone="warning"
                  title="This list may be incomplete"
                  description={state.listingFailure === null
                    ? 'Some accounts or scopes could not be enumerated, so one you expect may be missing.'
                    : describeTriageSourceFailure(state.listingFailure, text)}
                />
              ) : null}

              {/*
                The rows are not conditioned on the discovery arm. A configured
                instance the target named is a live product fact even when this
                source cannot enumerate anything right now, and a page that hid it
                behind a discovery error would leave the user unable to remove it.
              */}
              {rows.length === 0 ? (
                state.kind === 'listed' ? (
                  <EmptyState
                    title={`No ${sourceDisplayName} scopes to add`}
                    description={`Connect a ${sourceDisplayName} account in Connected Accounts, then refresh.`}
                    action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
                  />
                ) : null
              ) : (
                <ItemGroup accessibilityLabel={`${sourceDisplayName} scopes`}>
                  {rows.map((row) => {
                    const busy = submitting === row.key;
                    return (
                      <Item
                        key={row.key}
                        title={row.title}
                        {...(row.status === null ? {} : { subtitle: row.status })}
                        {...(row.locator === null ? {} : { detail: row.locator })}
                        tone={row.tone}
                        accessory={(
                          <Row gap="small">
                            {row.keyFollowsProviderName ? (
                              <Badge tone="warning" value="Follows the provider name" />
                            ) : null}
                            {row.controls.map((control) => (
                              <Button
                                key={control.id}
                                title={control.label}
                                variant={control.variant}
                                busy={busy}
                                disabled={submitting !== null}
                                accessibilityLabel={control.accessibilityLabel}
                                onPress={() => {
                                  runControl(row, control.id);
                                }}
                              />
                            ))}
                          </Row>
                        )}
                      />
                    );
                  })}
                </ItemGroup>
              )}

              {state.kind !== 'listed' || state.failures.length === 0 ? null : (
                <Stack gap="small">
                  <Heading level={3} value="Accounts that could not be read" />
                  <ItemGroup accessibilityLabel="Accounts that could not be read">
                    {state.failures.map((entry) => (
                      <Item
                        key={entry.key}
                        title={entry.localInstanceKey ?? entry.accountId}
                        subtitle={describeTriageSourceFailure(entry.failure, text)}
                        tone="danger"
                      />
                    ))}
                  </ItemGroup>
                </Stack>
              )}

              {state.kind === 'listed' ? (
                <Row gap="small">
                  <Button title="Refresh" variant="secondary" onPress={refresh} />
                </Row>
              ) : null}
            </Stack>
          </Stack>
        </ScrollArea>
      </Screen>
    );
  }

  return defineUiSurface(TriageSourceSettingsSurface);
}
