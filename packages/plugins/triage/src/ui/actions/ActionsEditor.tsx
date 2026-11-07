import * as React from 'react';
import {
  Button,
  EmptyState,
  Item,
  ItemGroup,
  Row,
  ScrollArea,
  Select,
  Spinner,
  Stack,
  Status,
  TextField,
  Toggle,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import { readTriageActionTitleKeyV1, type TriageActionV1 } from '../../settings/actions.js';
import {
  triageCreateActionInputV1,
  triageDeleteActionInputV1,
  triageMovedActionOrderV1,
  triageReorderActionsInputV1,
  triageResetActionsInputV1,
  triageUpdateActionInputV1,
  type TriageActionEditorDraftV1,
} from './actionsCommand.js';
import {
  TRIAGE_EDITOR_DELIVERIES_V1,
  TRIAGE_EDITOR_SUBJECTS_V1,
  TRIAGE_EDITOR_TARGET_KINDS_V1,
  TRIAGE_EDITOR_WORKSPACE_MODES_V1,
  isTriageActionDraftRevisionStaleV1,
  newTriageActionDraftV1,
  triageActionDraftBlockerV1,
  triageActionDraftV1,
  triagePromptInvocationEditorOptionsV1,
  withTriageAppliesToV1,
  withTriageActionTargetKindV1,
  withTriageDeliveryV1,
  withTriageProfileIdV1,
  withTriagePromptArgsTextV1,
  withTriagePromptTokenV1,
} from './editorModel.js';
import type { TriageMountedActionsV1 } from './useTriageActions.js';
import { useTriageLaunchProfiles } from './useLaunchProfiles.js';
import { useTriagePromptInvocations } from './usePromptInvocations.js';

/**
 * The configured-action editor: add, remove, rename, reorder, disable and
 * configure, in one place.
 *
 * The declarative Settings surface is not a repeatable record editor, so this
 * purpose-built editor writes the one `triage.actions` Account KV catalog.
 *
 * It decides nothing about what an action MEANS. Which subjects exist, what a
 * workspace mode is worth and which arm an action runs are closed vocabularies
 * owned elsewhere and offered here verbatim, and every write leaves through the
 * one `triage.actions` CAS owner. The editor holds exactly one thing of its
 * own: the draft a person is typing, which is not durable state and is
 * discarded on cancel.
 */

/**
 * The editor's own scrolling region, as automation identity.
 *
 * Exported because the fact a mounted test has to be able to reach is exactly
 * this box: the form and its **Save** control are inside a scroll owner of the
 * editor's own, rather than clipped by the shell's work region with no way to
 * reach the end of what a person is filling in.
 */
export const TRIAGE_ACTIONS_EDITOR_SCROLL_TEST_ID_V1 = 'triage-actions-editor-scroll';

/**
 * How the editor takes its share of the shell's clipped work region.
 *
 * `flexShrink: 1` with `minHeight: 0` is the whole mechanism: without it a
 * column child keeps its natural content height, so a long draft simply grows
 * past the region the shell clips and takes **Save** with it. Shrinking instead
 * gives the editor a bounded box, and the scroll owner below reaches the rest.
 * It claims no fixed height and no share of its own — the list keeps its
 * `flex: 1` — so an editor that fits still renders exactly as it did.
 */
const TRIAGE_ACTIONS_EDITOR_SCROLL_STYLE_V1 = Object.freeze({ flexShrink: 1, minHeight: 0 });

export type TriageActionsEditorPropsV1 = Readonly<{
  actions: TriageMountedActionsV1;
  /** Opens straight on this action's form, as its row's Edit would, once the catalog has read it. */
  initialActionId?: string;
  onClose?: () => void;
}>;

type EditorTarget =
  | Readonly<{ kind: 'create'; baseRevision: string }>
  | Readonly<{ kind: 'update'; actionId: string; baseRevision: string }>;

const SUBJECT_LABELS: Readonly<Record<string, Readonly<{ key: string; text: string }>>> = {
  pullRequest: { key: 'plugins.triage.surface.actions.subject.pullRequest', text: 'Pull requests' },
  issue: { key: 'plugins.triage.surface.actions.subject.issue', text: 'Issues' },
  errorIssue: { key: 'plugins.triage.surface.actions.subject.errorIssue', text: 'Error groups' },
  other: { key: 'plugins.triage.surface.actions.subject.other', text: 'Everything else' },
  deploymentReceipt: { key: 'plugins.triage.surface.actions.subject.deploymentReceipt', text: 'Deploys' },
  deploymentEnvironment: { key: 'plugins.triage.surface.actions.subject.deploymentEnvironment', text: 'Environments' },
};

const WORKSPACE_LABELS: Readonly<Record<string, Readonly<{ key: string; text: string }>>> = {
  reference_only: {
    key: 'plugins.triage.surface.actions.workspace.referenceOnly',
    text: 'No working copy',
  },
  repository: {
    key: 'plugins.triage.surface.actions.workspace.repository',
    text: 'The project I pick',
  },
  pull_request: {
    key: 'plugins.triage.surface.actions.workspace.pullRequest',
    text: 'A prepared review worktree',
  },
};

const DELIVERY_LABELS: Readonly<Record<string, Readonly<{ key: string; text: string }>>> = {
  compose: { key: 'plugins.triage.surface.actions.delivery.compose', text: 'Wait in the composer' },
  send: { key: 'plugins.triage.surface.actions.delivery.send', text: 'Send it straight away' },
};

const TARGET_LABELS: Readonly<Record<string, Readonly<{ key: string; text: string }>>> = {
  agent: { key: 'plugins.triage.surface.actions.arm.agent', text: 'Start a session with an agent' },
  reviewStart: { key: 'plugins.triage.surface.actions.arm.reviewStart', text: 'Run a code review' },
};

function options(
  values: readonly string[],
  labels: Readonly<Record<string, Readonly<{ key: string; text: string }>>>,
  translate: (key: string, fallback?: string) => string,
): readonly Readonly<{ value: string; label: string }>[] {
  return values.map((value) => {
    const label = labels[value];
    return {
      value,
      label: label === undefined ? value : translate(label.key, label.text),
    };
  });
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }
  return null;
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((member): member is string => typeof member === 'string') : [];
}

