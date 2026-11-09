import type {
  SessionReadinessRepairV1,
  SessionReadinessV1,
} from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import type { MachineSpawnReadinessV1 } from '@happier-dev/protocol/machines/machineSpawnReadinessV1';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';

export type SessionReadinessPresentation = Readonly<{
  /** `attention` is the only state that speaks (amber); unknown never reads as ready. */
  tone: 'ready' | 'attention' | 'unknown';
  title: string;
  cause: string | null;
  /** The owner's exact repair when the viewer may run it; otherwise who can fix it. */
  repair: Readonly<{ label: string; repair: SessionReadinessRepairV1 }> | null;
  guidance: string | null;
}>;

/** One cause for a Machine that cannot take work now; `null` when it can or when nothing is known. */
export function describeMachineReadinessCause(
  machine: MachineSpawnReadinessV1 | null,
): string | null {
  switch (machine?.status) {
    case 'offline':
      return t('session.collaboration.readiness.cause.machineOffline');
    case 'revoked':
    case 'replaced':
      return t('session.collaboration.readiness.cause.machineRemoved');
    case 'keyUnavailable':
      return t('session.collaboration.readiness.cause.machineLocked');
    case 'rpcUnavailable':
      return t('session.collaboration.readiness.cause.machineNotResponding');
    case 'missing':
      return t('session.collaboration.readiness.cause.machineMissing');
    default:
      return null;
  }
}

/** Shared wording for the Agent availability owner's verdict, including a recorded start refusal. */
export function describeAgentReadinessCause(agent: Readonly<{
  title: string;
  state: NonNullable<SessionReadinessV1['agent']>['state'];
}>): string {
  const key = agent.state === 'unknown'
    ? 'session.collaboration.readiness.cause.agentUnknown'
    : agent.state === 'notInstalled'
      ? 'session.collaboration.readiness.cause.agentNotInstalled'
      : agent.state === 'unsupported'
        ? 'session.collaboration.readiness.cause.agentUnsupported'
        : 'session.collaboration.readiness.cause.agentSignIn';
  return t(key, { agent: agent.title });
}

function describeCause(readiness: SessionReadinessV1): string | null {
  const agent = readiness.agent
    ? resolveAgentCatalogTitle(readiness.agent.agentId)
    : null;
  switch (readiness.cause) {
    case 'machine':
      return describeMachineReadinessCause(readiness.machine) ??
            (readiness.status === 'unknown'
              ? t('session.collaboration.readiness.cause.machineChecking')
              : null);
    case 'agent':
      if (!agent || !readiness.agent) return null;
      return describeAgentReadinessCause({ title: agent,
        state: readiness.status === 'unknown' ? 'unknown' : readiness.agent.state });
    case 'invocation':
      return readiness.status === 'unknown'
        ? t('session.collaboration.readiness.cause.invocationUnknown')
        : t('session.collaboration.readiness.cause.invocation');
    case 'credential':
      return readiness.status === 'unknown'
        ? t('session.collaboration.readiness.cause.credentialUnknown')
        : t('session.collaboration.readiness.cause.credential');
    default:
      return null;
  }
}

/**
 * Configured vs ready, as one line and one next step, from the status owner's snapshot. Nothing here
 * decides readiness: `null` (not asked for, still reading, or the read failed) is said as such.
 */
export function presentSessionReadiness(
  input: Readonly<{
    readiness: SessionReadinessV1 | null;
    repair: SessionReadinessRepairV1 | null;
    demanded: boolean;
    loading: boolean;
    unavailableReason: string | null;
  }>,
): SessionReadinessPresentation {
  const quiet = (
    title: string,
    cause: string | null = null,
  ): SessionReadinessPresentation => ({
    tone: 'unknown',
    title,
    cause,
    repair: null,
    guidance: null,
  });
  const { readiness } = input;
  if (!readiness) {
    if (!input.demanded)
      return quiet(t('session.collaboration.readiness.notChecked'));
    if (input.loading)
      return quiet(t('session.collaboration.readiness.checking'));
    return quiet(
      input.unavailableReason
        ? t('session.collaboration.readiness.checkFailed')
        : t('session.collaboration.readiness.checking'),
    );
  }
  if (readiness.status === 'ready')
    return {
      tone: 'ready',
      title: t('session.collaboration.readiness.ready'),
      cause: null,
      repair: null,
      guidance: null,
    };
  if (readiness.status === 'unknown')
    return quiet(
      t('session.collaboration.readiness.unknown'),
      describeCause(readiness),
    );
  if (readiness.cause === 'configuration') {
    return {
      tone: 'attention',
      title: t('session.collaboration.readiness.notSetUp'),
      cause: null,
      repair: null,
      guidance: null,
    };
  }
  const repair = input.repair
    ? {
        label:
          input.repair.actionId === 'machines.agents.signIn.start'
            ? t('session.collaboration.readiness.repair.signIn')
            : t('session.collaboration.readiness.repair.reconnect'),
        repair: input.repair,
      }
    : null;
  // Only the setup owner can repair Agent sign-in or a connected account; a Machine or access cause has its own line.
  const ownerRepairs =
    readiness.cause === 'agent' || readiness.cause === 'credential';
  return {
    tone: 'attention',
    title: t('session.collaboration.readiness.notReady'),
    cause: describeCause(readiness),
    repair,
    guidance:
      !repair && ownerRepairs
        ? t('session.collaboration.readiness.ownerOnly')
        : null,
  };
}

