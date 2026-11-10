import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from './actionExecutor.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { normalizeUiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { SessionBoardAuthoredItemUpsertInputV1Schema, SessionBoardGetInputV1Schema } from '../sessions/board/actions.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { SessionInputAdmissionResultV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';
import { describeApprovalRequestFields } from './actionApprovalPresentation.js';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const note: SessionSurfaceItemV1 = { v: 1, title: 'Result', frame: 'frameless',
  height: { mode: 'auto', fallback: 'regular' },
  source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Result' } } } };
const html = (request: unknown) => ({ ...note, source: { kind: 'hostedHtml',
  source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPlJlc3VsdDwvaDE+' } } },
  requestedCapabilities: request } });
const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home',
  defaultSessionId: 'session', defaultSessionMachineId: 'machine', runtimeAccountId: 'account', actionRequestId: 'show',
  actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 } };

function harness(initialSetting: unknown = 'allowed', extraDeps: Partial<ActionExecutorDeps> = {}) {
  let setting = initialSetting;
  let policyReads = 0;
  let stored: { item: SessionSurfaceItemV1; revision: string } | null = null;
  let approval: ApprovalRequest | null = null;
  let copyItem: SessionSurfaceItemV1 | null = null;
  const approvals: ApprovalRequest[] = [];
  const writes: SessionSurfaceItemV1[] = [];
  const boardReads: unknown[] = [];
  const deliveries = new Map<string, Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0]>();
  let executor: ReturnType<typeof createActionExecutor>;
  const deps: Partial<ActionExecutorDeps> = {
    // Exact Account settings and sealed Session record transports are boundaries;
    // parsing, consequences, preparation and approval replay stay real.
    readAgentHtmlNetworkPolicy: async () => { policyReads++; return setting; },
    sessionBoardAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['sessionBoardAction']>>[0]) => {
      if (actionId === 'session.board.get') {
        boardReads.push(input);
        const sessionId = SessionBoardGetInputV1Schema.parse(input).sessionId ?? 'session';
        const row = sessionId === 'session' ? stored : copyItem ? { item: copyItem, revision } : null;
        return { v: 1, serverId: 'home', sessionId,
        capabilities: { readTranscript: true, editSessionRecords: true }, layout: null,
        items: row ? [{ itemId: 'visual', ...row, title: row.item.title, sourceKind: row.item.source.kind }] : [],
        incomplete: false, page: { cursor: null, hasNext: false } };
      }
      const request = SessionBoardAuthoredItemUpsertInputV1Schema.parse(input);
      if (request.expectedItemRevision !== (stored?.revision ?? null)) {
        return { ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict',
          details: { currentItemRevision: stored?.revision ?? null } };
      }
      stored = { item: SessionSurfaceItemV1Schema.parse(request.item), revision };
      writes.push(stored.item);
      return { v: 1, serverId: 'home', sessionId: 'session', itemDestination: 'transcript', destination: null,
        result: { operation: 'upsert_item', itemId: 'visual', outcome: request.expectedItemRevision ? 'updated' : 'created', itemRevision: revision } };
    },
    approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { approval = request; approvals.push(request); return { artifactId: 'approval' }; },
    approvalsGet: async () => approval,
    approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => { approval = request; return { ok: true }; },
    // The originating Session's Pending transport acknowledges publication with
    // its existing local-id identity; all approval settlement remains real.
    sessionSendMessage: async request => {
      const result = SessionInputAdmissionResultV1Schema.parse({
        status: request.localId && deliveries.has(request.localId) ? 'alreadyAccepted' : 'accepted',
        localId: request.localId,
      });
      if (result.status === 'accepted') deliveries.set(result.localId, request);
      return result;
    },
    isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home'
      && origin.machineId === 'machine' && origin.sessionId === 'session',
    // The app's replay transport reaches the exact originating daemon, whose
    // real executor consumes only the already-approved Artifact.
    approvalRequestApprovedReplay: async ({ artifactId, request, context, signal }) => {
      expect(request.status).toBe('approved');
      expect(approval).toEqual(request);
      return executor.replayApprovedApprovalRequest({ artifactId, ...(signal ? { signal } : {}),
        callerAuthority: context.authority ?? 'account_automation',
        currentAccount: { accountId: 'account', serverId: 'home', serverIdentityId: 'home' } });
    },
    ...extraDeps,
  };
  executor = createActionExecutor(deps);
  return { executor, approvals, writes, boardReads, deliveries, get stored() { return stored; }, get approval() { return approval; },
    get policyReads() { return policyReads; },
    setSetting(value: unknown) { setting = value; },
    setStored(value: typeof stored) { stored = value; },
    setCopyItem(value: SessionSurfaceItemV1) { copyItem = value; },
    show(item: unknown, expectedItemRevision: string | null = null, ctx = context) {
      return executor.execute('session.board.item.upsert', { itemId: 'visual', expectedItemRevision, item }, ctx);
    },
    decide(decision: 'approve' | 'reject') { return executor.execute('approval.request.decide', { artifactId: 'approval', decision },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'account' }); },
  };
}