export function TriageActionsEditor(props: TriageActionsEditorPropsV1): React.ReactElement {
  const { actions } = props;
  const translate = usePluginTranslation();
  const invocations = useTriagePromptInvocations();
  const profiles = useTriageLaunchProfiles();
  const [editor, setEditor] = React.useState<Readonly<{
    target: EditorTarget;
    draft: TriageActionEditorDraftV1;
  }> | null>(null);
  // The requested action opens once, when the catalog first holds it; closing its form leaves the list.
  const initialActionId = React.useRef(props.initialActionId);
  React.useEffect(() => {
    const actionId = initialActionId.current;
    if (actionId === undefined || actions.revision === null) return;
    const action = actions.actions.find((candidate) => candidate.actionId === actionId);
    if (action === undefined) return;
    initialActionId.current = undefined;
    setEditor({ target: { kind: 'update', actionId, baseRevision: actions.revision }, draft: triageActionDraftV1(action) });
  }, [actions.actions, actions.revision]);
  const target = editor?.target ?? null;
  const draft = editor?.draft ?? null;
  const setDraft = React.useCallback((next: TriageActionEditorDraftV1) => {
    setEditor((current) => current === null ? null : { ...current, draft: next });
  }, []);

  /**
   * The Library's invocations, plus the two entries a list of them cannot
   * supply: "no prompt", which is a real configuration, and the id this action
   * already holds when the Library no longer offers it. Dropping the second
   * would silently repoint a person's action at nothing the moment they opened
   * the editor.
   */
  const held = draft?.target.promptInvocationId ?? null;
  const promptOptions = React.useMemo(() => triagePromptInvocationEditorOptionsV1({
    heldInvocationId: held,
    invocations: invocations.invocations,
    coverage: invocations.coverage,
    noPromptLabel: translate('plugins.triage.surface.actions.field.promptNone', 'No prompt'),
    missingPromptLabel: translate(
      'plugins.triage.surface.actions.field.promptMissing',
      'Prompt no longer in your library',
    ),
  }), [held, invocations, translate]);
  const promptAllowsArgs = held !== null && (
    invocations.invocations.find((invocation) => invocation.id === held)?.allowArgs === true
    || draft?.target.promptArgsText !== undefined
  );

  /**
   * The Account's profiles, plus the two entries a list of them cannot supply:
   * "no profile", which is a real configuration meaning the generic new-Session
   * flow chooses, and the id this action already holds when the catalog no
   * longer offers it.
   *
   * The second is the one that matters. A configured profile that has been
   * deleted, or that a briefly unreachable catalog did not return, stays
   * VISIBLE and named as missing — so opening the editor to rename an action
   * cannot silently repoint it at nothing, and repairing or clearing it is an
   * explicit choice the person makes.
   */
  const heldProfileId = draft?.profileId ?? null;
  const profileOptions = React.useMemo(() => {
    const rows = profiles.profiles.map((profile) => ({ value: profile.id, label: profile.name }));
    const missing = heldProfileId !== null && !rows.some((row) => row.value === heldProfileId)
      ? [{
        value: heldProfileId,
        // Only an authoritative list may say a profile is GONE. A list that
        // did not answer, or answered in part, says what it actually knows —
        // that it is still holding this id and could not check it.
        label: profiles.coverage === 'complete'
          ? translate(
            'plugins.triage.surface.actions.field.profileMissing',
            'Profile no longer in your account',
          )
          : translate(
            'plugins.triage.surface.actions.field.profileUnchecked',
            'Keeping the profile you configured',
          ),
      }]
      : [];
    return [
      {
        value: '',
        label: translate(
          'plugins.triage.surface.actions.field.profileNone',
          'Choose at start',
        ),
      },
      ...rows,
      ...missing,
    ];
  }, [heldProfileId, profiles, translate]);

  const close = React.useCallback(() => {
    setEditor(null);
  }, []);

  const submit = React.useCallback(async () => {
    if (editor === null) return;
    const { target, draft } = editor;
    const applied = await actions.administer(
      target.kind === 'create'
        ? triageCreateActionInputV1(draft, target.baseRevision)
        : triageUpdateActionInputV1(target.actionId, draft, target.baseRevision),
    );
    // The draft survives a refusal: throwing away what somebody typed because
    // another device won the revision race is the one thing this editor must
    // never do.
    if (applied === null) return;
    setEditor((current) => {
      // Retire only the submitted draft. A newer edit or Cancel is a newer
      // intent, as in the Views naming owner.
      if (current === editor) return null;
      if (current === null || current.target !== target || applied.revision === null) return current;
      // Keep newer input usable against the revision this write actually
      // acknowledged, rather than its now-spent base revision.
      return { ...current, target: { ...current.target, baseRevision: applied.revision } };
    });
  }, [actions, editor]);

  const move = React.useCallback(async (actionId: string, direction: 'up' | 'down') => {
    const order = triageMovedActionOrderV1(actions.actions, actionId, direction);
    if (order === null || actions.revision === null) return;
    await actions.administer(triageReorderActionsInputV1(order, actions.revision));
  }, [actions]);

  /**
   * Nothing is writable until the Account's own catalog has been read.
   *
   * Before the first read this editor is showing the shipped seed, which is
   * what ABSENCE means rather than what the Account holds. A write formed
   * against it would name a revision this mount never saw, so the controls stay
   * disabled for the moment it takes to answer instead of offering a save that
   * could only be refused.
   */
  const busy = actions.busy || actions.unavailableReason !== null || actions.revision === null;
  const blocker = draft === null ? null : triageActionDraftBlockerV1(draft);
  const restoreTitle = translate('plugins.triage.surface.actions.restore', 'Restore defaults');
  const restoreDescription = translate(
    'plugins.triage.surface.actions.restoreDescription',
    'Brings back the built-in actions as they shipped and removes the ones you added.',
  );
  const draftRevisionStale = target === null
    ? false
    : isTriageActionDraftRevisionStaleV1(target.baseRevision, actions.revision);

  return (
    /*
     * One scroll owner, and it is the editor's own.
     *
     * The shell's work region is clipped (`ui/shell/root.tsx`), so everything
     * below the fold of a long draft — including the control that commits it —
     * was unreachable at short viewports, at large type sizes, and with a
     * larger action catalog above the form. Wrapping the region the editor
     * SHARES with the list would have been the other way to reach it, and it is
     * the wrong one: the list is virtualized and owns the only scroller its
     * reveal, measurement and keyboard paging can work through.
     */
    <ScrollArea
      testID={TRIAGE_ACTIONS_EDITOR_SCROLL_TEST_ID_V1}
      style={TRIAGE_ACTIONS_EDITOR_SCROLL_STYLE_V1}
    >
    <Stack gap="small">
      <ItemGroup
        title={translate('plugins.triage.surface.actions.title', 'Actions')}
        description={translate(
          'plugins.triage.surface.actions.description',
          'What you can start from an entry. Turn one off to stop offering it.',
        )}
        action={(
          <Row gap="small" align="center">
            <Button
              titleKey="plugins.triage.surface.actions.add"
              title="Add an action"
              variant="primary"
              disabled={busy}
              onPress={() => {
                if (actions.revision === null) return;
                setEditor({
                  target: { kind: 'create', baseRevision: actions.revision },
                  draft: newTriageActionDraftV1(),
                });
              }}
            />
            {props.onClose === undefined ? null : (
              <Button
                titleKey="plugins.triage.surface.actions.close"
                title="Done"
                variant="plain"
                onPress={props.onClose}
              />
            )}
          </Row>
        )}
      >
        {actions.unavailableReason !== null ? (
          <Item
            title={actions.unavailableReason}
            accessory={(
              <Button
                titleKey="plugins.triage.surface.actions.retry"
                title="Retry"
                variant="secondary"
                onPress={actions.retry}
              />
            )}
            accessoryOutsidePressable
            accessoryWraps
          />
        ) : !actions.loaded ? (
          <Item
            title={translate('plugins.triage.surface.actions.loading', 'Loading actions…')}
            accessory={<Spinner size="small" accessibilityLabel={translate('plugins.triage.surface.actions.loading', 'Loading actions…')} />}
          />
        ) : actions.read.kind === 'unreadable' ? (
          <Item
            title={translate(
              'plugins.triage.surface.actions.unreadable',
              'These actions were written by a newer version of Happier, so they were left untouched.',
            )}
          />
        ) : (
          <>
            {actions.actions.map((action, index) => (
              <TriageActionRow
                key={action.actionId}
                action={action}
                busy={busy}
                first={index === 0}
                last={index === actions.actions.length - 1}
                onEdit={() => {
                  if (actions.revision === null) return;
                  setEditor({
                    target: {
                      kind: 'update',
                      actionId: action.actionId,
                      baseRevision: actions.revision,
                    },
                    draft: triageActionDraftV1(action),
                  });
                }}
                onToggle={(enabled) => {
                  if (actions.revision === null) return;
                  void actions.administer(triageUpdateActionInputV1(
                    action.actionId,
                    { ...triageActionDraftV1(action), enabled },
                    actions.revision,
                  ));
                }}
                onDelete={() => {
                  if (actions.revision === null) return;
                  void actions.administer(
                    triageDeleteActionInputV1(action.actionId, actions.revision),
                  );
                }}
                onMove={(direction) => { void move(action.actionId, direction); }}
              />
            ))}
            {actions.actions.length === 0 ? (
              <EmptyState
                titleKey="plugins.triage.surface.actions.empty.title"
                title="No actions"
                descriptionKey="plugins.triage.surface.actions.empty.description"
                description="Nothing can be started from an entry until you add an action here."
              />
            ) : null}
            <Item
              title={restoreTitle}
              subtitle={restoreDescription}
              accessoryOutsidePressable
              accessoryWraps
              accessory={(
                <Button
                  titleKey="plugins.triage.surface.actions.restoreAction"
                  title="Restore"
                  variant="secondary"
                  disabled={busy || actions.read.kind === 'absent'}
                  onPress={() => {
                    if (actions.revision === null) return;
                    void actions.administer(triageResetActionsInputV1(actions.revision));
                  }}
                />
              )}
            />
          </>
        )}
      </ItemGroup>

      {actions.notice === null ? null : (
        <Status
          tone={actions.notice.tone}
          label={actions.notice.message}
        />
      )}

      {draft === null || target === null ? null : (
        <Stack gap="small">
          <ItemGroup
            title={target.kind === 'create'
              ? translate('plugins.triage.surface.actions.form.create', 'New action')
              : translate('plugins.triage.surface.actions.form.update', 'Edit action')}
          >
            <FieldRow title={translate('plugins.triage.surface.actions.field.label', 'Name')}>
              <TextField
                labelKey="plugins.triage.surface.actions.field.label"
                label="Name"
                value={draft.label}
                onChange={(label) => { setDraft({ ...draft, label }); }}
              />
            </FieldRow>
            <Item
              title={translate('plugins.triage.surface.actions.field.enabled', 'Offer this action')}
              accessoryOutsidePressable
              accessory={(
                <Toggle
                  label={translate('plugins.triage.surface.actions.field.enabled', 'Offer this action')}
                  value={draft.enabled}
                  onChange={(enabled) => { setDraft({ ...draft, enabled }); }}
                />
              )}
            />
            <FieldRow title={translate('plugins.triage.surface.actions.field.appliesTo', 'Offer it on')}>
              <Select
                presentation="field"
                label={translate('plugins.triage.surface.actions.field.appliesTo', 'Offer it on')}
                multiple
                options={options(TRIAGE_EDITOR_SUBJECTS_V1, SUBJECT_LABELS, translate)}
                value={[...draft.appliesTo]}
                onChange={(value) => { setDraft(withTriageAppliesToV1(draft, stringList(value))); }}
              />
            </FieldRow>
            <FieldRow title={translate('plugins.triage.surface.actions.field.workspaceMode', 'It needs')}>
              <Select
                presentation="field"
                label={translate('plugins.triage.surface.actions.field.workspaceMode', 'It needs')}
                options={options(TRIAGE_EDITOR_WORKSPACE_MODES_V1, WORKSPACE_LABELS, translate)}
                value={draft.workspaceMode}
                onChange={(value) => {
                  const mode = firstString(value);
                  if (mode === null) return;
                  const admitted = TRIAGE_EDITOR_WORKSPACE_MODES_V1
                    .find((candidate) => candidate === mode);
                  if (admitted === undefined) return;
                  setDraft({ ...draft, workspaceMode: admitted });
                }}
              />
            </FieldRow>
            <FieldRow title={translate('plugins.triage.surface.actions.field.arm', 'Pressing it')}>
              <Select
                presentation="field"
                label={translate('plugins.triage.surface.actions.field.arm', 'Pressing it')}
                options={options(TRIAGE_EDITOR_TARGET_KINDS_V1, TARGET_LABELS, translate)}
                value={draft.target.kind}
                onChange={(value) => {
                  const kind = firstString(value);
                  const admitted = TRIAGE_EDITOR_TARGET_KINDS_V1
                    .find((candidate) => candidate === kind);
                  if (admitted === undefined) return;
                  setDraft(withTriageActionTargetKindV1(draft, admitted));
                }}
              />
            </FieldRow>
            {/*
              * A PICKER first, because the record stores `LaunchProfileV2.id` —
              * an opaque stable identity nobody can type — so asking a person to
              * type one makes the member unwritable in practice.
              *
              * And a field BESIDE it whenever the picker cannot be authoritative.
              * The picker is only an authoring path while the catalog answers;
              * when it does not, a picker alone is no path at all, and this
              * member was left unwritable through every surface. The field is the
              * fallback, never the primary way in.
              */}
            <FieldRow title={translate('plugins.triage.surface.actions.field.profileId', 'Launch profile')}>
              <Select
                presentation="field"
                label={translate('plugins.triage.surface.actions.field.profileId', 'Launch profile')}
                options={profileOptions}
                value={draft.profileId ?? ''}
                onChange={(value) => {
                  setDraft(withTriageProfileIdV1(draft, firstString(value) ?? ''));
                }}
              />
            </FieldRow>
            {profiles.coverage === 'complete' || profiles.pending ? null : (
              <FieldRow title={translate(
                'plugins.triage.surface.actions.field.profileIdRaw',
                'Launch profile id (your profiles could not be listed)',
              )}>
                <TextField
                  labelKey="plugins.triage.surface.actions.field.profileIdRaw"
                  label="Launch profile id (your profiles could not be listed)"
                  value={draft.profileId ?? ''}
                  onChange={(profileId) => {
                    setDraft(withTriageProfileIdV1(draft, profileId));
                  }}
                />
              </FieldRow>
            )}
            {/*
              * The prompt is offered on BOTH arms, because both answer the same
              * question: an agent action sends it, and `review.start` takes it as
              * its required `instructions`. It is a PICKER rather than a text
              * field because the record stores the Library's stable id, which
              * nobody can type — a field here would make a correct reference
              * unwritable and leave the member configured-looking and inert.
              */}
            <FieldRow title={translate('plugins.triage.surface.actions.field.prompt', 'Prompt')}>
              <Select
                presentation="field"
                label={translate('plugins.triage.surface.actions.field.prompt', 'Prompt')}
                options={promptOptions}
                value={draft.target.promptInvocationId ?? ''}
                onChange={(value) => {
                  setDraft(withTriagePromptTokenV1(draft, firstString(value) ?? ''));
                }}
              />
            </FieldRow>
            {!promptAllowsArgs || draft.target.promptInvocationId === null ? null : (
              <FieldRow title={translate('plugins.triage.surface.actions.field.promptArgs', 'Prompt arguments')}>
                <TextField
                  labelKey="plugins.triage.surface.actions.field.promptArgs"
                  label="Prompt arguments"
                  value={draft.target.promptArgsText ?? ''}
                  onChange={(promptArgsText) => {
                    setDraft(withTriagePromptArgsTextV1(draft, promptArgsText));
                  }}
                />
              </FieldRow>
            )}
            {draft.target.kind !== 'agent' ? null : (
              <FieldRow title={translate('plugins.triage.surface.actions.field.delivery', 'Then')}>
                <Select
                  presentation="field"
                  label={translate('plugins.triage.surface.actions.field.delivery', 'Then')}
                  options={options(TRIAGE_EDITOR_DELIVERIES_V1, DELIVERY_LABELS, translate)}
                  value={draft.target.delivery}
                  onChange={(value) => {
                    const delivery = firstString(value);
                    const admitted = TRIAGE_EDITOR_DELIVERIES_V1
                      .find((candidate) => candidate === delivery);
                    if (admitted === undefined) return;
                    setDraft(withTriageDeliveryV1(draft, admitted));
                  }}
                />
              </FieldRow>
            )}
          </ItemGroup>
          {blocker === null ? null : (
            <Status
              tone="muted"
              labelKey={blocker === 'label'
                ? 'plugins.triage.surface.actions.blocker.label'
                : blocker === 'appliesTo'
                  ? 'plugins.triage.surface.actions.blocker.appliesTo'
                  : 'plugins.triage.surface.actions.blocker.instruction'}
              label={blocker === 'label'
                ? 'Give this action a name.'
                : blocker === 'appliesTo'
                  ? 'Choose at least one kind of entry to offer it on.'
                  : 'Choose a Prompt Library entry before this action can start work.'}
            />
          )}
          {!draftRevisionStale ? null : (
            <Row gap="small" align="center">
              <Status
                tone="warning"
                labelKey="plugins.triage.surface.actions.draftStale"
                label="Actions changed while this draft was open. Reload or reapply it before saving."
              />
              <Button
                titleKey={target.kind === 'update'
                  ? 'plugins.triage.surface.actions.reload'
                  : 'plugins.triage.surface.actions.reapply'}
                title={target.kind === 'update'
                  ? translate('plugins.triage.surface.actions.reload', 'Reload action')
                  : translate('plugins.triage.surface.actions.reapply', 'Reapply draft')}
                variant="secondary"
                disabled={actions.revision === null}
                onPress={() => {
                  const currentRevision = actions.revision;
                  if (currentRevision === null) return;
                  if (target.kind === 'create') {
                    setEditor({ target: { kind: 'create', baseRevision: currentRevision }, draft });
                    return;
                  }
                  const current = actions.actions.find(
                    (action) => action.actionId === target.actionId,
                  );
                  if (current === undefined) {
                    close();
                    return;
                  }
                  setEditor({
                    target: {
                      kind: 'update',
                      actionId: target.actionId,
                      baseRevision: currentRevision,
                    },
                    draft: triageActionDraftV1(current),
                  });
                }}
              />
            </Row>
          )}
          <Row gap="small" align="center">
            <Button
              titleKey="plugins.triage.surface.actions.save"
              title="Save"
              variant="primary"
              disabled={busy || blocker !== null || draftRevisionStale}
              onPress={() => { void submit(); }}
            />
            <Button
              titleKey="plugins.triage.surface.actions.cancel"
              title="Cancel"
              variant="secondary"
              onPress={close}
            />
          </Row>
        </Stack>
      )}
    </Stack>
    </ScrollArea>
  );
}

