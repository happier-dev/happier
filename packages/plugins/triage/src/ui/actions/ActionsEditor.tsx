import * as React from 'react';
import {
  Button,
  EmptyState,
  Heading,
  Row,
  Select,
  Stack,
  Status,
  Text,
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
  triageUpdateActionInputV1,
  type TriageActionEditorDraftV1,
} from './actionsCommand.js';
import {
  TRIAGE_EDITOR_DELIVERIES_V1,
  TRIAGE_EDITOR_SUBJECTS_V1,
  TRIAGE_EDITOR_TARGET_KINDS_V1,
  TRIAGE_EDITOR_WORKSPACE_MODES_V1,
  newTriageActionDraftV1,
  triageActionDraftBlockerV1,
  triageActionDraftV1,
  triagePromptInvocationEditorOptionsV1,
  withTriageAppliesToV1,
  withTriageActionTargetKindV1,
  withTriageDeliveryV1,
  withTriageProfileIdV1,
  withTriagePromptTokenV1,
} from './editorModel.js';
import type { TriageMountedActionsV1 } from './useTriageActions.js';
import { useTriageLaunchProfiles } from './useLaunchProfiles.js';
import { useTriagePromptInvocations } from './usePromptInvocations.js';

/**
 * The configured-action editor: add, remove, rename, reorder, disable and
 * configure, in one place.
 *
 * It is the whole reason `triage.actions` is a hidden Settings field rather than
 * a declared form. The declarative Settings surface has text, switch, select,
 * number and JSON controls and no repeatable record editor, so the only way to
 * present a catalog through it is raw JSON — which is not configuration, it is
 * a text file with a label. The field still has a real declared home in the
 * Account record; this is what edits it.
 *
 * It decides nothing about what an action MEANS. Which subjects exist, what a
 * workspace mode is worth and which arm an action runs are closed vocabularies
 * owned elsewhere and offered here verbatim, and every write leaves through the
 * one `triage.actions` CAS owner. The editor holds exactly one thing of its
 * own: the draft a person is typing, which is not durable state and is
 * discarded on cancel.
 */

export type TriageActionsEditorPropsV1 = Readonly<{
  actions: TriageMountedActionsV1;
  onClose?: () => void;
}>;

type EditorTarget =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'update'; actionId: string }>;

