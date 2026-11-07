import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { MachineAdminAccessV1 } from '@happier-dev/protocol/machines/adminAccessV1';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import {
  SeparateUsersChangeStep,
  useSeparateUsersChange,
} from '@/components/sharing/machines/MachineSeparateUsersOffer';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { Text } from '@/components/ui/text/Text';
import { useMachineGuestExecution, type MachineAgentRunAs } from '@/hooks/machine/useMachineGuestExecution';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

import {
  adminAccessEqual,
  describeAdminPowerHeadline,
  draftAdminAccess,
  isAdministratorUsernameValid,
  isElevationPlatformUnsupported,
  type AdminAccessMode,
} from './adminPower';
import {
  useMachineAdminAccessSave,
  type MachineAdminAccessSave,
} from './useMachineAdminAccessSave';
import { useMachineAuthority } from './useMachineAuthority';

export type MachineAuthorityModel = ReturnType<typeof useMachineAuthority>;

/**
 * How agents run on this Machine, one per-Machine policy: Happier's user, the shared agent user, or a user per
 * person. `value` is the choice under review, else the Machine's policy (`null`: not changeable here); choosing
 * opens the reviewed change, whose step (review, approval, result) sits under the section.
 */
export type MachineSeparateUsersControl = Readonly<{
  value: MachineAgentRunAs | null;
  busy: boolean;
  onChoose: (next: MachineAgentRunAs) => void;
  step: React.ReactNode;
}>;

export type MachineAdminPowerControls = Readonly<{
  draftMode: AdminAccessMode | null;
  draftUsername: string;
  onDraftMode: (mode: AdminAccessMode) => void;
  onDraftUsername: (name: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  save: MachineAdminAccessSave;
  onOpenApproval: (artifactId: string) => void;
}>;

const execute = createFrontDoorActionExecute();
const s = 'machineDetailPage.security.admin' as const;

/**
 * Machine → Security → Administrator power (Plan 10/11): who holds administrator power, the saved administrator
 * access (None · Ask each time · Preauthorized) and whether agents run as a separate user. Facts come from the
 * pushed observation and metadata (`useMachineAuthority`); a change is one `machines.setup.adminAccess.set` and needs
 * Manage. Linking an administrator login (lab askSetup) has no producer: Ask names the administrator account only.
 */
export function MachineAdminPowerSection(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    online: boolean | null;
    metadataVersion: number;
    /** The machine's metadata is readable here, so a missing saved policy is the canonical default (None). */
    metadataReadable: boolean;
    /** Elevation needs Manage (10-31); a Use grantee reads the facts only. */
    canManage: boolean;
    shared: boolean;
    onOpenApproval: (artifactId: string) => void;
  }>,
) {
  const authority = useMachineAuthority({
    machineId: props.machineId,
    serverId: props.serverId,
    enabled: true,
    freshness: props.online === true ? 'current' : 'stale',
    sharedMachine: props.shared,
  });
  const { save, submit, reset } = useMachineAdminAccessSave({
    serverId: props.serverId,
    machineId: props.machineId,
  });
  const saved = readSavedAdminAccess(
    authority.desiredAdminAccess,
    props.metadataReadable,
  );
  const [draft, setDraft] = React.useState<Readonly<{
    mode: AdminAccessMode;
    username: string;
  }> | null>(null);
  // A saved or changed-elsewhere policy ends the draft; the pushed metadata is the truth from then on.
  React.useEffect(() => {
    if (save.kind === 'saved' || save.kind === 'conflict') setDraft(null);
  }, [save.kind]);
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const guest = useMachineGuestExecution({
    machineId: props.machineId,
    scope: binding?.isCurrent() ? binding.scope : null,
    execute,
    canManage: props.canManage,
  });
  // The choice under review; the Machine's own policy otherwise.
  const [draftRunAs, setDraftRunAs] = React.useState<MachineAgentRunAs | null>(null);
  const change = useSeparateUsersChange({
    machine: props.machineName,
    guestExecution: guest,
    target: draftRunAs ?? guest.runAs ?? 'member',
  });
  const reviewRef = React.useRef(change.review);
  reviewRef.current = change.review;
  React.useEffect(() => {
    if (draftRunAs !== null) void reviewRef.current();
  }, [draftRunAs]);
  // Cancel or Close returns the control to the Machine's own policy.
  const phaseKind = change.phase.kind;
  const lastPhaseKind = React.useRef(phaseKind);
  React.useEffect(() => {
    if (phaseKind === 'offer' && lastPhaseKind.current !== 'offer') setDraftRunAs(null);
    lastPhaseKind.current = phaseKind;
  }, [phaseKind]);
  const { reset: resetChange } = change;
  const controls: MachineAdminPowerControls = {
    draftMode: draft?.mode ?? null,
    draftUsername:
      draft?.username ??
      (saved?.mode === 'ask' ? saved.administratorUsername : ''),
    onDraftMode: (mode) => {
      reset();
      setDraft((prev) => ({
        mode,
        username:
          prev?.username ??
          (saved?.mode === 'ask' ? saved.administratorUsername : ''),
      }));
    },
    onDraftUsername: (username) =>
      setDraft((prev) => ({ mode: prev?.mode ?? 'ask', username })),
    onSave: () => {
      const next = draft ? draftAdminAccess(draft.mode, draft.username) : null;
      if (saved && next && !adminAccessEqual(saved, next))
        void submit(saved, next, props.metadataVersion);
    },
    onDiscard: () => {
      reset();
      setDraft(null);
    },
    save,
    onOpenApproval: props.onOpenApproval,
  };
  return (
    <MachineAdminPowerView
      authority={authority}
      saved={saved}
      machineName={props.machineName}
      online={props.online}
      canManage={props.canManage}
      controls={controls}
      separateUsers={{
        value: guest.runAs === null ? null : draftRunAs ?? guest.runAs,
        busy: phaseKind === 'previewing' || phaseKind === 'applying' || phaseKind === 'approval',
        onChoose: (next) => {
          if (next === guest.runAs) {
            resetChange();
            setDraftRunAs(null);
          } else setDraftRunAs(next);
        },
        step: (
          <SeparateUsersChangeStep
            change={change}
            machine={props.machineName}
            testID="machine-security-separate-users"
            presentation="section"
            openApproval={props.onOpenApproval}
          />
        ),
      }}
    />
  );
}

