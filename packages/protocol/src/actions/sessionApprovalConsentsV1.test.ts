import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import {
  normalizeActionsSettingsV1,
  setScopedActionApprovalPreference,
} from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { getArtifactKindPolicyV1 } from '../artifacts/artifactSharingV1.js';
import type { BoundApprovalProfileV1 } from './approvalProfiles.js';
import type { ActionExecutorContext } from './executor/types.js';
import { executeSessionApprovalConsentPolicyV1, isSessionApprovalConsentEligibleV1 } from './sessionApprovalConsentPolicyV1.js';
import {
  readSessionApprovalConsentsArtifactV1,
  SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
  type BoundSessionApprovalConsentsV1,
  type SessionApprovalConsentRowV1,
  type SessionApprovalConsentsStoreV1,
} from './sessionApprovalConsentsV1.js';

const actionId = 'deployments.deploy';
const spec = getActionSpec(actionId);
const agent = {
  surface: 'agent' as const,
  authority: 'account_automation' as const,
};
const consents = (
  ...rows: SessionApprovalConsentRowV1[]
): BoundSessionApprovalConsentsV1 => ({ sessionId: 's1', rows });
const always = (
  scope?: SessionApprovalConsentRowV1['scope'],
): SessionApprovalConsentRowV1 => ({
  actionId,
  audience: 'agent',
  mode: 'allowed',
  ...(scope ? { scope } : {}),
});
const empty = normalizeActionsSettingsV1({ v: 1 });
const route = (
  context: Parameters<typeof resolveActionApprovalRouting>[0]['context'],
  extra: Partial<Parameters<typeof resolveActionApprovalRouting>[0]> = {},
) =>
  resolveActionApprovalRouting({
    actionId,
    spec,
    settings: empty,
    context,
    ...extra,
  }).required;

describe('Session rungs on the approval-preference ladder', () => {
  it('turns the agent default Ask into a run only with the Session "Always" row', () => {
    expect(route(agent)).toBe(true);
    expect(
      route({ ...agent, sessionApprovalConsents: consents(always()) }),
    ).toBe(false);
    // Another Action keeps its own Ask.
    expect(
      route({
        ...agent,
        sessionApprovalConsents: consents({
          ...always(),
          actionId: 'deployments.teardown',
        }),
      }),
    ).toBe(true);
  });

  it('answers the "On" rung only on its Machine', () => {
    const onM1 = {
      ...agent,
      sessionApprovalConsents: consents(
        always({ kind: 'machine', machineId: 'm1' }),
      ),
    };
    expect(
      route(onM1, { approvalScope: { kind: 'machine', machineId: 'm1' } }),
    ).toBe(false);
    expect(
      route(onM1, { approvalScope: { kind: 'machine', machineId: 'm2' } }),
    ).toBe(true);
    expect(route(onM1)).toBe(true);
  });

  it('beats the person\'s own Account "Ask first" and their narrower Account rows (Q1)', () => {
    const askFirst = normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
    });
    const scopedAsk = setScopedActionApprovalPreference({
      settings: empty,
      actionId,
      scope: { kind: 'machine', machineId: 'm1' },
      surface: 'agent',
      mode: 'required',
    });
    const context = { ...agent, sessionApprovalConsents: consents(always()) };
    expect(route(context, { settings: askFirst })).toBe(false);
    expect(
      route(context, {
        settings: scopedAsk,
        approvalScope: { kind: 'machine', machineId: 'm1' },
      }),
    ).toBe(false);
    // A Session "Ask first" also tightens a permissive Account answer.
    const waived = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    expect(
      route(
        {
          ...agent,
          sessionApprovalConsents: consents({ ...always(), mode: 'ask_first' }),
        },
        { settings: waived },
      ),
    ).toBe(true);
  });

  it("leaves a database owner's Ask above the Session row", () => {
    expect(
      route(
        { ...agent, sessionApprovalConsents: consents(always()) },
        { targetApproval: { databaseAgentLevel: 'readWriteAsk' } },
      ),
    ).toBe(true);
  });

  // The inherited Team Ask wins only while its Team-derived bit is honest. Coordination owns
  // reading that bit from the server-owned Team policy (F-5); these cases inject it directly.
  const teamAsk: BoundApprovalProfileV1 = {
    profile: {
      id: 'team',
      name: 'Team',
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
    },
    resolution: { status: 'available', requestedId: 'team' },
  };
  const team = {
    ...agent,
    approvalProfileId: 'team',
    approvalProfile: teamAsk,
    approvalProfileTeamOrGroupDerived: true,
  };
  it('keeps an inherited Team Ask above the Session Action row', () => {
    expect(
      route({ ...team, sessionApprovalConsents: consents(always()) }),
    ).toBe(true);
    // The person's own picked profile is below the Session row.
    expect(
      route({
        ...team,
        approvalProfileTeamOrGroupDerived: false,
        sessionApprovalConsents: consents(always()),
      }),
    ).toBe(false);
  });
  // Prerequisite: Coordination's precedence change "an inherited Ask beats a member's own
  // exact-scope Allowed" (ORCH-TOP 17:26Z ruling 2). Flip to it() when that lands.
  it.fails('keeps an inherited Team Ask above the Session Machine row (needs Coordination precedence change)', () => {
    expect(
      route(
        {
          ...team,
          sessionApprovalConsents: consents(
            always({ kind: 'machine', machineId: 'm1' }),
          ),
        },
        { approvalScope: { kind: 'machine', machineId: 'm1' } },
      ),
    ).toBe(true);
  });

  it('keys contributed Actions by their profile identity, never the carrier', () => {
    const contributed = 'example.plugin/actions/deploy';
    const invoke = getActionSpec('action.invoke');
    const required = (rows: SessionApprovalConsentRowV1[]) =>
      resolveActionApprovalRouting({
        actionId: 'action.invoke',
        profileActionId: contributed,
        spec: invoke,
        settings: empty,
        defaultConfirmation: true,
        context: { ...agent, sessionApprovalConsents: consents(...rows) },
      }).required;
    expect(required([])).toBe(true);
    expect(required([{ ...always(), actionId: 'action.invoke' }])).toBe(true);
    expect(required([{ ...always(), actionId: contributed }])).toBe(false);
  });

  it("never waives an approval-rule change from a Session row (Q6), while an Account waiver stays the person's choice", () => {
    const policySet = 'actions.policy.set';
    const input = { actionId, audience: 'agent', mode: 'allowed' };
    const required = (
      settings = empty,
      rows: SessionApprovalConsentRowV1[] = [],
    ) =>
      resolveActionApprovalRouting({
        actionId: policySet,
        spec: getActionSpec(policySet),
        input,
        settings,
        context: { ...agent, sessionApprovalConsents: consents(...rows) },
      }).required;
    expect(required()).toBe(true);
    expect(
      required(empty, [
        { actionId: policySet, audience: 'agent', mode: 'allowed' },
      ]),
    ).toBe(true);
    expect(
      required(
        normalizeActionsSettingsV1({
          v: 1,
          approvalWaivedSurfaces: { [policySet]: ['agent'] },
        }),
      ),
    ).toBe(false);
    for (const id of [
      'actions.policy.set',
      'actions.policy.reset',
      'session.approval_profile.set',
      'approval.request.decide',
      'capture.view',
    ]) {
      expect(isSessionApprovalConsentEligibleV1(id), id).toBe(false);
    }
    expect(isSessionApprovalConsentEligibleV1(actionId)).toBe(true);
    expect(
      isSessionApprovalConsentEligibleV1('example.plugin/actions/deploy'),
    ).toBe(true);
  });
});

