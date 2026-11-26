import type { MachineAuthorityPresentationV1 } from '@happier-dev/protocol';
import {
  MachineAdministratorUsernameV1Schema,
  type MachineAdminAccessObservationV1,
  type MachineAdminAccessV1,
  type MachinePreauthorizationIssueV1,
} from '@happier-dev/protocol/machines/adminAccessV1';

import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

export type AdminAccessMode = MachineAdminAccessV1['mode'];

/** The section's lead: a statement (who holds administrator power and how) and a quieter rest. */
export type AdminPowerHeadline = Readonly<{
  statement: string;
  rest: string | null;
  attention: boolean;
}>;

/**
 * UX-1 headline from observed facts only. Standing power (root, a root-equivalent group, passwordless sudo) leads;
 * the saved choice only speaks when nothing stands. "Agents can't" is said only when isolation is in effect.
 */
export function describeAdminPowerHeadline(
  authority: Pick<
    MachineAuthorityPresentationV1,
    | 'hostAuthority'
    | 'agentHostAuthority'
    | 'powerSources'
    | 'rootEquivalentGroups'
    | 'desiredAdminAccess'
  >,
  machine: string,
): AdminPowerHeadline {
  const s = 'machineDetailPage.security.admin' as const;
  const desired = authority.desiredAdminAccess?.mode ?? null;
  const agents =
    authority.agentHostAuthority === 'ordinary'
      ? t(`${s}.agentsCant`)
      : authority.agentHostAuthority === 'administrator'
        ? t(`${s}.agentsToo`)
        : null;
  const join = (...parts: (string | null)[]) =>
    parts.filter(Boolean).join(' ') || null;
  if (authority.hostAuthority === 'unknown') {
    return {
      statement: t(`${s}.headlineUnknown`, { machine }),
      rest: null,
      attention: false,
    };
  }
  if (authority.hostAuthority === 'administrator') {
    const sources = authority.powerSources;
    const statement = sources.includes('rootUid')
      ? t(`${s}.headlineRoot`, { machine })
      : sources.includes('rootEquivalentGroup') &&
          authority.rootEquivalentGroups?.length
        ? t(`${s}.headlineGroup`, {
            machine,
            groups: joinList(authority.rootEquivalentGroups),
          })
        : t(`${s}.headlinePasswordless`, { machine });
    const sudoAsks =
      desired === 'ask' &&
      !sources.includes('passwordlessRoot') &&
      !sources.includes('rootUid')
        ? t(`${s}.sudoStillAsks`)
        : null;
    return {
      statement,
      rest: join(sudoAsks, agents),
      attention: authority.agentHostAuthority === 'administrator',
    };
  }
  const statement =
    desired === 'ask'
      ? t(`${s}.headlineAsk`, { machine })
      : desired === 'preauthorized'
        ? t(`${s}.headlinePreNotInEffect`, { machine })
        : t(`${s}.headlineNone`, { machine });
  return { statement, rest: agents, attention: desired === 'preauthorized' };
}

export function isAdministratorUsernameValid(name: string): boolean {
  return MachineAdministratorUsernameV1Schema.safeParse(name).success;
}

/** The draft as a policy, or null while Ask has no valid administrator named. */
export function draftAdminAccess(
  mode: AdminAccessMode,
  username: string,
): MachineAdminAccessV1 | null {
  if (mode === 'ask')
    return isAdministratorUsernameValid(username)
      ? { version: 1, mode: 'ask', administratorUsername: username }
      : null;
  return { version: 1, mode };
}

export function adminAccessEqual(
  left: MachineAdminAccessV1,
  right: MachineAdminAccessV1,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode !== 'ask' ||
      (right.mode === 'ask' &&
        left.administratorUsername === right.administratorUsername))
  );
}

/** `machines.setup.adminAccess.set` input: the saved policy the person saw, compared field-wise on the Machine. */
export function buildAdminAccessSetInput(
  input: Readonly<{
    serverId: string;
    machineId: string;
    metadataVersion: number;
    saved: MachineAdminAccessV1;
    next: MachineAdminAccessV1;
  }>,
) {
  return {
    serverId: input.serverId,
    machineId: input.machineId,
    expectedMetadataVersion: input.metadataVersion,
    expectedAdminAccess: input.saved,
    adminAccess: input.next,
    comparison: 'field' as const,
  };
}

/** The Machine's latest typed read of its passwordless sudo issue (Inspect, or the Set that saved Preauthorized). */
export type AdminAccessPreauthorizationSettled =
  | Readonly<{ kind: 'read'; issue: MachinePreauthorizationIssueV1 | null }>
  | Readonly<{ kind: 'failed'; code: string }>;

/** `settled` stays shown while `checking` reads again, so Check again never empties the notice. */
export type AdminAccessPreauthorizationRead = Readonly<{
  settled: AdminAccessPreauthorizationSettled | null;
  checking: boolean;
}>;

export type AdminAccessPreauthorizationNotice =
  | Readonly<{ kind: 'reading' }>
  | Readonly<{ kind: 'steps'; cause: MachinePreauthorizationIssueV1['cause']; command: string; sudoersRule: string; checking: boolean }>
  | Readonly<{ kind: 'noSteps'; cause: MachinePreauthorizationIssueV1['cause']; checking: boolean }>
  | Readonly<{ kind: 'readFailed'; code: string; checking: boolean }>;

/**
 * Preauthorized chosen or saved while the pushed observation says the Machine's sudo still asks for a password: the
 * notice's place is known from that fact alone, so it holds while the Machine's own steps are read. Only people who
 * manage an online Machine can read and act on them; everyone else has the headline.
 */
export function needsAdminAccessPreauthorizationSteps(
  input: Readonly<{
    mode: AdminAccessMode | null;
    observation: MachineAdminAccessObservationV1 | null;
    canManage: boolean;
    online: boolean | null;
  }>,
): boolean {
  return (
    input.mode === 'preauthorized' &&
    input.canManage &&
    input.online === true &&
    input.observation !== null &&
    input.observation.daemonIdentity !== 'root' &&
    input.observation.passwordlessSudoToRoot === 'denied'
  );
}

export function describeAdminAccessPreauthorization(
  input: Parameters<typeof needsAdminAccessPreauthorizationSteps>[0] &
    Readonly<{ read: AdminAccessPreauthorizationRead }>,
): AdminAccessPreauthorizationNotice | null {
  if (!needsAdminAccessPreauthorizationSteps(input)) return null;
  const { settled, checking } = input.read;
  if (settled === null) return { kind: 'reading' };
  if (settled.kind === 'failed')
    return { kind: 'readFailed', code: settled.code, checking };
  // A fresh read with no issue is newer than the pushed denial; the republished observation follows.
  if (settled.issue === null) return null;
  const { cause, remedy } = settled.issue;
  return remedy
    ? { kind: 'steps', cause, command: remedy.command, sudoersRule: remedy.sudoersRule, checking }
    : { kind: 'noSteps', cause, checking };
}

/** Ask and Preauthorized need an elevation route the Machine's system has; the observation says when it has none. */
export function isElevationPlatformUnsupported(
  observation: MachineAdminAccessObservationV1 | null,
): boolean {
  return observation?.reasonCode === 'platformUnsupported';
}