/** The canonical default applies only when the metadata is readable; otherwise the saved choice is unknown. */
export function readSavedAdminAccess(
  desired: MachineAdminAccessV1 | null,
  metadataReadable: boolean,
): MachineAdminAccessV1 | null {
  return desired ?? (metadataReadable ? { version: 1, mode: 'none' } : null);
}

export function MachineAdminPowerView(
  props: Readonly<{
    authority: MachineAuthorityModel;
    saved: MachineAdminAccessV1 | null;
    machineName: string;
    online: boolean | null;
    canManage: boolean;
    controls: MachineAdminPowerControls;
    separateUsers: MachineSeparateUsersControl | null;
  }>,
) {
  const { authority, saved, controls, separateUsers } = props;
  const machine = props.machineName;
  const headline = describeAdminPowerHeadline(authority, machine);
  const observation = authority.observation;
  const unsupported = isElevationPlatformUnsupported(observation);
  const editable =
    props.canManage &&
    props.online === true &&
    saved !== null &&
    controls.save.kind !== 'saving';
  const mode = controls.draftMode ?? saved?.mode ?? null;
  const options: SegmentedChoiceOption<AdminAccessMode>[] = [
    {
      id: 'none',
      label: t(`${s}.none`),
      description: t(`${s}.noneDescription`),
    },
    {
      id: 'ask',
      label: t(`${s}.ask`),
      description: t(`${s}.askDescription`),
      ...(unsupported
        ? { unavailableReason: t(`${s}.platformUnsupported`) }
        : {}),
    },
    {
      id: 'preauthorized',
      label: t(`${s}.preauthorized`),
      description: t(`${s}.preauthorizedDescription`),
      ...(unsupported
        ? { unavailableReason: t(`${s}.platformUnsupported`) }
        : {}),
    },
  ];
  // Both working policies named plainly, beside Happier's own user (owner ruling 2026-11-07, managed Machines).
  const runAsOptions: SegmentedChoiceOption<MachineAgentRunAs>[] = [
    { id: 'daemon', label: t(`${s}.agentsRunAsDaemon`) },
    { id: 'sharedAgent', label: t(`${s}.agentsRunAsShared`) },
    { id: 'member', label: t(`${s}.agentsRunAsMember`) },
  ];
  const next = controls.draftMode
    ? draftAdminAccess(controls.draftMode, controls.draftUsername)
    : null;
  const changed =
    controls.draftMode !== null &&
    saved !== null &&
    (next === null || !adminAccessEqual(saved, next));
  const usernameInvalid =
    mode === 'ask' &&
    controls.draftUsername !== '' &&
    !isAdministratorUsernameValid(controls.draftUsername);
  return (
    <View testID="machine-security-admin">
      <ItemGroup
        testID="machine-security-admin-group"
        title={t(`${s}.title`)}
        description={
          <Text>
            <HeadlineStatement>{headline.statement}</HeadlineStatement>
            {headline.rest ? ` ${headline.rest}` : null}
          </Text>
        }
      >
        {observation?.daemonUsername ? (
          <Item
            testID="machine-security-admin-runs-as"
            title={t(`${s}.runsAs`)}
            subtitle={
              observation.daemonIdentity === 'root'
                ? t(`${s}.runsAsRoot`)
                : undefined
            }
            showChevron={false}
            rightElement={<InlineCode>{observation.daemonUsername}</InlineCode>}
          />
        ) : null}
        {mode !== null ? (
          <SegmentedChoiceItem<AdminAccessMode>
            testID="machine-security-admin-access"
            testIDPrefix="machine-security-admin-access"
            title={t(`${s}.access`)}
            options={options}
            value={mode}
            disabled={!editable}
            onChange={controls.onDraftMode}
          />
        ) : (
          <Item
            testID="machine-security-admin-access"
            title={t(`${s}.access`)}
            subtitle={t(`${s}.accessUnknown`)}
            showChevron={false}
          />
        )}
        {mode === 'ask' ? (
          <Item
            testID="machine-security-admin-administrator"
            title={t(`${s}.administrator`)}
            subtitle={t(`${s}.administratorDisclosure`)}
            subtitleLines={0}
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={
              editable ? (
                <FieldTextInput
                  testID="machine-security-admin-administrator-input"
                  value={controls.draftUsername}
                  accessibilityLabel={t(`${s}.administrator`)}
                  placeholder={t(`${s}.administratorPlaceholder`)}
                  autoCapitalize="none"
                  autoComplete="off"
                  error={
                    usernameInvalid ? t(`${s}.administratorInvalid`) : undefined
                  }
                  onChangeText={controls.onDraftUsername}
                />
              ) : saved?.mode === 'ask' ? (
                <InlineCode>{saved.administratorUsername}</InlineCode>
              ) : undefined
            }
          />
        ) : null}
        {separateUsers?.value ? (
          <SegmentedChoiceItem<MachineAgentRunAs>
            testID="machine-security-admin-isolation"
            testIDPrefix="machine-security-agents-run-as"
            title={t(`${s}.isolationTitle`)}
            subtitle={describeIsolation(authority)}
            subtitleLines={0}
            options={runAsOptions}
            value={separateUsers.value}
            disabled={!props.canManage || props.online !== true || separateUsers.busy}
            onChange={separateUsers.onChoose}
          />
        ) : (
          <Item
            testID="machine-security-admin-isolation"
            title={t(`${s}.isolationTitle`)}
            subtitle={describeIsolation(authority)}
            subtitleLines={0}
            showChevron={false}
          />
        )}
      </ItemGroup>
      {!props.canManage ? (
        <ItemGroup surface="none">
          <SurfaceFreshnessLine
            testID="machine-security-admin-read-only"
            glyph="lock"
            reason={t(`${s}.readOnly`, { machine })}
          />
        </ItemGroup>
      ) : null}
      {props.canManage ? separateUsers?.step : null}
      <AdminAccessSaveFoot
        machineName={machine}
        controls={controls}
        changed={changed}
        canSave={next !== null && changed}
      />
    </View>
  );
}

