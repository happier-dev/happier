import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  HAPPIER_PRESS_FEEDBACK_V1,
} from '@happier-dev/plugin-ui/presentation';

import {
  applyWorkflowDefinitionEditsV1,
  setWorkflowDefaultField,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';

import {
  SessionAuthoringControls,
  useSessionAuthoringFieldSummary,
} from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type {
  SessionAuthoringControlFacts,
  SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { SESSION_COMPOSER_CHIP_FIELDS } from '@/components/sessions/new/SessionServerStartDraftComposerBody';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import {
  useWorkflowEditorSelector,
  type WorkflowEditorDraftStore,
} from './workflowEditorDraftStore';
import { WorkflowLastRun } from './WorkflowRecentRuns';
import { WorkflowRolesEditor } from './WorkflowRolesEditor';
import { WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE } from './WorkflowStepInspector';
import { renderWorkflowCardFieldRow } from './workflowCardFieldRow';

/**
 * The long tail every step inherits, in the registry's order: every Session field beside the engine
 * except the four "Who runs it" shows.
 */
const MORE_SESSION_FIELDS: readonly SessionAuthoringFieldId[] = Object.freeze(
  WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE.filter((field) => !SESSION_COMPOSER_CHIP_FIELDS.includes(field)),
);

const styles = StyleSheet.create((theme) => ({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
    paddingTop: theme.space.s8,
    gap: theme.space.s8,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: theme.space.s24,
  },
  headLabel: {
    ...Typography.variant('label'),
    color: theme.colors.text.secondary,
  },
  headLabelOpen: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  summary: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
    marginLeft: 'auto',
    textAlign: 'right',
  },
  body: { gap: theme.space.s4 },
  destination: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    alignSelf: 'flex-start',
  },
  destinationValue: {
    ...Typography.variant('label'),
    color: theme.colors.text.primary,
  },
  rolesSheet: { paddingVertical: theme.space.s8 },
}));

const readDefaults = (draft: WorkflowEditorDraft) => draft.defaults;
const readRoles = (draft: WorkflowEditorDraft) => draft.roles;

function roleNames(roles: WorkflowEditorDraft['roles']): string {
  return (roles ?? [])
    .map((role) => ('name' in role ? role.name : role.roleId))
    .join(', ');
}

/**
 * "More settings" at the foot of How and where it runs (WF-REDESIGN-1116 change e, version C): closed,
 * one line of what the workflow sets beyond the card; open, those Session fields as the same field
 * selects, then Allowed tools, Roles, the description and the last run.
 */
export function WorkflowMoreSettings(
  props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    onChange: (next: WorkflowEditorDraft) => void;
    documentEditable: boolean;
    authoringFacts: SessionAuthoringControlFacts | undefined;
    /** Saved source only; an unsaved draft has no runs. */
    workflowDefinitionId?: string;
    description?: string;
    onChangeDescription?: (next: string) => void;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const defaults = useWorkflowEditorSelector(props.draftStore, readDefaults);
  const roles = useWorkflowEditorSelector(props.draftStore, readRoles);
  const values = React.useMemo(
    () =>
      resolveWorkflowStepSelectionV1({ defaults, purpose: 'authoring' })
        .selection,
    [defaults],
  );
  const setFields = React.useMemo(
    () => MORE_SESSION_FIELDS.filter((field) => Object.hasOwn(defaults, field)),
    [defaults],
  );
  const fieldSummary = useSessionAuthoringFieldSummary({
    fields: setFields,
    values,
    ...(props.authoringFacts === undefined
      ? {}
      : { facts: props.authoringFacts }),
  });
  const names = roleNames(roles);
  const summary = [
    ...fieldSummary,
    ...(names.length === 0
      ? []
      : [t('workflows.page.sections.rolesRow') + ': ' + names]),
  ].join(' · ');
  const readDraft = props.draftStore.get;
  const { onChange } = props;
  const readOnly = !props.documentEditable;
  const changeField = React.useCallback<
    React.ComponentProps<typeof SessionAuthoringControls>['onChangeField']
  >(
    (field, value) => {
      if (!readOnly)
        onChange(setWorkflowDefaultField(readDraft(), field, value));
    },
    [onChange, readDraft, readOnly],
  );
  const id = `${props.testIDPrefix}-more-settings`;

  return (
    <View style={styles.root} testID={id}>
      <HappierPressable
        testID={`${id}-toggle`}
        accessibilityRole="button"
        accessibilityLabel={t('workflows.page.sections.moreSettings')}
        expanded={open}
        onPress={() => setOpen((current) => !current)}
        style={(state) => [
          styles.head,
          state.pressed
            ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
            : null,
          focusRingStyle({
            focused: state.focused,
            color: theme.colors.border.focus,
          }),
        ]}
      >
        <Icon
          name={open ? 'caret-down' : 'caret-right'}
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
        <Text style={open ? styles.headLabelOpen : styles.headLabel}>
          {t('workflows.page.sections.moreSettings')}
        </Text>
        {open || summary.length === 0 ? null : (
          <Text
            testID={`${id}-summary`}
            numberOfLines={1}
            style={styles.summary}
          >
            {summary}
          </Text>
        )}
      </HappierPressable>
      {!open ? null : (
        <View style={styles.body}>
          {/* Each field on the card's label track, named by its canonical title (round 1116b review). */}
          <SessionAuthoringControls
            presentation="selects"
            renderFieldRow={renderWorkflowCardFieldRow}
            disabled={readOnly}
            fields={MORE_SESSION_FIELDS}
            values={values}
            // The engine these fields wait on is "Who runs it" or a step's header chip, never this list.
            engineChipBeside
            onChangeField={changeField}
            {...(props.authoringFacts === undefined
              ? {}
              : { facts: props.authoringFacts })}
            testIDPrefix={`${id}-session`}
          />
          {renderWorkflowCardFieldRow('roles', t('workflows.page.sections.rolesRow'),
            <WorkflowRolesValue draftStore={props.draftStore} names={names} onChange={onChange}
              editable={!readOnly} testID={`${id}-roles`} />)}
          {props.description === undefined && props.onChangeDescription === undefined ? null
            : renderWorkflowCardFieldRow('description', t('workflows.page.descriptionLabel'),
              <FieldTextInput
                value={props.description ?? ''}
                multiline
                editable={!readOnly && props.onChangeDescription !== undefined}
                placeholder={t('workflows.page.descriptionPlaceholder')}
                accessibilityLabel={t('workflows.page.descriptionLabel')}
                onChangeText={(next) => props.onChangeDescription?.(next)}
                testID={`${id}-description`}
              />)}
          {props.workflowDefinitionId === undefined ? null
            : renderWorkflowCardFieldRow('last-run', t('workflows.page.sections.lastRun'),
              <WorkflowLastRun definitionId={props.workflowDefinitionId} testID={`${id}-last-run`} />)}
        </View>
      )}
    </View>
  );
}

