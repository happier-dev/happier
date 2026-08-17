/**
 * The GitHub PRs & Issues settings surface artifact entry.
 *
 * This is the page a person actually uses to put GitHub into PRs & Issues. It
 * does exactly two things, and deliberately nothing else:
 *
 *  1. it asks THIS source for the accounts and scopes it can reach, through the
 *     source's own `listInstances` Action;
 *  2. it asks the TARGET to create, update, remove or restore the one the user
 *     chose, through the single public `happier.triage/sources/administer-v1`
 *     Action.
 *
 * It never writes `source-instances`, never sees or renders a credential, never
 * enumerates host accounts, and holds no second record of what is configured.
 * The account a candidate binds arrives inside the draft the source produced
 * from its own purpose-bound Connected Account listing; this page copies that
 * draft through untouched.
 *
 * Configuration is reversible here. A row the target has told this page about
 * offers Update and Remove; a row it removed offers Restore, which is the only
 * arm that may revive a retired row and does so under that row's exact stable
 * ref. A row this page knows nothing about offers only Add and claims nothing
 * about its state — the target publishes no caller-scoped read of the caller's
 * own configured instances, so silence is the one true answer there.
 *
 * Every state it can be in is a distinct sentence. A listing that could not be
 * completed still renders its rows and says so; an exact account that failed is
 * named beside the accounts that worked; an outcome nobody knows is never
 * offered as a retry. A page that renders any of those as "nothing here" would
 * tell the user their account is gone.
 */

import * as React from 'react';
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
} from '@happier-dev/plugin-ui';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  type TriageSourceAdministrationActionInputV1,
} from '@happier-dev/triage-protocol/v1';

import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from '../../triage/contribution.js';

import {
  UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
  advanceTriageSourceSettingsRowLifecycle,
  describeTriageSourceFailure,
  projectTriageSourceSettingsRow,
  readTriageSourceConfiguration,
  readTriageSourceDiscovery,
  type TriageSourceSettingsCandidateV1,
  type TriageSourceSettingsConfigurationV1,
  type TriageSourceSettingsRowControlV1,
  type TriageSourceSettingsRowLifecycleV1,
} from './model.js';

const SOURCE_DISPLAY_NAME = GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName;

type ConfigurationOutcomes = Readonly<Record<string, TriageSourceSettingsConfigurationV1>>;
type RowLifecycles = Readonly<Record<string, TriageSourceSettingsRowLifecycleV1>>;

