import { describe, expect, it } from 'vitest';
import {
  composeSessionReadinessV1,
  type SessionReadinessFactsV1,
} from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { t } from '@/text';
import { presentSessionReadiness, presentSessionReadinessChecklist } from './sessionReadinessPresentation';

const yes = true;
const invocation: SessionReadinessFactsV1['invocation'] = { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: {
    readTranscript: yes, submitAgentInput: yes, editSessionRecords: yes, approveRuntimePermissions: yes, manageAccess: yes,
    managePermissionDelegation: yes, managePublicLink: yes, archiveSession: yes, renameSession: yes, assignResponsibility: yes,
    stopSession: yes, deleteSession: yes } };
const facts = (
  patch: Partial<SessionReadinessFactsV1>,
): SessionReadinessFactsV1 => ({
  configured: true,
  operation: 'conversation',
  machine: { status: 'ready', machineId: 'm1' },
  agent: {
    agentId: 'codex',
    state: 'ready',
    current: true,
    observedAtMs: 1,
    repair: null,
  },
  invocation,
  credential: { kind: 'not_required' },
  ...patch,
});
const signIn = {
  actionId: 'machines.agents.signIn.start',
  input: { machineId: 'm1', agentId: 'codex', method: 'native' },
} as const;
const present = (
  patch: Partial<SessionReadinessFactsV1>,
  repair: typeof signIn | null = null,
) =>
  presentSessionReadiness({
    readiness: composeSessionReadinessV1(facts(patch)),
    repair,
    demanded: true,
    loading: false,
    unavailableReason: null,
  });

describe('presentSessionReadiness', () => {
  it('never paints Ready for a closed, loading, failed or unknown read', () => {
    const base = {
      readiness: null,
      repair: null,
      loading: false,
      unavailableReason: null,
    };
    expect(presentSessionReadiness({ ...base, demanded: false }).tone).toBe(
      'unknown',
    );
    expect(
      presentSessionReadiness({ ...base, demanded: true, loading: true }).tone,
    ).toBe('unknown');
    expect(
      presentSessionReadiness({
        ...base,
        demanded: true,
        unavailableReason: 'unavailable',
      }),
    ).toMatchObject({ tone: 'unknown', repair: null });
    const pending = present({
      machine: { status: 'unknown', machineId: 'm1' },
    });
    expect(pending.tone).toBe('unknown');
    expect(pending.title).not.toBe(t('session.collaboration.readiness.ready'));
  });

  it('says one Machine cause for an offline Bot and offers no borrowed repair', () => {
    const offline = present({
      machine: { status: 'offline', machineId: 'm1' },
    });
    expect(offline).toMatchObject({
      tone: 'attention',
      cause: t('session.collaboration.readiness.cause.machineOffline'),
      repair: null,
      guidance: null,
    });
  });

  it('offers the owner repair only when the status owner proposed it; otherwise who can fix it', () => {
    const needsSignIn = {
      agent: {
        agentId: 'codex',
        state: 'needsSignIn' as const,
        current: true,
        observedAtMs: 1,
        repair: signIn,
      },
    };
    const entitled = present(needsSignIn, signIn);
    expect(entitled.tone).toBe('attention');
    expect(entitled.repair?.repair).toBe(signIn);
    expect(entitled.guidance).toBeNull();
    const borrowed = present(
      { agent: { ...needsSignIn.agent, repair: null } },
      null,
    );
    expect(borrowed.repair).toBeNull();
    expect(borrowed.guidance).toBe(
      t('session.collaboration.readiness.ownerOnly'),
    );
  });

  it('is quiet when ready', () => {
    expect(present({})).toMatchObject({
      tone: 'ready',
      cause: null,
      repair: null,
      guidance: null,
    });
  });
});

describe('presentSessionReadinessChecklist', () => {
  const checklist = (patch: Partial<SessionReadinessFactsV1>) =>
    presentSessionReadinessChecklist(composeSessionReadinessV1(facts(patch)), { machineName: 'MacBook Pro' })
      .map((row) => [row.id, row.state]);

  it('lists one row per prerequisite and omits a connected account that is not needed', () => {
    const rows = presentSessionReadinessChecklist(composeSessionReadinessV1(facts({})), { machineName: 'MacBook Pro' });
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ['machine', 'ok'], ['agent', 'ok'], ['invocation', 'ok'],
    ]);
    expect(rows[0]!.title).toBe('MacBook Pro');
  });

  it('marks the failing prerequisite and never certifies a fact that is stale or unread', () => {
    expect(checklist({
      machine: { status: 'offline', machineId: 'm1' },
      agent: { agentId: 'codex', state: 'ready', current: false, observedAtMs: 1, repair: null },
      invocation: null,
    })).toEqual([['machine', 'bad'], ['agent', 'unknown'], ['invocation', 'unknown']]);
    expect(checklist({ machine: { status: 'unknown', machineId: 'm1' } })[0]).toEqual(['machine', 'unknown']);
    expect(checklist({ agent: { agentId: 'codex', state: 'needsSignIn', current: true, observedAtMs: 1, repair: null } })[1])
      .toEqual(['agent', 'bad']);
  });

  it('says when the person cannot ask it', () => {
    const viewOnly = { ...invocation!, level: 'view' as const, capabilities: { ...invocation!.capabilities, submitAgentInput: false } };
    expect(checklist({ invocation: viewOnly })[2]).toEqual(['invocation', 'bad']);
  });

  it('carries the connected account as its own row, unknown until its owner answers', () => {
    const purpose = { consumer: { pluginId: 'linear', contributionId: 'linear' }, purpose: 'issues' } as never;
    expect(checklist({ operation: 'credential', credential: { kind: 'personal', purpose, usable: null, repair: null } })[3])
      .toEqual(['credential', 'unknown']);
    expect(checklist({ operation: 'credential', credential: { kind: 'personal', purpose, usable: false, repair: null } })[3])
      .toEqual(['credential', 'bad']);
    expect(checklist({ operation: 'credential', credential: { kind: 'team', resourceId: 'r', teamId: 't',
      readiness: { kind: 'policy_denied' }, recoveryAction: null } })[3]).toEqual(['credential', 'bad']);
    expect(checklist({ operation: 'credential', credential: { kind: 'unknown' } })[3]).toEqual(['credential', 'unknown']);
  });
});
