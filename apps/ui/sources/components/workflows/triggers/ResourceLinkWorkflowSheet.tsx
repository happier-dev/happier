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
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { t } from '@/text';

import { TRIGGER_POPOVER_WIDTH } from './TriggerPopover';
import { TriggerPluginEventRows } from './TriggerPluginEventRows';
import {
  ActionWaitPolicyRows,
  TrackRow,
} from './WorkflowTriggerBlock';
import type { ResourceAutomationsSectionRead } from './useResourceAutomationsSection';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import type { ResourceWorkflowTriggerStartOption } from './workflowTriggerStarts';

const stylesheet = StyleSheet.create((theme) => ({
  body: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s8,
    gap: theme.space.s8,
  },
  title: { paddingBottom: theme.space.s4 },
  selectBox: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  foot: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  failure: { color: theme.colors.state.danger.textForeground, flexShrink: 1 },
}));

/** Yours · Shared with you · Built-in (lab `automations-states-pick`). */
const LINK_GROUP_ORDER = { yours: 0, shared: 1, builtin: 2 } as const;

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
  const choice = React.useMemo(
    () => link.whenOptions.find((option) => option.id === whenId) ?? null,
    [link.whenOptions, whenId],
  );
  const { setDraft } = link;
  const draftFor = React.useCallback(
    (
      ref: string | null,
      nextWhen: ResourceWorkflowTriggerStartOption['when'] | null,
    ) => {
      // An Event start is configured in its own rows first; the draft follows once its value exists.
      if (!ref || !nextWhen) return setDraft(null);
      if (nextWhen.kind === 'pluginEvent') {
        return setDraft(nextWhen.value ? { workflow: ref, trigger: nextWhen.value } : null);
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
    const ordered = [...workflowOptions].sort((a, b) => LINK_GROUP_ORDER[a.origin ?? 'yours'] - LINK_GROUP_ORDER[b.origin ?? 'yours']);
    const groups = (['yours', 'shared', 'builtin'] as const).map((origin) => ({
      kind: 'static' as const,
      id: origin,
      title: t(origin === 'builtin' ? 'workflows.triggers.link.builtIn'
        : origin === 'shared' ? 'workflows.triggers.link.sharedWithYou' : 'workflows.triggers.link.yours'),
      options: ordered.filter((option) => (option.origin ?? 'yours') === origin).map((option) => ({
        id: option.ref,
        label: option.title,
        icon: <Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
        testID: `resource-link-pick:${option.ref}`,
        ...(option.unavailableReason ? { disabled: true, subtitle: option.unavailableReason } : {}),
      })),
    })).filter((group) => group.options.length > 0);
    return { id: 'resource-link-pick', inputPlaceholder: t('workflows.triggers.link.findWorkflow'), sections: groups };
  }, [theme.colors.text.secondary, workflowOptions]);

  const workflowItems = React.useMemo<ValueFieldSelectItem[]>(
    () =>
      // The menu keeps first-seen group order.
      [...workflowOptions].sort((a, b) => LINK_GROUP_ORDER[a.origin ?? 'yours'] - LINK_GROUP_ORDER[b.origin ?? 'yours']).map((option) => ({
        id: option.ref,
        title: option.title,
        category: t(option.origin === 'builtin' ? 'workflows.triggers.link.builtIn'
          : option.origin === 'shared' ? 'workflows.triggers.link.sharedWithYou' : 'workflows.triggers.link.yours'),
        ...(option.unavailableReason
          ? { disabled: true, subtitle: option.unavailableReason }
          : {}),
        icon: (
          <Icon
            name="tree-structure"
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
        ),
      })),
    [theme.colors.text.secondary, workflowOptions],
  );
  const whenItems = React.useMemo<ValueFieldSelectItem[]>(
    () =>
      link.whenOptions.map((option) => ({
        id: option.id,
        title:
          option.relation === 'before'
            ? t('workflows.triggers.link.beforeAction', {
                action: option.label,
              })
            : option.relation === 'after'
              ? t('workflows.triggers.link.afterAction', {
                  action: option.label,
                })
              : option.label,
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
  );
  const audience = names.names
    ? missing
        .map((principal) => names.names?.get(sharePrincipalKey(principal)))
        .filter(Boolean)
        .join(', ')
    : '';
  const workflowTitle =
    workflowOptions.find((option) => option.ref === workflow)?.title ?? '';
  const sharing = missing.length > 0;
  const ready = link.draft !== null && !link.loading && link.issue == null;

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
      accessibilityLabel={t('workflows.triggers.link.title', {
        name: props.resourceName,
      })}
      maxWidthCap={TRIGGER_POPOVER_WIDTH}
      maxHeightCap={height}
      portal={{
        web: { target: 'body' },
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
    >
      {({ maxHeight }) => workflow === null ? (
        <FloatingOverlay maxHeight={maxHeight}>
          <SelectionList
            testID="resource-link-pick"
            rootStep={pickStep}
            selectedOptionId={null}
            listAccessibilityLabel={t('workflows.triggers.link.title', { name: props.resourceName })}
            onSelect={(id) => {
              setWorkflow(id);
              draftFor(id, when);
            }}
            onRequestClose={props.onRequestClose}
            autoFocusInputOnWeb
            maxHeight={maxHeight}
            heightBehavior="stabilizedContentHeight"
          />
        </FloatingOverlay>
      ) : (
        <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
          <View style={styles.body} testID="resource-link-sheet">
            <Text variant="label" emphasis="semiBold" style={styles.title}>
              {t('workflows.triggers.link.title', { name: props.resourceName })}
            </Text>
            <TrackRow
              label={t('workflows.triggers.link.workflow')}
              trackKey="resource-link-workflow"
            >
              <View style={styles.selectBox}>
                <ValueFieldSelect
                  testID="resource-link-workflow"
                  label={t('workflows.triggers.link.workflow')}
                  items={workflowItems}
                  selectedId={workflow}
                  placeholder={t('workflows.triggers.link.chooseWorkflow')}
                  searchPlaceholder={t('workflows.triggers.link.findWorkflow')}
                  onSelect={(id) => {
                    setWorkflow(id);
                    draftFor(id, when);
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
            {when?.kind === 'action' && when.phase === 'before' ? (
              <ActionWaitPolicyRows
                testID="resource-link-policy"
                when={when}
                onChange={(next) => {
                  setWhen(next);
                  draftFor(workflow, next);
                }}
              />
            ) : null}
            {choice?.relation === 'event' && when?.kind === 'pluginEvent' ? (
              <TriggerPluginEventRows
                testID="resource-link-event"
                when={when}
                initialEventSeed={choice.eventSeed}
                machineId={props.machineId}
                serverId={props.serverId}
                onChange={(next) => {
                  if (next.kind === 'pluginEvent') {
                    setWhen(next);
                    draftFor(workflow, next);
                  }
                }}
              />
            ) : null}
            {sharing ? (
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
                title={t('workflows.triggers.link.reviewFailed')}
                action={{ label: t('common.retry'), onPress: link.retryReview }}
              />
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
        </FloatingOverlay>
      )}
    </Popover>
  );
}