export type SessionReadinessCheckState = 'ok' | 'bad' | 'unknown';
export type SessionReadinessCheck = Readonly<{
  id: 'machine' | 'agent' | 'invocation' | 'credential';
  state: SessionReadinessCheckState;
  title: string;
  detail: string;
}>;

function checkMachine(
  machine: SessionReadinessV1['machine'],
  machineName: string | null,
): SessionReadinessCheck {
  const title = machineName ?? t('session.collaboration.readiness.facts.machine');
  const row = (state: SessionReadinessCheckState, detail: string): SessionReadinessCheck => ({ id: 'machine', state, title, detail });
  switch (machine?.status) {
    case 'ready':
      return row('ok', t('session.collaboration.readiness.facts.online'));
    case 'offline':
      return row('bad', t('session.collaboration.readiness.facts.offline'));
    case 'revoked':
    case 'replaced':
      return row('bad', t('session.collaboration.readiness.facts.removed'));
    case 'keyUnavailable':
      return row('bad', t('session.collaboration.readiness.facts.locked'));
    case 'rpcUnavailable':
      return row('bad', t('session.collaboration.readiness.facts.notResponding'));
    case 'missing':
      return row('bad', t('session.collaboration.readiness.facts.noMachine'));
    default:
      return row('unknown', t('session.collaboration.readiness.facts.notChecked'));
  }
}

function checkAgent(agent: SessionReadinessV1['agent']): SessionReadinessCheck {
  const title = agent ? resolveAgentCatalogTitle(agent.agentId) : t('session.collaboration.readiness.facts.agent');
  const row = (state: SessionReadinessCheckState, detail: string): SessionReadinessCheck => ({ id: 'agent', state, title, detail });
  // A stale observation never certifies anything; it is said as not checked.
  if (!agent?.current) return row('unknown', t('session.collaboration.readiness.facts.notChecked'));
  switch (agent.state) {
    case 'ready':
      return row('ok', t('session.collaboration.readiness.facts.signedIn'));
    case 'needsSignIn':
      return row('bad', t('session.collaboration.readiness.facts.needsSignIn'));
    case 'notInstalled':
      return row('bad', t('session.collaboration.readiness.facts.notInstalled'));
    case 'unsupported':
      return row('bad', t('session.collaboration.readiness.facts.unsupported'));
    default:
      return row('unknown', t('session.collaboration.readiness.facts.notChecked'));
  }
}

function checkInvocation(invocation: SessionReadinessV1['invocation']): SessionReadinessCheck {
  if (!invocation) {
    return { id: 'invocation', state: 'unknown', title: t('session.collaboration.readiness.facts.canAsk'),
      detail: t('session.collaboration.readiness.facts.notChecked') };
  }
  if (!invocation.capabilities.submitAgentInput) {
    return { id: 'invocation', state: 'bad', title: t('session.collaboration.readiness.facts.cannotAsk'),
      detail: t('session.collaboration.readiness.facts.readOnly') };
  }
  const source = invocation.sources[0]?.kind;
  return {
    id: 'invocation',
    state: 'ok',
    title: t('session.collaboration.readiness.facts.canAsk'),
    detail: source === 'owner'
      ? t('session.collaboration.readiness.facts.yours')
      : source === 'team' || source === 'group'
        ? t('session.collaboration.readiness.facts.throughTeam')
        : t('session.collaboration.readiness.facts.sharedWithYou'),
  };
}

function checkCredential(credential: SessionReadinessV1['credential']): SessionReadinessCheck | null {
  const title = t('session.collaboration.readiness.facts.account');
  const row = (state: SessionReadinessCheckState, detail: string): SessionReadinessCheck => ({ id: 'credential', state, title, detail });
  switch (credential.kind) {
    case 'not_required':
      return null;
    case 'unknown':
      return row('unknown', t('session.collaboration.readiness.facts.notChecked'));
    case 'personal':
      return credential.usable === null
        ? row('unknown', t('session.collaboration.readiness.facts.notChecked'))
        : credential.usable
          ? row('ok', t('session.collaboration.readiness.facts.connected'))
          : row('bad', t('session.collaboration.readiness.facts.reconnect'));
    case 'team': {
      const readiness = credential.readiness;
      if (!readiness) return row('unknown', t('session.collaboration.readiness.facts.notChecked'));
      if (readiness.kind === 'available') return row('ok', t('session.collaboration.readiness.facts.connected'));
      return row('bad', readiness.kind === 'limit_reached'
        ? t('session.collaboration.readiness.facts.limitReached')
        : readiness.kind === 'policy_denied'
          ? t('session.collaboration.readiness.facts.policyDenied')
          : t('session.collaboration.readiness.facts.unavailable'));
    }
  }
}

/**
 * The prerequisites behind the one cause (lab K3-R checklist), one row each, straight from the status
 * owner's facts. Only an observed, current fact is ✓ or ✗; anything unread is "Not checked".
 */
export function presentSessionReadinessChecklist(
  readiness: SessionReadinessV1,
  names: Readonly<{ machineName: string | null }>,
): readonly SessionReadinessCheck[] {
  if (!readiness.configured) return [];
  const credential = checkCredential(readiness.credential);
  return [
    checkMachine(readiness.machine, names.machineName),
    checkAgent(readiness.agent),
    checkInvocation(readiness.invocation),
    ...(credential ? [credential] : []),
  ];
}