/** One labelled field of the editor: the row names it, the field sits at its trailing edge (beneath on phones). */
function FieldRow(props: Readonly<{ title: string; children: React.ReactNode }>): React.ReactElement {
  return (
    <Item
      title={props.title}
      fieldAccessory
      accessoryOutsidePressable
      accessory={props.children}
    />
  );
}

type TriageActionRowProps = Readonly<{
  action: TriageActionV1;
  busy: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onMove: (direction: 'up' | 'down') => void;
}>;

/**
 * One action, one decision: whether it is offered. The row says what pressing it does and where it
 * shows up; opening the row configures it, and the rarer moves live in its menu.
 */
function TriageActionRow(props: TriageActionRowProps): React.ReactElement {
  const { action, busy } = props;
  const translate = usePluginTranslation();
  // The same resolution the pressed control uses: a still-shipped label
  // translates and a renamed one shows the person's own words, so the editor
  // and the control can never disagree about what an action is called.
  const titleKey = readTriageActionTitleKeyV1(action);
  const title = titleKey === null ? action.label : translate(titleKey, action.label);
  const arm = TARGET_LABELS[action.target.kind];
  const subtitle = [
    arm === undefined ? action.target.kind : translate(arm.key, arm.text),
    action.appliesTo
      .map((subject) => {
        const label = SUBJECT_LABELS[subject];
        return label === undefined ? subject : translate(label.key, label.text);
      })
      .join(', '),
  ].join(' · ');
  return (
    <Item
      title={title}
      subtitle={subtitle}
      onPress={props.onEdit}
      disabled={busy}
      accessory={(
        <Toggle
          label={title}
          value={action.enabled}
          disabled={busy}
          onChange={props.onToggle}
        />
      )}
      accessoryOutsidePressable
      secondaryActions={[
        {
          id: 'up',
          label: translate('plugins.triage.surface.actions.moveUp', 'Move up'),
          disabled: busy || props.first,
        },
        {
          id: 'down',
          label: translate('plugins.triage.surface.actions.moveDown', 'Move down'),
          disabled: busy || props.last,
        },
        {
          id: 'remove',
          label: translate('plugins.triage.surface.actions.remove', 'Remove'),
          destructive: true,
          disabled: busy,
        },
      ]}
      secondaryActionAccessibilityLabel={translate(
        'plugins.triage.surface.row.moreActions',
        'More actions for {title}',
        { title },
      )}
      onSecondaryAction={(id) => {
        if (id === 'up' || id === 'down') props.onMove(id);
        else if (id === 'remove') props.onDelete();
      }}
    />
  );
}