const SUBJECT_LABELS: Readonly<Record<string, Readonly<{ key: string; text: string }>>> = {
  pullRequest: { key: 'plugins.triage.surface.actions.subject.pullRequest', text: 'Pull requests' },
  issue: { key: 'plugins.triage.surface.actions.subject.issue', text: 'Issues' },
  errorIssue: { key: 'plugins.triage.surface.actions.subject.errorIssue', text: 'Error groups' },
  other: { key: 'plugins.triage.surface.actions.subject.other', text: 'Everything else' },
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
  const [target, setTarget] = React.useState<EditorTarget | null>(null);
  const [draft, setDraft] = React.useState<TriageActionEditorDraftV1 | null>(null);

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
    setTarget(null);
    setDraft(null);
  }, []);

  const submit = React.useCallback(async () => {
    if (target === null || draft === null || actions.revision === null) return;
    const applied = await actions.administer(
      target.kind === 'create'
        ? triageCreateActionInputV1(draft, actions.revision)
        : triageUpdateActionInputV1(target.actionId, draft, actions.revision),
    );
    // The draft survives a refusal: throwing away what somebody typed because
    // another device won the revision race is the one thing this editor must
    // never do.
    if (applied !== null) close();
  }, [actions, close, draft, target]);

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

  return (
    <Stack gap="small">
      <Row gap="small" align="center">
        <Heading
          level={2}
          valueKey="plugins.triage.surface.actions.title"
          value="Actions"
        />
        <Button
          titleKey="plugins.triage.surface.actions.add"
          title="Add an action"
          variant="primary"
          disabled={busy}
          onPress={() => {
            setTarget({ kind: 'create' });
            setDraft(newTriageActionDraftV1());
          }}
        />
        {props.onClose === undefined ? null : (
          <Button
            titleKey="plugins.triage.surface.actions.close"
            title="Done"
            variant="secondary"
            onPress={props.onClose}
          />
        )}
      </Row>

      {actions.unavailableReason === null ? null : (
        <Status tone="warning" label={actions.unavailableReason} />
      )}
      {actions.notice === null ? null : (
        <Status
          tone={actions.notice.tone}
          label={actions.notice.message}
        />
      )}
      {actions.read.kind === 'unreadable' ? (
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.actions.unreadable"
          label="These actions were written by a newer version of Happier, so they were left untouched."
        />
      ) : null}

      {actions.actions.length === 0 ? (
        <EmptyState
          titleKey="plugins.triage.surface.actions.empty.title"
          title="No actions"
          descriptionKey="plugins.triage.surface.actions.empty.description"
          description="Nothing can be started from an entry until you add an action here."
        />
      ) : (
        <Stack gap="small">
          {actions.actions.map((action, index) => (
            <TriageActionRow
              key={action.actionId}
              action={action}
              busy={busy}
              first={index === 0}
              last={index === actions.actions.length - 1}
              onEdit={() => {
                setTarget({ kind: 'update', actionId: action.actionId });
                setDraft(triageActionDraftV1(action));
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
        </Stack>
      )}

      {draft === null || target === null ? null : (
        <Stack gap="small">
          <Heading
            level={3}
            valueKey={target.kind === 'create'
              ? 'plugins.triage.surface.actions.form.create'
              : 'plugins.triage.surface.actions.form.update'}
            value={target.kind === 'create' ? 'New action' : 'Edit action'}
          />
          <TextField
            labelKey="plugins.triage.surface.actions.field.label"
            label="Name"
            value={draft.label}
            onChange={(label) => { setDraft({ ...draft, label }); }}
          />
          <Toggle
            label={translate('plugins.triage.surface.actions.field.enabled', 'Offer this action')}
            value={draft.enabled}
            onChange={(enabled) => { setDraft({ ...draft, enabled }); }}
          />
          <Select
            label={translate('plugins.triage.surface.actions.field.appliesTo', 'Offer it on')}
            multiple
            options={options(TRIAGE_EDITOR_SUBJECTS_V1, SUBJECT_LABELS, translate)}
            value={[...draft.appliesTo]}
            onChange={(value) => { setDraft(withTriageAppliesToV1(draft, stringList(value))); }}
          />
          <Select
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
          <Select
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
          <Select
            label={translate(
              'plugins.triage.surface.actions.field.profileId',
              'Launch profile',
            )}
            options={profileOptions}
            value={draft.profileId ?? ''}
            onChange={(value) => {
              setDraft(withTriageProfileIdV1(draft, firstString(value) ?? ''));
            }}
          />
          {profiles.coverage === 'complete' || profiles.pending ? null : (
            <TextField
              labelKey="plugins.triage.surface.actions.field.profileIdRaw"
              label="Launch profile id (your profiles could not be listed)"
              value={draft.profileId ?? ''}
              onChange={(profileId) => {
                setDraft(withTriageProfileIdV1(draft, profileId));
              }}
            />
          )}
          {/*
            * The prompt is offered on BOTH arms, because both answer the same
            * question: an agent action sends it, and `review.start` takes it as
            * its required `instructions`. It is a PICKER rather than a text
            * field because the record stores the Library's stable id, which
            * nobody can type — a field here would make a correct reference
            * unwritable and leave the member configured-looking and inert.
            */}
          <Select
            label={translate('plugins.triage.surface.actions.field.prompt', 'Prompt')}
            options={promptOptions}
            value={draft.target.promptInvocationId ?? ''}
            onChange={(value) => {
              setDraft(withTriagePromptTokenV1(draft, firstString(value) ?? ''));
            }}
          />
          {draft.target.kind !== 'agent' ? null : (
            <Stack gap="small">
              <Select
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
            </Stack>
          )}
          {blocker === null ? null : (
            <Status
              tone="muted"
              labelKey={blocker === 'label'
                ? 'plugins.triage.surface.actions.blocker.label'
                : 'plugins.triage.surface.actions.blocker.appliesTo'}
              label={blocker === 'label'
                ? 'Give this action a name.'
                : 'Choose at least one kind of entry to offer it on.'}
            />
          )}
          <Row gap="small" align="center">
            <Button
              titleKey="plugins.triage.surface.actions.save"
              title="Save"
              variant="primary"
              disabled={busy || blocker !== null}
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
  );
}

type TriageActionRowProps = Readonly<{
  action: TriageActionV1;
  busy: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (direction: 'up' | 'down') => void;
}>;

function TriageActionRow(props: TriageActionRowProps): React.ReactElement {
  const { action, busy } = props;
  // The same resolution the pressed control uses: a still-shipped label
  // translates and a renamed one shows the person's own words, so the editor
  // and the control can never disagree about what an action is called.
  const titleKey = readTriageActionTitleKeyV1(action);
  return (
    <Row gap="small" align="center">
      <Text {...(titleKey === null ? {} : { valueKey: titleKey })} value={action.label} />
      {action.enabled ? null : (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.actions.disabled"
          label="Not offered"
        />
      )}
      <Button
        titleKey="plugins.triage.surface.actions.moveUp"
        title="Move up"
        variant="secondary"
        disabled={busy || props.first}
        onPress={() => { props.onMove('up'); }}
      />
      <Button
        titleKey="plugins.triage.surface.actions.moveDown"
        title="Move down"
        variant="secondary"
        disabled={busy || props.last}
        onPress={() => { props.onMove('down'); }}
      />
      <Button
        titleKey="plugins.triage.surface.actions.edit"
        title="Configure"
        variant="secondary"
        disabled={busy}
        onPress={props.onEdit}
      />
      <Button
        titleKey="plugins.triage.surface.actions.remove"
        title="Remove"
        variant="secondary"
        disabled={busy}
        onPress={props.onDelete}
      />
    </Row>
  );
}
