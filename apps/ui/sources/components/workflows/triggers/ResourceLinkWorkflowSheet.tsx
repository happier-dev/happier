import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  ValueFieldSelect,
  type ValueFieldSelectItem,
} from '@/components/ui/forms/ValueFieldSelect';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { SELECTION_LIST_MODAL_MAX_HEIGHT, SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { WORKFLOW_STACKED_LABEL_TRACK, WorkflowKindCardLabelTrack } from '@/components/workflows/editor/WorkflowStepDataEditor';
import { t } from '@/text';

import { TRIGGER_POPOVER_WIDTH } from './TriggerPopover';
import { TriggerPluginEventRows } from './TriggerPluginEventRows';
import {
  ActionTriggerPolicyRows,
  FieldButton,
  TrackRow,
} from './WorkflowTriggerBlock';
import type { ResourceAutomationsSectionRead } from './useResourceAutomationsSection';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import { formatWorkflowLinkStartLabel, type ResourceWorkflowTriggerStartOption } from './workflowTriggerStarts';

const stylesheet = StyleSheet.create((theme) => ({
  // The section around it insets the rows and sets its title, as the Event setup step's (one layout for both steps).
  body: {
    paddingBottom: theme.space.s8,
    gap: theme.space.s8,
  },
  // Workflow and When span the value track, so the sheet's fields share one width (lab `automations-states-link`).
  selectBox: { minWidth: 0, alignSelf: 'stretch' },
  note: { color: theme.colors.text.secondary, flexShrink: 1 },
  // Under one hairline on the rows' edge, pinned below the scrolling rows (the trigger popover's foot).
  foot: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s8,
    marginHorizontal: theme.space.s16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s16,
  },
  failure: { color: theme.colors.state.danger.textForeground, flexShrink: 1 },
}));

const LINK_GROUPS = [
  ['yours', 'workflows.triggers.link.yours'],
  ['shared', 'workflows.triggers.link.sharedWithYou'],
  ['builtin', 'workflows.triggers.link.builtIn'],
  ['plugin', 'workflows.plugins.fromPlugins'],
] as const;

/**
 * Link a workflow to this resource (05 S5 `automations:states:{pick,link,share}`): **Workflow**, **When** (the
 * resource's own before/after Actions and Events, from the section's one start read), the before trigger's wait
 * policy, and — on a resource other people can see — the same-step "Also share ⟨W⟩?" question (D8). Cancel keeps
 * the workflow private and unlinked; the primary says what it will do (Link, or Share and link).
 */