/** The headline's statement in ink, the rest in the description's own tone (lab "Administrator power" lead). */
function HeadlineStatement(props: Readonly<{ children: React.ReactNode }>) {
  const { theme } = useUnistyles();
  return <Text emphasis="semiBold" style={{ color: theme.colors.text.primary }}>{props.children}</Text>;
}

function describeIsolation(
  authority: MachineAuthorityModel,
): string {
  const availability = authority.separateUsers.availability;
  if (availability.kind === 'unavailable') return t(availability.reason === 'metadata_unavailable'
    ? `${s}.isolationUnknown` : `${s}.isolationUnavailable`);
  if (availability.kind === 'can_turn_on'
    && (authority.isolation == null || authority.isolation.kind === 'unavailable')) return t(`${s}.isolationOff`);
  // Asked for, not observed running: the switch is on, the Machine hasn't caught up.
  if (availability.kind === 'available' && authority.isolation != null && authority.isolation.kind !== 'effective'
    && authority.isolation.kind !== 'applying') return t(`${s}.isolationPending`);
  switch (authority.isolation?.kind) {
    case 'effective':
      return t(authority.separateUsers.placement === 'member' ? `${s}.isolationMember` : `${s}.isolationEffective`);
    case 'disabled':
      return t(`${s}.isolationOff`);
    case 'enable_required':
      return t(`${s}.isolationEnableRequired`);
    case 'applying':
      return t(`${s}.isolationApplying`);
    case 'unavailable':
      return t(`${s}.isolationUnavailable`);
    default:
      return t(`${s}.isolationUnknown`);
  }
}