/** Roles as a value and a chevron: the roles editor opens anchored to it. */
function WorkflowRolesValue(
  props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    names: string;
    onChange: (next: WorkflowEditorDraft) => void;
    editable: boolean;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
  return (
    <>
      <View
        ref={anchorRef}
        collapsable={false}
        style={{ alignSelf: 'flex-start' }}
      >
        <HappierPressable
          testID={props.testID}
          accessibilityRole="button"
          accessibilityLabel={`${t('workflows.page.sections.rolesRow')}: ${props.names || t('workflows.page.inspector.none')}`}
          hasPopup="dialog"
          expanded={open}
          onPress={() => setOpen((current) => !current)}
          style={(state) => [
            styles.destination,
            state.pressed
              ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
              : null,
            focusRingStyle({
              focused: state.focused,
              color: theme.colors.border.focus,
            }),
          ]}
        >
          <Text style={styles.destinationValue}>
            {props.names || t('workflows.page.inspector.none')}
          </Text>
          <Icon
            name="caret-right"
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
        </HappierPressable>
      </View>
      {open ? (
        <Popover
          open
          anchorRef={anchorRef}
          boundaryRef={null}
          placement="auto-vertical"
          phonePresentation="sheet"
          sheetHeader="none"
          accessibilityLabel={t('workflows.page.sections.rolesTitle')}
          edgePadding={{ horizontal: 12, vertical: 12 }}
          portal={{
            web: { target: 'body' },
            native: true,
            matchAnchorWidth: false,
          }}
          maxWidthCap={420}
          onRequestClose={() => setOpen(false)}
        >
          {({ maxHeight, maxWidth }) => (
            <FloatingOverlay
              maxHeight={maxHeight}
              surfaceChrome="theme"
              containerStyle={{ width: Math.min(maxWidth, 420) }}
            >
              <View style={styles.rolesSheet}>
                <WorkflowRolesEditorHost
                  draftStore={props.draftStore}
                  onChange={props.onChange}
                  editable={props.editable}
                  prefix={props.testID}
                />
              </View>
            </FloatingOverlay>
          )}
        </Popover>
      ) : null}
    </>
  );
}

/** Mounted only while the roles popover is open: the editor reads the whole draft it edits. */
function WorkflowRolesEditorHost(
  props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    onChange: (next: WorkflowEditorDraft) => void;
    editable: boolean;
    prefix: string;
  }>,
): React.ReactElement {
  const draft = useWorkflowEditorSelector(
    props.draftStore,
    (current) => current,
  );
  return (
    <WorkflowRolesEditor
      draft={draft}
      editable={props.editable}
      prefix={props.prefix}
      onEdit={(ops) => {
        if (!props.editable) return;
        const result = applyWorkflowDefinitionEditsV1(
          props.draftStore.get(),
          ops,
        );
        if (result.ok) props.onChange(result.draft);
      }}
    />
  );
}