export function ResourceLinkWorkflowSheet(
  props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    resourceName: string;
    link: ResourceAutomationsSectionRead['link'];
    serverId: string | null;
    machineId: string | null;
    accountLifetime: ResourceAutomationsSectionRead['accountLifetime'];
    onRequestClose: () => void;
    onLinked: () => void;
  }>,
) {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const { link } = props;
  const { workflowOptions } = useTriggerThenOptions({
    libraryEnabled: true,
    ...(props.accountLifetime === undefined
      ? {}
      : { accountLifetime: props.accountLifetime }),
  });
  const [workflow, setWorkflow] = React.useState<string | null>(null);
  const [whenId, setWhenId] = React.useState<string | null>(null);
  const [when, setWhen] = React.useState<ResourceWorkflowTriggerStartOption['when'] | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  // Setting up an Event is the sheet's own next step (as in the trigger popover): one sheet, one footer at a time.
  const [eventEditing, setEventEditing] = React.useState(false);
  const choice = React.useMemo(
    () => link.whenOptions.find((option) => option.id === whenId) ?? null,
    [link.whenOptions, whenId],
  );
  const { setDraft } = link;
  const draftFor = React.useCallback(
    (
      ref: string | null,
      nextWhen: ResourceWorkflowTriggerStartOption['when'] | null,
      eventStart?: Extract<ResourceWorkflowTriggerStartOption, { relation: 'event' }>,
    ) => {
      // An Event start is configured in its own rows first; the draft follows once its value exists.
      if (!ref || !nextWhen) return setDraft(null);
      if (nextWhen.kind === 'pluginEvent') {
        return setDraft(nextWhen.value && eventStart ? { workflow: ref, trigger: nextWhen.value } : null, eventStart);
      }
      setDraft({ workflow: ref, trigger: { ...nextWhen, enabled: true } });
    },
    [setDraft],
  );
  // Closing the sheet drops its draft; a new setter identity on a later render must not clear it mid-choice.
  const clearDraft = React.useRef(setDraft);
  clearDraft.current = setDraft;
  React.useEffect(() => () => clearDraft.current(null), []);

  // Pick first, then configure (lab `automations-states-pick` → `link`): the sheet opens on the workflow list itself,
  // so choosing a workflow never hangs a second menu over the sheet's own foot.
  const pickStep = React.useMemo<SelectionListStep>(() => {
    const groups = LINK_GROUPS.map(([origin, title]) => ({
      kind: 'static' as const,
      id: origin,
      title: t(title),
      options: workflowOptions.filter((option) => (option.origin ?? 'yours') === origin).map((option) => ({
        id: option.ref,
        label: option.title,
        icon: <Icon name="tree-structure" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
        testID: `resource-link-pick:${option.ref}`,
        ...(option.unavailableReason ? { disabled: true, subtitle: option.unavailableReason } : {}),
      })),
    })).filter((group) => group.options.length > 0);
    return { id: 'resource-link-pick', inputPlaceholder: t('workflows.triggers.link.findWorkflow'), sections: groups };
  }, [theme.colors.text.secondary, workflowOptions]);

  const workflowItems = React.useMemo<ValueFieldSelectItem[]>(
    () =>
      // The menu keeps first-seen group order.
      LINK_GROUPS.flatMap(([origin, title]) => workflowOptions
        .filter((option) => (option.origin ?? 'yours') === origin)
        .map((option) => ({
          id: option.ref,
          title: option.title,
          category: t(title),
          ...(option.unavailableReason ? { disabled: true, subtitle: option.unavailableReason } : {}),
          icon: <Icon name="tree-structure" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />,
        }))),
    [theme.colors.text.secondary, workflowOptions],
  );
  const whenItems = React.useMemo<ValueFieldSelectItem[]>(
    () =>
      link.whenOptions.map((option) => ({
        id: option.id,
        title: formatWorkflowLinkStartLabel(option),
        category: t(
          option.relation === 'event'
            ? 'workflows.triggers.link.groupEvents'
            : 'workflows.triggers.link.groupActions',
        ),
      })),
    [link.whenOptions],
  );

  const missing = link.missingAudience ?? [];
  const names = useSharePrincipalNames(
    missing.length > 0 ? missing : null,
    props.serverId,
    link.audienceNames,
  );
  const recipientNames = missing.map(principal => names.names?.get(sharePrincipalKey(principal)));
  const recipientsIdentified = recipientNames.every(name => name !== undefined);
  const audience = recipientsIdentified ? recipientNames.join(', ') : '';
  const workflowTitle =
    workflowOptions.find((option) => option.ref === workflow)?.title ?? '';
  const sharing = missing.length > 0;
  const whenBlock = link.whenStatus === 'unavailable' ? t('workflows.triggers.section.startsUnavailable')
    : link.whenStatus === 'machineOffline' ? t('workflows.triggers.section.startsNeedMachineOnline')
      : link.whenStatus !== 'ready' ? t('common.loading')
        : !choice ? t(whenItems.length === 0 ? 'workflows.triggers.link.noStarts' : 'workflows.triggers.link.chooseWhen')
          : choice.relation === 'event' && when?.kind === 'pluginEvent' && when.value === null
            ? t('workflows.triggers.link.finishEventSetup') : null;
  const ready = whenBlock === null && link.draft !== null && !link.loading && link.issue == null && recipientsIdentified;

  // The When field's own placeholder already asks for a start; a note under it says only what the field can't.
  const whenNote = !(link.whenStatus === 'ready' && !choice && whenItems.length > 0);
  const eventChoice = choice?.relation === 'event' && when?.kind === 'pluginEvent' ? { choice, when } : null;
  const eventRows = eventChoice ? (editing: boolean, maxHeight?: number, stackedFields = false) => (
    <TriggerPluginEventRows
      testID="resource-link-event"
      eventTitle={eventChoice.choice.label}
      when={eventChoice.when}
      initialEventSeed={eventChoice.choice.eventSeed}
      machineId={props.machineId}
      serverId={props.serverId}
      editing={editing}
      onEditingChange={setEventEditing}
      editorMaxHeight={maxHeight}
      onChange={(next) => {
        if (next.kind === 'pluginEvent') {
          setWhen(next);
          draftFor(workflow, next, eventChoice.choice);
        }
      }}
      renderEntry={(entry) => (
        <TrackRow label={t('workflows.triggers.card.source')} trackKey="resource-link-event">
          <View style={styles.selectBox}>
            <FieldButton
              testID="resource-link-event-configure-event"
              fill={stackedFields}
              label={t('workflows.triggers.card.source')}
              value={entry.detail ?? t(entry.configured ? 'workflows.triggers.popover.editEvent' : 'workflows.triggers.card.setUp')}
              onPress={entry.onPress}
            />
          </View>
        </TrackRow>
      )}
    />
  ) : null;

  const submit = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await link.submit('accept');
      if (result.ok) {
        props.onLinked();
        return;
      }
      setFailure(
        result.phase === 'declined'
          ? null
          : t(
              result.phase === 'sharing'
                ? 'workflows.triggers.link.shareFailed'
                : 'workflows.triggers.link.linkFailed',
              {
                reason:
                  'error' in result
                    ? formatWorkflowProblemMessage(result.error)
                    : '',
              },
            ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      onRequestClose={props.onRequestClose}
      placement="bottom"
      phonePresentation="sheet"
      autoFocusOnOpen
      // A phone sheet's band names the step it shows: the link, or the Event's setup.
      accessibilityLabel={eventEditing && eventRows ? t('workflows.triggers.popover.configureEvent') : t('workflows.triggers.link.title', {
        name: props.resourceName,
      })}
      maxWidthCap={TRIGGER_POPOVER_WIDTH}
      // The shared picker ceiling: as Yours arrives the list grows to it and then scrolls, never up over the window's tabs.
      maxHeightCap={Math.min(height, SELECTION_LIST_MODAL_MAX_HEIGHT)}
      portal={{
        web: { target: 'body' },
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
    >
      {({ maxHeight, presentation }) => workflow === null ? (
        <FloatingOverlay maxHeight={maxHeight}>
          <SelectionList
            testID="resource-link-pick"
            rootStep={pickStep}
            selectedOptionId={null}
            listAccessibilityLabel={t('workflows.triggers.link.title', { name: props.resourceName })}
            onSelect={(id) => {
              setWorkflow(id);
              draftFor(id, when, choice?.relation === 'event' ? choice : undefined);
            }}
            onRequestClose={props.onRequestClose}
            autoFocusInputOnWeb
            maxHeight={maxHeight}
            heightBehavior="stabilizedContentHeight"
          />
        </FloatingOverlay>
      ) : eventEditing && eventRows ? (
        // The Event's setup replaces the sheet with its own step and footer; Done or Cancel comes back here.
        eventRows(true, maxHeight)
      ) : (
        <FloatingOverlay maxHeight={maxHeight} scrollEnabled footer={(
          <View style={styles.foot}>
            <RoundButton
              testID="resource-link-cancel"
              size="small"
              display="inverted"
              title={t('common.cancel')}
              onPress={() => {
                void link.submit('decline');
                props.onRequestClose();
              }}
            />
            <RoundButton
              testID="resource-link-submit"
              size="small"
              title={t(
                sharing
                  ? 'workflows.triggers.link.shareAndLink'
                  : 'workflows.triggers.link.link',
              )}
              disabled={!ready}
              loading={submitting}
              onPress={() => {
                void submit();
              }}
            />
          </View>
        )}>
          {/* A phone sheet stacks each label over its field (lab `automations-states-link` at 390). */}
          <WorkflowKindCardLabelTrack.Provider value={presentation === 'sheet' ? WORKFLOW_STACKED_LABEL_TRACK : null}>
          {/* Titled as the setup step is (its section title); a phone sheet's band already names it. */}
          <ListPresentationProvider value="page"><ItemGroup surface="none"
            title={presentation === 'sheet' ? undefined : t('workflows.triggers.link.title', { name: props.resourceName })}>
          <ListPresentationProvider value="grouped" floating={presentation === 'sheet'}>
          <View style={styles.body} testID="resource-link-sheet">
            <TrackRow
              label={t('workflows.triggers.link.workflow')}
              trackKey="resource-link-workflow"
            >
              <View style={styles.selectBox}>
                <ValueFieldSelect
                  testID="resource-link-workflow"
                  // Stacked under its label on a phone, the field spans the sheet (lab at 390).
                  fill={presentation === 'sheet'}
                  label={t('workflows.triggers.link.workflow')}
                  items={workflowItems}
                  selectedId={workflow}
                  placeholder={t('workflows.triggers.link.chooseWorkflow')}
                  searchPlaceholder={t('workflows.triggers.link.findWorkflow')}
                  onSelect={(id) => {
                    setWorkflow(id);
                    draftFor(id, when, choice?.relation === 'event' ? choice : undefined);
                  }}
                />
              </View>
            </TrackRow>
            <TrackRow
              label={t('workflows.triggers.link.when')}
              trackKey="resource-link-when"
            >
              <View style={styles.selectBox}>
                <ValueFieldSelect
                  testID="resource-link-when"
                  fill={presentation === 'sheet'}
                  label={t('workflows.triggers.link.when')}
                  items={whenItems}
                  selectedId={whenId}
                  placeholder={t('workflows.triggers.link.chooseWhen')}
                  emptyLabel={
                    link.whenStatus === 'loading'
                      ? t('common.loading')
                      : link.whenStatus === 'unavailable'
                        ? t('common.unavailable')
                        : t('workflows.triggers.link.noStarts')
                  }
                  onSelect={(id) => {
                    const next =
                      link.whenOptions.find((option) => option.id === id) ??
                      null;
                    const when =
                      next && next.relation !== 'event'
                        ? {
                            ...next.when,
                            ...(next.relation === 'before'
                              ? { mode: 'wait' as const }
                              : {}),
                          }
                        : next?.when ?? null;
                    setWhenId(id);
                    setWhen(when);
                    draftFor(workflow, when);
                  }}
                />
              </View>
            </TrackRow>
            {when?.kind === 'action' ? (
              <ActionTriggerPolicyRows
                testID="resource-link-policy"
                when={when}
                onChange={(next) => {
                  setWhen(next);
                  draftFor(workflow, next);
                }}
              />
            ) : null}
            {eventRows ? eventRows(false, undefined, presentation === 'sheet') : null}
            {sharing && recipientsIdentified ? (
              <AttentionBanner
                testID="resource-link-share"
                tone="neutral"
                placement="inline"
                iconName="users"
                title={t('workflows.triggers.link.shareTitle', {
                  workflow: workflowTitle,
                  audience,
                })}
                description={t('workflows.triggers.link.shareBody', {
                  name: props.resourceName,
                  audience,
                })}
              />
            ) : null}
            {link.issue ? (
              <SurfaceStateCard
                testID="resource-link-review"
                size="line"
                kind="error"
                title={link.issue.message}
                action={link.issue.retryable ? { label: t('common.retry'), onPress: link.retryReview } : undefined}
              />
            ) : null}
            {!link.issue && (link.loading || (sharing && !recipientsIdentified)) ? (
              <SurfaceStateCard
                testID="resource-link-review"
                size="line"
                kind={link.loading || names.resolving ? 'loading' : 'unavailable'}
                title={link.loading || names.resolving ? t('common.loading') : t('workflows.triggers.link.reviewFailed')}
              />
            ) : null}
            {whenBlock && whenNote && !link.issue && !link.loading ? (
              // Under the fields' column, as a row's consequence reads (lab `automations-states-link`).
              <TrackRow label="" trackKey="resource-link-note">
                {link.whenStatus === 'ready' ? (
                  <Text variant="meta" testID="resource-link-blocked" style={styles.note}>{whenBlock}</Text>
                ) : (
                  <SurfaceStateCard
                    testID={link.whenStatus === 'unavailable' ? 'resource-link-starts-unavailable' : 'resource-link-blocked'}
                    size="line"
                    kind={link.whenStatus === 'unavailable' || link.whenStatus === 'machineOffline' ? 'unavailable' : 'loading'}
                    title={whenBlock}
                    action={link.whenStatus === 'unavailable' ? { label: t('common.retry'), onPress: link.retryWhen } : undefined}
                  />
                )}
              </TrackRow>
            ) : null}
            {failure ? (
              <Text
                variant="meta"
                testID="resource-link-failure"
                style={styles.failure}
              >
                {failure}
              </Text>
            ) : null}
          </View>
          </ListPresentationProvider>
          </ItemGroup></ListPresentationProvider>
          </WorkflowKindCardLabelTrack.Provider>
        </FloatingOverlay>
      )}
    </Popover>
  );
}