function GithubTriageSettingsSurface(): React.ReactElement {
  const listInstances = React.useMemo(
    () => ({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }),
    [],
  );
  const discovery = useExecutePluginAction(listInstances);
  const administer = useExecutePluginAction(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1);

  const [outcomes, setOutcomes] = React.useState<ConfigurationOutcomes>({});
  const [lifecycles, setLifecycles] = React.useState<RowLifecycles>({});
  const [submitting, setSubmitting] = React.useState<string | null>(null);

  const runDiscovery = discovery.execute;
  React.useEffect(() => {
    // Discovery is what this page is for, so it reads once on mount. Every later
    // read is a press: a settings page that polls a provider spends the account's
    // rate budget for a reader who already has their answer.
    void runDiscovery({ v: 1 });
  }, [runDiscovery]);

  const refresh = React.useCallback(() => {
    // A settled sentence is about the press that produced it and does not
    // survive a re-read. What the target said a row IS does survive, because it
    // is the only record this page holds of the exact rows it may administer.
    setOutcomes({});
    void runDiscovery({ v: 1 });
  }, [runDiscovery]);

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
    setLifecycles((previous) => ({
      ...previous,
      [key]: advanceTriageSourceSettingsRowLifecycle(
        previous[key] ?? UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
        outcome,
      ),
    }));
  }, [administerExecute]);

  const runControl = React.useCallback((
    candidate: TriageSourceSettingsCandidateV1,
    control: TriageSourceSettingsRowControlV1['id'],
    sourceInstanceId: string | null,
  ) => {
    if (control === 'add') {
      void submit(candidate.key, { v: 1, kind: 'create', draft: candidate.draft });
      return;
    }
    // Every other arm names one exact row. Without the id the target minted
    // there is nothing to name, which is why those controls are not offered
    // until it has been returned.
    if (sourceInstanceId === null) return;
    if (control === 'remove') {
      void submit(candidate.key, { v: 1, kind: 'remove', sourceInstanceId });
      return;
    }
    if (control === 'restore') {
      void submit(candidate.key, {
        v: 1,
        kind: 'reactivate',
        sourceInstanceId,
        draft: candidate.draft,
      });
      return;
    }
    void submit(candidate.key, {
      v: 1,
      kind: 'reconfigure',
      sourceInstanceId,
      draft: candidate.draft,
    });
  }, [submit]);

  const state = readTriageSourceDiscovery(discovery.execution);

  return (
    <Screen safeArea>
      <ScrollArea>
        <Stack gap="large">
          <Stack gap="small">
            <Heading level={2} value={`${SOURCE_DISPLAY_NAME} in PRs & Issues`} />
            <Text
              tone="secondary"
              value={`Choose which ${SOURCE_DISPLAY_NAME} accounts and scopes appear in PRs & Issues. Accounts come from Connected Accounts; nothing here sees a token.`}
            />
          </Stack>

          {state.kind === 'loading' ? (
            <LoadingState
              title={`Reading ${SOURCE_DISPLAY_NAME} accounts`}
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
              description={`The ${SOURCE_DISPLAY_NAME} source returned a result outside the published contract.`}
              action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
            />
          ) : null}

          {state.kind === 'unreachable' ? (
            <ErrorState
              title={`${SOURCE_DISPLAY_NAME} could not be read`}
              description={state.failure === null
                ? state.message ?? 'No machine answered this read.'
                : describeTriageSourceFailure(state.failure)}
              action={<Button title="Try again" variant="secondary" onPress={refresh} />}
            />
          ) : null}

          {state.kind === 'listed' ? (
            <Stack gap="medium">
              {!state.complete ? (
                <Banner
                  tone="warning"
                  title="This list may be incomplete"
                  description={state.listingFailure === null
                    ? 'Some accounts or scopes could not be enumerated, so one you expect may be missing.'
                    : describeTriageSourceFailure(state.listingFailure)}
                />
              ) : null}

              {state.candidates.length === 0 ? (
                <EmptyState
                  title={`No ${SOURCE_DISPLAY_NAME} scopes to add`}
                  description={`Connect a ${SOURCE_DISPLAY_NAME} account in Connected Accounts, then refresh.`}
                  action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
                />
              ) : (
                <ItemGroup accessibilityLabel={`${SOURCE_DISPLAY_NAME} scopes`}>
                  {state.candidates.map((candidate) => {
                    const row = projectTriageSourceSettingsRow({
                      candidate,
                      lifecycle: lifecycles[candidate.key]
                        ?? UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
                      outcome: outcomes[candidate.key],
                      sourceDisplayName: SOURCE_DISPLAY_NAME,
                    });
                    const busy = submitting === candidate.key;
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
                                  runControl(candidate, control.id, row.sourceInstanceId);
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

              {state.failures.length === 0 ? null : (
                <Stack gap="small">
                  <Heading level={3} value="Accounts that could not be read" />
                  <ItemGroup accessibilityLabel="Accounts that could not be read">
                    {state.failures.map((entry) => (
                      <Item
                        key={entry.key}
                        title={entry.localInstanceKey ?? entry.accountId}
                        subtitle={describeTriageSourceFailure(entry.failure)}
                        tone="danger"
                      />
                    ))}
                  </ItemGroup>
                </Stack>
              )}

              <Row gap="small">
                <Button title="Refresh" variant="secondary" onPress={refresh} />
              </Row>
            </Stack>
          ) : null}
        </Stack>
      </ScrollArea>
    </Screen>
  );
}

export const renderSurface = defineUiSurface(GithubTriageSettingsSurface);