describe('Session consent record', () => {
  it('is private: no people sharing, recipient or public link (F-3)', () => {
    expect(getArtifactKindPolicyV1(SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1)).toMatchObject({
      peopleSharingAllowed: false, publicLinkAllowed: false, browserListed: false });
  });
  const resource = (
    body: unknown,
    header: Record<string, unknown> = {
      kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
      sessionId: 's1',
    },
  ) => ({
    artifactId: 'a1',
    header,
    body: JSON.stringify(body),
    access: 'owner' as const,
    revision: { headerVersion: 1, bodyVersion: 1 },
  });
  it('drops rows that do not parse and refuses a record bound to another Session', () => {
    const body = {
      v: 1,
      kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
      sessionId: 's1',
      rows: [
        always(),
        { actionId, audience: 'agent', mode: 'always' },
        { actionId: 'not an id', audience: 'agent', mode: 'allowed' },
      ],
    };
    expect(
      readSessionApprovalConsentsArtifactV1(resource(body), 's1')?.rows,
    ).toEqual([always()]);
    expect(
      readSessionApprovalConsentsArtifactV1(resource(body), 's2'),
    ).toBeNull();
    expect(
      readSessionApprovalConsentsArtifactV1(
        resource({ ...body, sessionId: 's2' }),
        's1',
      ),
    ).toBeNull();
    expect(
      readSessionApprovalConsentsArtifactV1(
        { ...resource(body), access: 'edit' },
        's1',
      ),
    ).toBeNull();
  });

  it('adds, changes, lists and removes rows through the policy Actions, writing one record and nothing per call', async () => {
    const rows = new Map<
      string,
      {
        header: Readonly<Record<string, unknown>>;
        body: string;
        headerVersion: number;
        bodyVersion: number;
      }
    >();
    let creates = 0;
    const store: SessionApprovalConsentsStoreV1 = {
      list: async (options) => ({
        items: [...rows]
          .filter(
            ([, row]) =>
              row.header.kind === options.kinds?.[0] &&
              options.approvalSessionIds?.includes(
                String(row.header.sessionId),
              ),
          )
          .map(([artifactId, row]) => ({
            artifactId,
            header: row.header,
            body: row.body,
            access: 'owner' as const,
            revision: {
              headerVersion: row.headerVersion,
              bodyVersion: row.bodyVersion,
            },
          })),
      }),
      create: async ({ header, body }) => {
        creates++;
        rows.set(`c${creates}`, {
          header,
          body,
          headerVersion: 1,
          bodyVersion: 1,
        });
        return {
          artifactId: `c${creates}`,
          revision: { headerVersion: 1, bodyVersion: 1 },
        };
      },
      update: async ({ artifactId, expectedRevision, header, body }) => {
        const row = rows.get(artifactId);
        if (!row || row.bodyVersion !== expectedRevision.bodyVersion)
          return {
            ok: false,
            errorCode: 'version_mismatch',
            error: 'version_mismatch',
          };
        rows.set(artifactId, {
          header,
          body,
          headerVersion: row.headerVersion + 1,
          bodyVersion: row.bodyVersion + 1,
        });
        return {
          ok: true,
          revision: {
            headerVersion: row.headerVersion + 1,
            bodyVersion: row.bodyVersion + 1,
          },
        };
      },
    };
    const session = { sessionId: 's1' };
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.set', {
        actionId,
        audience: 'agent',
        session,
        mode: 'allowed',
      }),
    ).toMatchObject({ mode: 'allowed', session });
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.set', {
        actionId,
        audience: 'agent',
        session,
        scope: { kind: 'machine', machineId: 'm1' },
        mode: 'ask_first',
      }),
    ).toMatchObject({ mode: 'ask_first' });
    expect(creates).toBe(1);
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.get', {
        session,
      }),
    ).toEqual({
      session,
      rows: [
        always(),
        {
          actionId,
          audience: 'agent',
          scope: { kind: 'machine', machineId: 'm1' },
          mode: 'ask_first',
        },
      ],
    });
    expect(
      await executeSessionApprovalConsentPolicyV1(
        store,
        'actions.policy.reset',
        { actionId, audience: 'agent', session },
      ),
    ).toMatchObject({ mode: 'default' });
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.get', {
        actionId,
        audience: 'agent',
        session,
      }),
    ).toMatchObject({ mode: 'default' });
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.set', {
        actionId: 'actions.policy.set',
        audience: 'agent',
        session,
        mode: 'allowed',
      }),
    ).toMatchObject({
      ok: false,
      errorCode: 'session_approval_consent_unsupported',
    });
    // Continue after a failed resume moves the record; the source then lists nothing.
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.set', {
        sessionConsentsMove: { fromSessionId: 's1', toSessionId: 's2' },
      }),
    ).toMatchObject({ moved: true });
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.get', {
        session,
      }),
    ).toEqual({ session, rows: [] });
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.get', {
        session: { sessionId: 's2' },
      }),
    ).toMatchObject({
      rows: [{ scope: { kind: 'machine', machineId: 'm1' } }],
    });
    expect(creates).toBe(1);
    // Account targets stay with the Account-settings owner.
    expect(
      await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.set', {
        actionId,
        audience: 'agent',
        mode: 'allowed',
      }),
    ).toBeUndefined();
  });
});