/** Save sits after the section's sheet; the Action's own confirmation is the review. */
function AdminAccessSaveFoot(
  props: Readonly<{
    machineName: string;
    controls: MachineAdminPowerControls;
    changed: boolean;
    canSave: boolean;
  }>,
) {
  const { save } = props.controls;
  const machine = props.machineName;
  if (
    save.kind === 'saved' ||
    save.kind === 'conflict' ||
    save.kind === 'failed'
  ) {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-security-admin-result"
          kind={
            save.kind === 'saved'
              ? 'success'
              : save.kind === 'conflict'
                ? 'warning'
                : 'error'
          }
          layout="inline"
          size="line"
          title={t(
            save.kind === 'saved'
              ? `${s}.saved`
              : save.kind === 'conflict'
                ? `${s}.conflict`
                : `${s}.failed`,
            { machine },
          )}
          diagnosticCode={save.kind === 'failed' ? save.code : null}
          secondaryAction={{
            label: t('common.close'),
            onPress: props.controls.onDiscard,
          }}
        />
      </ItemGroup>
    );
  }
  if (!props.changed && save.kind === 'idle') return null;
  return (
    <ItemGroup surface="none">
      {save.kind === 'saving' && save.approval ? (
        <ActionApprovalPendingNotice
          testID="machine-security-admin-approval"
          message={t(`${s}.approvalWaiting`)}
          onOpenApproval={() =>
            props.controls.onOpenApproval(save.approval!.artifactId)
          }
        />
      ) : null}
      <SectionButtonRow
        testID="machine-security-admin-save-row"
        footnote={t(`${s}.saveNote`)}
        footnoteTone="secondary"
      >
        <RoundButton
          testID="machine-security-admin-save"
          size="small"
          title={t(`${s}.save`)}
          disabled={!props.canSave || save.kind === 'saving'}
          loading={save.kind === 'saving' && save.approval === null}
          onPress={props.controls.onSave}
        />
        <RoundButton
          testID="machine-security-admin-discard"
          size="small"
          display="secondary"
          title={t(`${s}.discard`)}
          onPress={props.controls.onDiscard}
        />
      </SectionButtonRow>
    </ItemGroup>
  );
}
