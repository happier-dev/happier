import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import {
  normalizeActionsSettingsV1,
  setScopedActionApprovalPreference,
} from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from './actionIds.js';
import { getArtifactKindPolicyV1 } from '../artifacts/artifactSharingV1.js';
import type { BoundApprovalProfileV1 } from './approvalProfiles.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
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

  // An inherited Team or Group profile is marked by the creation-stamped bit; it is a default,
  // not a lock, so the person's own explicit choice clears it (managedDefaults owner).
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
  it('keeps an inherited Team Ask above the Session Machine row', () => {
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
    // The plugin carrier answers nothing: plugin Asks key on the contributed Action's qualified id.
    expect(isSessionApprovalConsentEligibleV1(ACTION_INVOKE_ACTION_ID_V1)).toBe(false);
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
    expect(await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.set',
      { actionId: ACTION_INVOKE_ACTION_ID_V1, audience: 'agent', session, mode: 'allowed' }))
      .toMatchObject({ ok: false, errorCode: 'session_approval_consent_unsupported' });
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

describe('an agent asks to change its own Session rows (F-6)', () => {
  it('asks with the policy Action\'s own Ask, then the person\'s approval writes the row', async () => {
    const records = new Map<string, { header: Readonly<Record<string, unknown>>; body: string; version: number }>();
    const store: SessionApprovalConsentsStoreV1 = {
      list: async () => ({ items: [...records].map(([artifactId, row]) => ({ artifactId, header: row.header, body: row.body,
        access: 'owner' as const, revision: { headerVersion: row.version, bodyVersion: row.version } })) }),
      create: async ({ header, body }) => { records.set('consents', { header, body, version: 1 });
        return { artifactId: 'consents', revision: { headerVersion: 1, bodyVersion: 1 } }; },
      update: async ({ artifactId, header, body }) => { const version = (records.get(artifactId)?.version ?? 0) + 1;
        records.set(artifactId, { header, body, version }); return { ok: true, revision: { headerVersion: version, bodyVersion: version } }; },
    };
    const requests = new Map<string, unknown>();
    const executor = createActionExecutor({
      readActionsSettings: () => empty,
      // Both hosts answer the Session target through this one owner.
      settingsDeclarationAction: async ({ actionId, input }) => {
        if (actionId !== 'actions.policy.get' && actionId !== 'actions.policy.set' && actionId !== 'actions.policy.reset') return {};
        const { ActionPolicyInputSchemas } = await import('./actionPolicyActionFamily.js');
        return await executeSessionApprovalConsentPolicyV1(store, actionId, ActionPolicyInputSchemas[actionId].parse(input)) ?? {};
      },
      approvalsCreate: async ({ request }) => { requests.set('policy-change', request); return { artifactId: 'policy-change' }; },
      approvalsGet: async ({ artifactId }) => (requests.get(artifactId) ?? null) as never,
      approvalsUpdate: async ({ artifactId, request }) => { requests.set(artifactId, request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const input = { actionId, audience: 'agent', session: { sessionId: 's1' }, mode: 'allowed' } as const;
    const agentContext: ActionExecutorContext = { surface: 'agent', serverId: 'home-a', defaultSessionId: 's1',
      actionRequestId: 'agent-policy-change' };
    expect(await executor.execute('actions.policy.set', input, agentContext)).toMatchObject({ ok: true });
    expect(requests.get('policy-change')).toMatchObject({ status: 'open', actionId: 'actions.policy.set', actionArgs: input });
    expect(records.size).toBe(0);
    expect(await executor.execute('approval.request.decide', { artifactId: 'policy-change', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home-a' })).toMatchObject({ ok: true });
    expect(await executeSessionApprovalConsentPolicyV1(store, 'actions.policy.get', { session: { sessionId: 's1' } }))
      .toEqual({ session: { sessionId: 's1' }, rows: [{ actionId, audience: 'agent', mode: 'allowed' }] });
    // The person's own write from their app is direct: no second confirmation.
    const before = requests.size;
    expect(await executor.execute('actions.policy.set', { ...input, mode: 'ask_first' },
      { surface: 'ui', authority: 'present_user', serverId: 'home-a', actionCaller: { kind: 'host' } }))
      .toMatchObject({ ok: true, result: { mode: 'ask_first' } });
    expect(requests.size).toBe(before);
  });
});

describe('the approval request carries the admitted scope for the "On {Machine}" rung', () => {
  it('records the Machine that scope admission resolved, so the sheet can offer that rung', async () => {
    const created: unknown[] = [];
    const input = { serverId: 'server-1', machineId: 'machine-1', expectedInstallationId: 'installation' };
    const executor = createActionExecutor({
      readActionsSettings: () => empty,
      approvalsCreate: async ({ request }) => { created.push(request); return { artifactId: 'reboot-approval' }; },
      machineRebootReferences: async () => ({ homeId: 'stable-home', machineId: input.machineId, coverage: 'complete',
        references: [], nextCursor: null }),
      machineServiceAction: async () => ({ kind: 'snapshot', services: [] }),
      machineReboot: async () => ({ kind: 'unavailable', reason: 'admission_unavailable' }),
    });
    const result = await executor.execute('machines.reboot', input, { surface: 'agent', serverId: input.serverId,
      defaultSessionId: 's1', actionRequestId: 'reboot-1' });
    expect(created, JSON.stringify(result)).toHaveLength(1);
    expect(created[0]).toMatchObject({ actionId: 'machines.reboot', approvalScope: { kind: 'machine', machineId: 'machine-1' } });
    expect(ApprovalRequestV2Schema.safeParse(created[0]).success).toBe(true);
  });
});
