import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPageHeader,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import type {
  ProjectExecutionChoiceV1,
  WorkerDestinationV1,
  WorkspaceWorkerPreferenceReadResultV1,
  WorkspaceWorkerPreferenceV1,
} from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Switch } from '@/components/ui/forms/Switch';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { executeProjectWorkerActionV1 } from '@/sync/ops/actions/projectWorkerActions';
import { t } from '@/text';

import {
  useObservedWorkerSetting,
  type ObservedWorkerSettingNotice,
} from './useObservedWorkerSetting';
import { useWorkerDestinationLabel } from './useWorkerDestinationLabel';
import { WorkerDestinationPicker } from './WorkerDestinationPicker';
import { WorkspaceAdHocCommandsItem } from './WorkspaceAdHocCommandsItem';

type ReadyPreference = Extract<
  WorkspaceWorkerPreferenceReadResultV1,
  { status: 'ready' }
>;

/** A declared script as the project file states it: only explicitly portable scripts may leave. */
export type WorkspaceWorkerScript = Readonly<{
  name: string;
  portable: boolean;
}>;

/** The checkout's worker preference, read and changed only through its semantic Actions (30s1). */
export function useWorkspaceWorkerPreference(workspace: WorkspaceAddressV1, options?: Readonly<{ enabled?: boolean }>) {
  const address = React.useMemo(
    () => ({ serverId: workspace.serverId, refId: workspace.workspaceId }),
    [workspace.serverId, workspace.workspaceId],
  );
  const setting = useObservedWorkerSetting<ReadyPreference>({
    enabled: options?.enabled,
    serverId: address.serverId,
    scopeKey: JSON.stringify([
      'projects.worker.preferences',
      address.serverId,
      address.refId,
    ]),
    read: (accountId) =>
      executeProjectWorkerActionV1(
        'projects.worker.preferences.get',
        { workspace: address },
        { expectedAccountId: accountId },
      ),
    observedFromReceipt: (receipt) =>
      'preference' in receipt
        ? ({
            ...(receipt as Omit<ReadyPreference, 'status'>),
            status: 'ready',
          } as ReadyPreference)
        : null,
  });
  const { mutate } = setting;
  // The observed entry is the compare-and-set expectation: a default provenance has no saved finite entry.
  const save = React.useCallback(
    (next: WorkspaceWorkerPreferenceV1) =>
      mutate((accountId, current) =>
        executeProjectWorkerActionV1(
          'projects.worker.preferences.set',
          {
            workspace: address,
            expectedRevision: current.revision,
            expected:
              current.provenance === 'default'
                ? { kind: 'absent' }
                : { kind: 'value', value: current.preference },
            next,
          },
          { expectedAccountId: accountId },
        ),
      ),
    [address, mutate],
  );
  const reset = React.useCallback(
    () =>
      mutate((accountId, current) =>
        executeProjectWorkerActionV1(
          'projects.worker.preferences.reset',
          {
            workspace: address,
            expectedRevision: current.revision,
            expected:
              current.provenance === 'default'
                ? { kind: 'absent' }
                : { kind: 'value', value: current.preference },
          },
          { expectedAccountId: accountId },
        ),
      ),
    [address, mutate],
  );
  return { ...setting, address, save, reset };
}

function noticeText(notice: ObservedWorkerSettingNotice): string | null {
  switch (notice) {
    case 'saving':
      return t('projectWorkers.saving');
    case 'approval':
      return t('projectWorkers.approvalPending');
    case 'unknown':
      return t('projectWorkers.writeUnknown');
    case 'changed':
      return t('projectWorkers.changed');
    case 'failed':
      return t('projectWorkers.saveFailed');
    case 'locked':
      return t('projectWorkers.settingsLocked');
    default:
      return null;
  }
}

function withDestination(
  preference: WorkspaceWorkerPreferenceV1,
  destination: WorkerDestinationV1,
  enabled: boolean,
): WorkspaceWorkerPreferenceV1 {
  const {
    enabled: _enabled,
    destination: _destination,
    ...fields
  } = preference;
  return enabled
    ? { ...fields, enabled: true, destination }
    : { ...fields, enabled: false, destination };
}

function withoutOverride(
  overrides: Readonly<Record<string, 'primary' | 'workers'>>,
  name: string,
) {
  const next = { ...overrides };
  delete next[name];
  return next;
}

/**
 * Workspace › Workers (30s1/30s3, lab `s-workers PREFS`): where this checkout's portable scripts run,
 * personal to the viewer. Every control is one semantic `projects.worker.preferences.*` write against
 * the observed value; nothing here starts, stops or moves work.
 */