describe('admission binds the Session rows once, from the host', () => {
  const input = () => getActionSpec('discussion.post').inputSchema.parse({ discussionId: 'discussion', localId: 'post',
    content: { v: 1, parts: [{ t: 'text', text: 'hello' }] }, mentionedSessionIds: [] });
  const allowPost = consents({ actionId: 'discussion.post', audience: 'agent', mode: 'allowed' });
  const run = async (bound: BoundSessionApprovalConsentsV1 | null, callerSupplied?: BoundSessionApprovalConsentsV1) => {
    let lookups = 0;
    const seen: unknown[] = [];
    const executor = createActionExecutor({
      readActionsSettings: () => empty,
      readSessionApprovalConsents: async () => { lookups++; return bound; },
      approvalsCreate: async () => ({ artifactId: 'approval' }),
      discussionAction: async ({ context }) => { seen.push(context.sessionApprovalConsents); return {}; },
    });
    const context: ActionExecutorContext = { ...agent, runtimeAccountId: 'alice', serverId: 'server-1', defaultSessionId: 's1',
      actionCaller: { kind: 'session', sessionId: 's1' },
      ...(callerSupplied ? { sessionApprovalConsents: callerSupplied } : {}) };
    await executor.execute('discussion.post', input(), context);
    return { lookups, seen };
  };

  it('binds the host lookup into the admitted context with one lookup per admission', async () => {
    expect(await run(allowPost)).toEqual({ lookups: 1, seen: [allowPost] });
  });

  it('replaces caller-supplied rows with the host lookup', async () => {
    expect(await run(null, allowPost)).toEqual({ lookups: 1, seen: [null] });
  });
});