describe('agent visuals through canonical Action admission', () => {
  it.each(['default', 'explicit'] as const)('honors the host-owned %s policy for an Agent Note and replays an explicit Ask exactly once', async policy => {
    // The live Session host holds its current policy outside invocation context.
    // Use the real resolver, not a stubbed approval verdict.
    const settings = normalizeActionsSettingsV1(policy === 'explicit' ? { v: 1, actions: {
      'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] },
    } } : { v: 1 });
    const host = harness('allowed', {
      isActionApprovalRequired: (id, ctx, input, uiConfirmation, approvedOperation, approvalScope, defaultSafety) =>
        isApprovalRequiredByActionsSettings(id, settings, ctx, defaultSafety, undefined, input, uiConfirmation, undefined, approvedOperation, approvalScope),
    });
    if (policy === 'default') {
      expect(await host.show(note)).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
      expect(host.approvals).toEqual([]);
      expect(host.writes).toHaveLength(1);
      return;
    }
    expect(await host.show(note)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(host.approvals).toHaveLength(1);
    expect(host.stored).toBeNull();
    expect(host.writes).toEqual([]);
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(host.writes).toHaveLength(1);
    expect(host.stored?.item).toMatchObject(note);
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(host.writes).toHaveLength(1);
    expect(host.approvals).toHaveLength(1);
    expect([...host.deliveries.keys()]).toEqual(['approval-result:approval']);
    const delivered = host.deliveries.get('approval-result:approval')!;
    expect(delivered).toMatchObject({ sessionId: 'session', reply: 'none', requestedAction: { kind: 'enqueue' },
      context: { runtimeAccountId: 'account', serverId: 'home', authority: 'account_automation' } });
    expect(JSON.parse(delivered.message)).toMatchObject({ artifactId: 'approval', actionId: 'session.board.item.upsert',
      status: 'executed', execution: { ok: true, result: { result: { outcome: 'created' } } } });
  });

  it('keeps the same visual direct for a present person under the real host policy', async () => {
    const settings = normalizeActionsSettingsV1({ v: 1 });
    const host = harness('allowed', {
      isActionApprovalRequired: (id, ctx, input, uiConfirmation) =>
        isApprovalRequiredByActionsSettings(id, settings, ctx, undefined, undefined, input, uiConfirmation),
    });
    expect(await host.show(note, null, { ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
      .toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(host.approvals).toEqual([]);
    expect(host.writes).toHaveLength(1);
  });

  it.each(['follow.set', 'session.access.grant.set'] as const)('preserves Approve and Deny for neighboring %s requests', async actionId => {
    const policy = { preset: 'important' as const };
    const grant = { subject: { kind: 'account' as const, accountId: 'recipient' }, accessLevel: 'edit' as const, canApprovePermissions: false };
    const input = actionId === 'follow.set'
      ? { receiver: { kind: 'session', sessionId: 'session' }, source: { kind: 'session', sessionId: 'source' }, policy }
      : { sessionId: 'session', ...grant };
    for (const decision of ['approve', 'reject'] as const) {
      const effects: string[] = [];
      const settings = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } });
      const host = harness('allowed', {
        isActionApprovalRequired: (id, ctx, admitted) => isApprovalRequiredByActionsSettings(id, settings, ctx, undefined, undefined, admitted),
        // HTTP mutation ports are the boundaries; approval construction,
        // decision authority, replay and strict Action outputs remain real.
        sessionFollowAction: async () => { effects.push('follow'); return { changed: true, source: {
          destinationSessionId: 'session', sourceSessionId: 'source', policy, deliveryState: 'eligible', hasPendingUpdates: false,
        } }; },
        sessionAccessAction: async () => { effects.push('grant'); return { changed: true, grant }; },
      });
      expect(await host.executor.execute(actionId, input, context)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(host.approvals).toHaveLength(1);
      expect(effects).toEqual([]);
      expect(await host.decide(decision)).toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'executed' : 'rejected' } });
      expect(effects).toHaveLength(decision === 'approve' ? 1 : 0);
      expect(host.approvals).toHaveLength(1);
    }
  });

  it('applies reversible present-user visual edits directly and requires native review for an explicit Ask', async () => {
    const ui = { ...context, surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const host = harness();
    expect(await host.show(note, null, ui)).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(host.approval).toBeNull();
    expect(await host.show({ ...note, title: 'Updated' }, revision, ui))
      .toMatchObject({ ok: true, result: { result: { outcome: 'updated' } } });
    expect(host.approval).toBeNull();
    expect(host.approval).toBeNull();
    expect(host.boardReads).toEqual([]);
    const ask = harness();
    expect(await ask.show(note, null, { ...ui, actionsSettings: normalizeActionsSettingsV1({ v: 1,
      actions: { 'session.board.item.upsert': { approvalRequiredSurfaces: ['ui'] } },
    }) })).toEqual({ ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required', requestId: 'show' });
    expect(ask.approvals).toEqual([]);
    expect(ask.writes).toEqual([]);
  });
  it.each(['ui', 'agent'] as const)('asks for own-Session capability expansion and copies on %s, but honors the generic waiver', async surface => {
    const caller = surface === 'ui'
      ? { ...context, surface, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } }
      : context;
    const cases = [
      { prior: html({}), next: html({ network: 'open' }) },
      { prior: html({ networkOrigins: ['https://one.example.com'] }),
        next: html({ networkOrigins: ['https://one.example.com', 'https://two.example.com'] }) },
      { prior: html({}), next: html({ actions: ['session.board.get'], hostMethods: ['executeAction'] }) },
      { prior: null, next: null },
    ];
    for (const testCase of cases) {
      for (const waived of [false, true]) {
        const actionsSettings = normalizeActionsSettingsV1({ v: 1,
          ...(waived ? { approvalWaivedSurfaces: { 'session.board.item.upsert': [surface] } } : {}) });
        // The host supplies the same Account policy to automation admission and
        // native UI review; both keep the canonical consequence decision real.
        const host = harness('allowed', { isActionApprovalRequired: (id, ctx, input, uiConfirmation, approvedOperation, approvalScope, defaultSafety) =>
          isApprovalRequiredByActionsSettings(id, actionsSettings, ctx, defaultSafety, undefined, input, uiConfirmation, undefined, approvedOperation, approvalScope) });
        const invocation = { ...caller, actionsSettings };
        if (testCase.prior) host.setStored({ item: SessionSurfaceItemV1Schema.parse(testCase.prior), revision });
        else host.setCopyItem(SessionSurfaceItemV1Schema.parse(html({ network: 'open' })));
        const result = testCase.next
          ? await host.show(testCase.next, revision, invocation)
          : await host.executor.execute('session.board.item.upsert', { itemId: 'visual', destination: 'transcript',
            expectedItemRevision: null, copySource: { serverId: 'home', sessionId: 'source', itemId: 'visual', expectedItemRevision: revision } },
          invocation);
        expect(result, JSON.stringify({ surface, waived, testCase })).toMatchObject(waived
          ? { ok: true, result: { result: { outcome: testCase.next ? 'updated' : 'created' } } }
          : surface === 'ui'
            ? { ok: false, errorCode: 'action_interactive_review_required', requestId: 'show' }
            : { ok: true, result: { kind: 'approval_request_created' } });
        expect(host.approvals).toHaveLength(!waived && surface === 'agent' ? 1 : 0);
        expect(host.writes).toHaveLength(waived ? 1 : 0);
        expect(host.boardReads).toEqual([{ sessionId: testCase.next ? 'session' : 'source', itemIds: ['visual'] }]);
      }
    }
  });

  it('keeps same or narrower present-user capabilities direct without widening host Actions', async () => {
    const ui = { ...context, surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const host = harness();
    host.setStored({ item: SessionSurfaceItemV1Schema.parse(html({ network: 'open', actions: ['session.board.get'], hostMethods: ['executeAction'] })), revision });
    for (const next of [html({ network: 'open', actions: ['session.board.get'], hostMethods: ['executeAction'] }),
      html({ networkOrigins: ['https://one.example.com'], actions: ['session.board.get'], hostMethods: ['executeAction'] }), html({})]) {
      expect(await host.show(next, revision, ui)).toMatchObject({ ok: true, result: { result: { outcome: 'updated' } } });
    }
    expect(host.approvals).toEqual([]);
    expect(host.writes).toHaveLength(3);
    expect(host.boardReads).toHaveLength(2);
  });
  it.each(['hostedHtml', 'inlineHtmlWidget'] as const)('refuses unrenderable %s before asking for approval', async kind => {
    const host = harness('ask');
    const source = { v: 1, entrypoint: 'index.html', files: {
      'index.html': { mime: 'text/html', contentBase64: Buffer.from('<script src="missing.js"></script>').toString('base64') },
    } };
    const content = kind === 'hostedHtml' ? { ...note, source: { kind, source, requestedCapabilities: { network: 'open' } } }
      : { ...note, source: { kind: 'widget', instance: { v: 1, id: 'visual', bindings: {}, definition: { kind: 'inline', definition: {
        v: 1, id: 'definition', name: 'HTML', body: { kind: 'html', source, requestedCapabilities: { network: 'open' } },
        inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, provenance: { source: { kind: 'authored' } },
      } } } } };
    expect(await host.show(content)).toMatchObject({ ok: false, errorCode: 'invalid_parameters',
      details: { reason: 'source_invalid' } });
    expect(host.approval).toBeNull();
    expect(host.stored).toBeNull();
  });
  it('uses the Account default for absent data, asks for malformed data, and preserves host admission', async () => {
    const defaultHost = harness(); defaultHost.setSetting(undefined);
    expect(await defaultHost.show(html({ network: 'open' }))).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(defaultHost.approvals).toEqual([]);
    expect(await harness('invalid').show(html({ network: 'open' }))).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await harness().show(note, null, { ...context, bypassApprovals: true })).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
  });
  it.each(['allowed', 'ask', 'off'] as const)('%s admits none, exact and open at creation with the stored effect', async setting => {
    for (const request of [{}, { networkOrigins: ['https://cdn.example.com'] }, { network: 'open' }]) {
      const host = harness(setting);
      const declared = normalizeUiSurfaceCapabilityRequestV1(request)!;
      const networkRequested = declared.networkOrigins.length > 0 || 'network' in request && request.network === 'open';
      const result = await host.show(html(request));
      const asks = setting === 'ask' && networkRequested;
      expect(result).toMatchObject(asks ? { ok: true, result: { kind: 'approval_request_created' } }
        : { ok: true, result: { result: { outcome: 'created' } } });
      if (asks) {
        expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({
          title: 'Network', value: declared.network === 'open' ? 'Any site' : `Only ${declared.networkOrigins.join(', ')}`,
        }));
        expect(host.stored).toBeNull();
        expect(await host.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      } else expect(host.approvals).toEqual([]);
      expect(host.stored?.item.source.kind).toBe('hostedHtml');
      const source = host.stored?.item.source;
      expect(source?.kind === 'hostedHtml' && normalizeUiSurfaceCapabilityRequestV1(source.requestedCapabilities))
        .toMatchObject(setting === 'off' ? { networkOrigins: [], network: 'none' } : declared);
      if (setting === 'off' && networkRequested) expect(result).toMatchObject({ result: {
        effectiveNetwork: { network: 'none', networkOrigins: [] }, notices: [{ code: 'agent_html_network_off' }] } });
      else if (!asks && result.ok) expect(result.result).not.toHaveProperty('notices');
    }
  });

  it.each(['host_action', 'stricter_policy'] as const)('replays the exact admitted off-policy consequence for %s after the Account setting changes', async reason => {
    const item = html({ network: 'open', ...(reason === 'host_action'
      ? { actions: ['session.board.get'], hostMethods: ['executeAction'] } : {}) });
    const approvalContext = reason === 'stricter_policy' ? { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] },
      } }),
    } : context;
    const host = harness('off');
    expect(await host.show(item, null, approvalContext)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(host.approval?.actionArgs).toMatchObject({
      item: { source: { requestedCapabilities: { network: 'none', networkOrigins: [] } } } });
    expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({
      title: 'Network', value: 'No network access',
    }));
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed', execution: {
      ok: true, result: { effectiveNetwork: { network: 'none', networkOrigins: [] } },
    } } });
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none', networkOrigins: [] } });

    const changed = harness('off');
    await changed.show(item, null, approvalContext);
    const admittedPolicyReads = changed.policyReads;
    changed.setSetting('allowed');
    expect(await changed.decide('approve')).toMatchObject({ ok: true, result: {
      status: 'executed', execution: { ok: true },
    } });
    expect(changed.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none', networkOrigins: [] } });
    expect(changed.policyReads).toBe(admittedPolicyReads);
  });

  it('allows own Session Notes and resumed reversible updates by default', async () => {
    const host = harness();
    expect(await host.show(note)).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(await host.show({ ...note, title: 'Updated' }, revision, { ...context, actionRequestId: 'resumed' }))
      .toMatchObject({ ok: true, result: { result: { outcome: 'updated' } } });
    expect(host.approvals).toEqual([]);
    expect(host.stored?.item.title).toBe('Updated');
  });

  it('honors Allowed and Blocked from the host policy for the same Agent visual', async () => {
    for (const enabled of [true, false]) {
      const settings = normalizeActionsSettingsV1({ v: 1,
        actions: { 'session.board.item.upsert': { enabled } },
        approvalWaivedSurfaces: { 'session.board.item.upsert': ['agent'] },
      });
      const host = harness('allowed', {
        isActionEnabled: (id, ctx) => isActionEnabledByActionsSettings(id, settings, ctx),
        isActionApprovalRequired: (id, ctx, input) => isApprovalRequiredByActionsSettings(id, settings, ctx, undefined, undefined, input),
      });
      expect(await host.show(note)).toMatchObject(enabled
        ? { ok: true, result: { result: { outcome: 'created' } } }
        : { ok: false, errorCode: 'action_disabled' });
      expect(host.approvals).toEqual([]);
      expect(host.writes).toHaveLength(enabled ? 1 : 0);
    }
  });

  it('asks for any existing network change and host Actions, while rejection leaves content untouched', async () => {
    const host = harness(); await host.show(html({}));
    expect(await host.show(html({ network: 'open' }), revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({ title: 'Network', value: 'Any site' }));
    await host.decide('reject');
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none' } });
    const actionHost = harness();
    expect(await actionHost.show(html({ actions: ['session.board.get'], hostMethods: ['executeAction'] })))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  });

  it('asks by default for changed network and honors an explicit generic Action waiver', async () => {
    const host = harness();
    await host.show(html({ network: 'none' }));
    host.setSetting('off');
    expect(await host.show(html({ network: 'open' }), revision))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({ title: 'Network', value: 'Any site' }));
    await host.decide('reject');
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none' } });
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'session.board.item.upsert': ['agent'] } });
    expect(await host.show(html({ network: 'open' }), revision, { ...context, actionsSettings }))
      .toMatchObject({ ok: true, result: { result: { outcome: 'updated' }, effectiveNetwork: { network: 'open' } } });
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'open' } });
  });

  it('keeps Ask network creation approval when the generic Action is explicitly Allowed', async () => {
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'session.board.item.upsert': ['agent'] } });
    const noNetwork = harness('ask');
    expect(await noNetwork.show(html({}), null, { ...context, actionsSettings }))
      .toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(noNetwork.approval).toBeNull();

    for (const [request, label] of [
      [{ networkOrigins: ['https://httpbin.org'] }, 'Only https://httpbin.org'],
      [{ network: 'open' }, 'Any site'],
    ] as const) {
      const requestedNetwork = harness('ask');
      expect(await requestedNetwork.show(html(request), null, { ...context, actionsSettings }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(requestedNetwork.stored).toBeNull();
      expect(describeApprovalRequestFields(requestedNetwork.approval!).rows)
        .toContainEqual(expect.objectContaining({ title: 'Network', value: label }));
    }
  });

  it.each(['installed', 'inline'] as const)('retains %s renderer admission and requires native review before switching an existing explicit override to inheritance', async kind => {
    const surface = { pluginId: 'acme.visuals', localId: 'report' };
    const installed = SessionSurfaceItemV1Schema.parse({ ...note, source: { kind: 'widget', instance: {
      v: 1, id: 'visual', definition: kind === 'installed' ? { kind, surface } : { kind, definition: {
        v: 1, id: 'definition', name: 'Report', body: { kind: 'installed', surface },
        inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, provenance: { source: { kind: 'authored' } },
      } }, bindings: {},
    } } });
    const host = harness('allowed', {
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      // Installed plugin descriptor and viewer selection are host boundaries;
      // the real widget input resolver and Action admission remain in use.
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false } }), readContext: async () => ({}),
        readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    const created = await host.show(installed);
    expect(created).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(host.stored?.item.source).toEqual(installed.source);
    expect(created).toMatchObject({ ok: true });
    if (created.ok) expect(created.result).not.toHaveProperty('effectiveNetwork');
    const explicitNone = SessionSurfaceItemV1Schema.parse({ ...installed, source: { ...installed.source,
      instance: { ...(installed.source.kind === 'widget' ? installed.source.instance : {}), networkOverride: { network: 'none' } } } });
    expect(await host.show(explicitNone, revision)).toMatchObject({ ok: true, result: { result: { outcome: 'updated' } } });
    expect(host.stored?.item.source).toMatchObject({ instance: { networkOverride: { network: 'none' } } });
    expect(await host.show(installed, revision, { ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
      .toEqual({ ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required', requestId: 'show' });
    expect(host.approvals).toEqual([]);
    expect(host.writes).toHaveLength(2);
    expect(host.stored?.item.source).toMatchObject({ instance: { networkOverride: { network: 'none' } } });
  });

  it('refuses caller-authored attribution and uses the host-bound Session without a new caller classifier', async () => {
    const host = harness();
    expect(await host.show({ ...note, creator: { kind: 'session', sessionId: 'session' } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(host.stored).toBeNull();
    expect(await host.show(note, null, { ...context, actionCaller: undefined }))
      .toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(host.stored?.item).toMatchObject(note);
  });

  it('admits a promoted inline HTML copy with its stored network choice and asks before changing it', async () => {
    const bundle = html({}).source.source;
    const definition = { v: 1, id: 'saved', name: 'Saved HTML', body: { kind: 'html', source: bundle,
      requestedCapabilities: { network: 'open' } }, networkOverride: { network: 'none' }, inputs: { fields: [] },
      inputSchema: { type: 'object', additionalProperties: false }, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      provenance: { source: { kind: 'authored' } } };
    const item = { ...note, source: { kind: 'widget', instance: { v: 1, id: 'visual',
      definition: { kind: 'inline', definition }, bindings: {} } } };
    const host = harness('allowed', {
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async request => request.instance.definition.kind === 'inline'
        ? request.instance.definition.definition : null,
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    expect(await host.show(item)).toMatchObject({ ok: true, result: { effectiveNetwork: { network: 'none' } } });
    expect(host.stored?.item.source).toMatchObject({ instance: { networkOverride: { network: 'none' } } });
    expect(await host.show({ ...item, source: { ...item.source, instance: { ...item.source.instance,
      networkOverride: { network: 'open' } } } }, revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  });

  it('uses the item revision when installed inheritance changes after review', async () => {
    const installed = SessionSurfaceItemV1Schema.parse({ ...note, source: { kind: 'widget', instance: {
      v: 1, id: 'visual', definition: { kind: 'installed', surface: { pluginId: 'acme.visuals', localId: 'report' } }, bindings: {},
    } } });
    const explicitNone = SessionSurfaceItemV1Schema.parse({ ...installed, source: { ...installed.source,
      instance: { ...(installed.source.kind === 'widget' ? installed.source.instance : {}), networkOverride: { network: 'none' } } } });
    const host = harness();
    host.setStored({ item: explicitNone, revision });
    expect(await host.show(installed, revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    host.setStored({ item: installed, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAg' });
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: {
      status: 'failed', execution: { ok: false, errorCode: 'session_board_revision_conflict' } } });
    expect(host.stored?.item).toEqual(installed);
  });

  it('preserves existing effective egress when the Account default changes and directly narrows it', async () => {
    const host = harness(); await host.show(html({ network: 'open' })); host.setSetting('off');
    expect(await host.show({ ...html({ network: 'open' }), title: 'Continued' }, revision))
      .toMatchObject({ ok: true, result: { result: { outcome: 'updated' }, effectiveNetwork: { network: 'open' } } });
    expect(await host.show(html({ network: 'none' }), revision)).toMatchObject({ ok: true, result: { result: { outcome: 'updated' }, effectiveNetwork: { network: 'none' } } });
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none' } });
    expect(host.approvals).toEqual([]);
  });

  it('fails closed with a typed result when the exact Account policy cannot be read', async () => {
    let mutationRan = false;
    const executor = createActionExecutor({ readAgentHtmlNetworkPolicy: async () => { throw new Error('ACCOUNT_TRANSPORT_PRIVATE'); },
      sessionBoardAction: async () => { mutationRan = true; return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' }; } });
    const result = await executor.execute('session.board.item.upsert', { itemId: 'visual', expectedItemRevision: null,
      item: html({ network: 'open' }) }, context);
    expect(result).toEqual({ ok: false, errorCode: 'action_failed', error: 'action_failed', requestId: 'show' });
    expect(mutationRan).toBe(false);
  });

  it('does not write after cancellation while reading admission policy', async () => {
    const controller = new AbortController();
    let mutationRan = false;
    const executor = createActionExecutor({ readAgentHtmlNetworkPolicy: async () => { controller.abort(); return 'allowed'; },
      sessionBoardAction: async () => { mutationRan = true; return { v: 1, serverId: 'home', sessionId: 'session',
        itemDestination: 'transcript', destination: null,
        result: { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision } }; } });
    expect(await executor.execute('session.board.item.upsert', { itemId: 'visual', expectedItemRevision: null,
      item: html({ network: 'open' }) }, { ...context, signal: controller.signal }))
      .toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled', requestId: 'show' });
    expect(mutationRan).toBe(false);
  });

  it.each(['allowed', 'off'] as const)('keeps prepared %s input and consequences when the Account preference changes', async setting => {
    const host = harness(setting);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.board.item.upsert': ['agent'] } });
    const prepared = await host.executor.prepare('session.board.item.upsert', { itemId: 'visual', expectedItemRevision: null, item: html({ network: 'open' }) }, { ...context, actionsSettings });
    expect(prepared.kind).toBe('ready'); host.setSetting(setting === 'off' ? 'allowed' : 'off');
    if (prepared.kind === 'ready') expect(await prepared.invocation.run()).toMatchObject({ ok: true,
      ...(setting === 'off' ? { result: { notices: [{ code: 'agent_html_network_off' }] } } : {}) });
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: setting === 'off' ? 'none' : 'open' } });
    expect(host.policyReads).toBe(1);
    const pending = harness('ask'); await pending.show(html({ network: 'open' })); pending.setSetting('allowed');
    await pending.decide('approve'); expect(pending.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'open' } });
  });

  it('refuses a pending update after the domain item revision changes', async () => {
    const host = harness(); await host.show(html({}));
    await host.show(html({ network: 'open' }), revision);
    const current = host.stored!;
    host.setStored({ ...current, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAg' });
    const changed = host.stored;
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'session_board_revision_conflict' } } });
    expect(host.stored).toEqual(changed);
  });
});