export function WorkspaceWorkerSettings(
  props: Readonly<{
    testID?: string;
    workspace: WorkspaceAddressV1;
    scripts: ReadonlyArray<WorkspaceWorkerScript>;
    onBack: () => void;
  }>,
) {
  const testID = props.testID ?? 'workspace-worker-settings';
  const { theme } = useUnistyles();
  const columnMaxWidth = useLayoutMaxWidth();
  const preference = useWorkspaceWorkerPreference(props.workspace);
  const runOnAnchor = React.useRef<View>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Turning workers on without a destination first asks where; the switch alone never saves an invalid row.
  const [enableAfterChoice, setEnableAfterChoice] = React.useState(false);
  const [fallbackOpen, setFallbackOpen] = React.useState(false);
  const state = preference.state;
  const value = state.kind === 'ready' ? state.value.preference : null;
  const choice: ProjectExecutionChoiceV1 | null = value?.destination
    ? { kind: 'workers', destination: value.destination }
    : null;
  const label = useWorkerDestinationLabel(
    props.workspace.serverId,
    choice,
    props.workspace.machineId,
  );
  const disabled = state.kind !== 'ready' || preference.busy;
  const notice = noticeText(preference.notice);
  const destinationName =
    label.name ??
    (label.missing ? t('projectWorkers.destinationMissing') : null);
  const defaultSummary = value?.destination
    ? value.destination.kind === 'pool'
      ? t(
          value.destination.selection === 'ask'
            ? 'projectWorkers.poolAsk'
            : 'projectWorkers.poolAutomatic',
          { pool: label.name ?? '' },
        )
      : (label.name ?? '')
    : t('projectWorkers.primary');

  const header = (
    <HappierPageHeader
      title={t('projectWorkers.title')}
      description={t('projectWorkers.description')}
      showTitle
      columnMaxWidthPx={columnMaxWidth}
      renderText={renderPageHeaderText}
      renderBack={(style) => (
        <View style={style as StyleProp<ViewStyle>}>
          <IconButton
            testID={`${testID}.back`}
            iconName="caret-left"
            variant="plain"
            accessibilityLabel={t('projectWorkers.backToScripts')}
            onPress={props.onBack}
          />
        </View>
      )}
    />
  );

  if (state.kind !== 'ready' || !value) {
    return (
      <View testID={testID} style={styles.page}>
        {header}
        <SurfaceStateCard
          testID={`${testID}.state`}
          kind={state.kind === 'loading' ? 'loading' : 'unavailable'}
          title={
            state.kind === 'loading'
              ? t('common.loading')
              : state.kind === 'refused' && state.status === 'locked'
                ? t('projectWorkers.settingsLocked')
                : t('projectWorkers.policyUnavailable')
          }
          {...(state.kind === 'loading'
            ? {}
            : {
                action: {
                  label: t('common.retry'),
                  onPress: preference.refresh,
                },
              })}
        />
      </View>
    );
  }

  const choose = (next: ProjectExecutionChoiceV1) => {
    setPickerOpen(false);
    if (next.kind !== 'workers') return;
    const enable = value.enabled || enableAfterChoice;
    setEnableAfterChoice(false);
    void preference.save(withDestination(value, next.destination, enable));
  };

  const fallbackItems = [
    { id: 'ask', title: t('projectWorkers.fallbackAsk') },
    { id: 'primary', title: t('projectWorkers.fallbackPrimary') },
    { id: 'fail', title: t('projectWorkers.fallbackFail') },
  ] as const;

  return (
    <View testID={testID} style={styles.page}>
      {header}
      {notice ? (
        <AttentionBanner
          testID={`${testID}.notice`}
          tone={
            preference.notice === 'saving' || preference.notice === 'approval'
              ? 'neutral'
              : 'warning'
          }
          title={notice}
          {...(preference.notice === 'unknown' || preference.notice === 'failed'
            ? {
                action: {
                  label: t('common.retry'),
                  onPress: preference.refresh,
                },
              }
            : {})}
        />
      ) : null}
      <ItemGroup title={t('projectWorkers.defaultSection')}>
        <Item
          testID={`${testID}.enabled`}
          title={t('projectWorkers.enabled')}
          subtitle={t('projectWorkers.enabledDetail')}
          showChevron={false}
          disabled={disabled}
          rightElement={
            <Switch
              testID={`${testID}.enabled.switch`}
              value={value.enabled}
              disabled={disabled}
              accessibilityLabel={t('projectWorkers.enabled')}
              onValueChange={(enabled) => {
                if (!enabled) {
                  void preference.save(
                    value.destination
                      ? withDestination(value, value.destination, false)
                      : { ...value, enabled: false },
                  );
                } else if (value.destination) {
                  void preference.save(
                    withDestination(value, value.destination, true),
                  );
                } else {
                  setEnableAfterChoice(true);
                  setPickerOpen(true);
                }
              }}
            />
          }
        />
        <View ref={runOnAnchor} collapsable={false}>
          <Item
            testID={`${testID}.destination`}
            title={t('projectWorkers.destination')}
            subtitle={
              label.missing
                ? t('projectWorkers.destinationMissing')
                : t('projectWorkers.destinationDetail')
            }
            showChevron={false}
            accessoryLayout="adaptive"
            disabled={disabled}
            accessibilityExpanded={pickerOpen}
            onPress={() => setPickerOpen(true)}
            rightElement={renderDropdownItemTriggerRightElement({
              detail: destinationName,
              open: pickerOpen,
              detailColor: theme.colors.text.primary,
              chevronColor: theme.colors.text.secondary,
              field: resolveFieldBoxColors(
                theme,
                label.missing ? 'invalid' : 'idle',
              ),
              placeholder: t('common.choose'),
              placeholderColor: theme.colors.input.placeholder,
            })}
          />
        </View>
        {value.destination?.kind === 'pool' ? (
          <SegmentedChoiceItem<'automatic' | 'ask'>
            testIDPrefix={`${testID}.selection`}
            title={t('projectWorkers.pickWorker')}
            disabled={disabled}
            value={value.destination.selection}
            options={[
              { id: 'automatic', label: t('projectWorkers.automatic') },
              { id: 'ask', label: t('projectWorkers.ask') },
            ]}
            onChange={(selection) => {
              if (
                value.destination?.kind !== 'pool' ||
                value.destination.selection === selection
              )
                return;
              void preference.save(
                withDestination(
                  value,
                  { ...value.destination, selection },
                  value.enabled,
                ),
              );
            }}
          />
        ) : null}
        <DropdownMenu
          testID={`${testID}.fallback`}
          open={fallbackOpen}
          onOpenChange={setFallbackOpen}
          items={fallbackItems}
          selectedId={value.unavailable}
          search={false}
          itemTrigger={{
            title: t('projectWorkers.whenUnavailable'),
            subtitle: t('projectWorkers.whenUnavailableDetail'),
            showSelectedSubtitle: false,
            itemProps: { disabled },
          }}
          onSelect={(id) => {
            setFallbackOpen(false);
            const unavailable =
              id as WorkspaceWorkerPreferenceV1['unavailable'];
            if (unavailable !== value.unavailable)
              void preference.save({ ...value, unavailable });
          }}
        />
      </ItemGroup>

      {props.scripts.length > 0 ? (
        <ItemGroup
          title={t('projectWorkers.perScript')}
          description={t('projectWorkers.perScriptDetail')}
        >
          {props.scripts.map((script) => {
            if (!script.portable) {
              return (
                <Item
                  key={script.name}
                  testID={`${testID}.script:${script.name}`}
                  title={script.name}
                  subtitle={t('projectWorkers.primaryOnly')}
                  mode="info"
                  disabled
                  showChevron={false}
                />
              );
            }
            const override = value.scriptOverrides[script.name];
            const current = override ?? 'default';
            return (
              <SegmentedChoiceItem<'default' | 'primary' | 'workers'>
                key={script.name}
                testIDPrefix={`${testID}.script:${script.name}`}
                title={script.name}
                subtitle={
                  override === 'workers'
                    ? t('projectWorkers.alwaysWorker')
                    : override === 'primary'
                      ? t('projectWorkers.alwaysPrimary')
                      : t('projectWorkers.defaultSummary', {
                          destination: value.enabled
                            ? defaultSummary
                            : t('projectWorkers.primary'),
                        })
                }
                disabled={disabled}
                value={current}
                options={[
                  { id: 'default', label: t('projectWorkers.overrideDefault') },
                  { id: 'primary', label: t('projectWorkers.primary') },
                  { id: 'workers', label: t('projectWorkers.overrideWorkers') },
                ]}
                onChange={(next) => {
                  if (next === current) return;
                  void preference.save({
                    ...value,
                    scriptOverrides:
                      next === 'default'
                        ? withoutOverride(value.scriptOverrides, script.name)
                        : { ...value.scriptOverrides, [script.name]: next },
                  });
                }}
              />
            );
          })}
        </ItemGroup>
      ) : null}

      <ItemGroup title={t('projectWorkers.agents')}>
        <WorkspaceAdHocCommandsItem
          testID={`${testID}.adHoc`}
          preference={value}
          disabled={disabled}
          onSave={(next) => { void preference.save(next); }}
        />
      </ItemGroup>

      {state.value.provenance === 'saved' ? (
        <View style={styles.reset}>
          <RoundButton
            testID={`${testID}.reset`}
            size="small"
            display="inverted"
            title={t('projectWorkers.reset')}
            disabled={disabled}
            onPress={() => {
              void (async () => {
                const confirmed = await Modal.confirm(
                  t('projectWorkers.resetConfirm'),
                  t('projectWorkers.resetDetail'),
                );
                if (confirmed) await preference.reset();
              })();
            }}
          />
          <Text
            style={[styles.resetNote, { color: theme.colors.text.secondary }]}
          >
            {t('projectWorkers.resetDetail')}
          </Text>
        </View>
      ) : null}

      <WorkerDestinationPicker
        testID={`${testID}.picker`}
        open={pickerOpen}
        onRequestClose={() => {
          setPickerOpen(false);
          setEnableAfterChoice(false);
        }}
        anchorRef={runOnAnchor}
        title={t('projectWorkers.destination')}
        purpose="finite"
        workspace={preference.address}
        sourceMachineId={props.workspace.machineId}
        poolSelection={
          value.destination?.kind === 'pool'
            ? value.destination.selection
            : 'automatic'
        }
        selected={choice}
        onChoose={choose}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  page: { gap: 16 },
  reset: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  resetNote: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
  },
}));
