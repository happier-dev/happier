import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installBugReportHooksCommonModuleMocks } from './bugReportHooksTestHelpers';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { BugReportSubmitOutputSchema, type BugReportDraftInput } from '@happier-dev/protocol/actions/specs/bugReport';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { persistPreRestartBugReportSnapshot, peekPreRestartBugReportSnapshot } from '@/utils/system/preRestartBugReportSnapshot';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
  .createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(socket => {
  configureConnectedServerSocketBoundary(socket);
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockResolvedValue({ ok: true, result: {} });
});

const alerts = vi.fn(async () => {});
const confirms = vi.fn(async () => false);
const back = vi.fn();
installBugReportHooksCommonModuleMocks({
  modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert: alerts, confirm: confirms } }).module,
  router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { back, push: vi.fn() } }).module,
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

await import('@/sync/domains/state/storage');
const { useBugReportComposerSubmit } = await import('./useBugReportComposerSubmit');
const { useBugReportComposerModel } = await import('./useBugReportComposerModel');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const feature = { enabled: true, providerUrl: 'https://reports.example.test', defaultIncludeDiagnostics: true,
  maxArtifactBytes: 128_000, acceptedArtifactKinds: ['user-note'], uploadTimeoutMs: 10_000, contextWindowMs: 30_000 };
const draft: BugReportDraftInput = { currentBehavior: 'Edited exception after review', title: 'Crash in private-project-q7z4', summary: 'Confidential steps n3k8.', reproductionStepsText: '1. Open app',
  whatChangedRecently: '', environment: { appVersion: '0.3', platform: 'web', deploymentType: 'self-hosted' },
  includeDiagnostics: false, acceptedPrivacyNotice: false };
const snapshot = {
  v: 1, createdAtMs: Date.now(), reason: 'crash', platform: 'web', origin: 'https://reports-home.example.test',
  isSecureContext: true, errorDetails: 'Private crash details', appLogs: 'Private log line', userActions: [],
} as const;
let serverId: string;
let locks: ReturnType<typeof installWebLockManagerMock>;
let serviceUnavailable = false;
const reportRequests: { path: string; body: unknown }[] = [];
const fetchReport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== feature.providerUrl) return homes.request(input, init);
  reportRequests.push({ path: url.pathname, body: url.pathname.startsWith('/uploads/') ? String(init?.body ?? '') : init?.body ? JSON.parse(String(init.body)) : null });
  if (url.pathname.startsWith('/uploads/')) return new Response('', { status: 200 });
  if (url.pathname === '/v1/issues/similar') return new Response(JSON.stringify({ issues: [] }), { status: 200 });
  if (serviceUnavailable) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
  return new Response(JSON.stringify(url.pathname === '/v1/reports/session'
    ? { reportId: 'report-1', uploadTargets: (JSON.parse(String(init?.body)).artifacts ?? []).map((_artifact: unknown, index: number) => ({ artifactId: `artifact-${index}`, objectKey: `object-${index}`, uploadUrl: `${feature.providerUrl}/uploads/${index}` })) }
    : { reportId: 'report-1', issueNumber: 123, issueUrl: 'https://github.com/happier-dev/happier/issues/123' }),
  { status: 200, headers: { 'content-type': 'application/json' } });
});

function Composer({ value = draft, providerEnabled = true, collectDiagnosticsArtifacts, sessionTarget }: {
  value?: BugReportDraftInput; providerEnabled?: boolean;
  sessionTarget?: { sessionId: string; serverId: string; accountId: string | null };
  collectDiagnosticsArtifacts?: () => Promise<{ artifacts: Array<{ filename: string; sourceKind: string; contentType: string; content: string }>; environment: BugReportDraftInput['environment'] }>;
}) {
  const { handleSubmit, submitting } = useBugReportComposerSubmit({
    feature: { ...feature, enabled: providerEnabled }, route: '/settings/report-issue', includeDiagnostics: value.includeDiagnostics, diagnosticsKinds: ['user-note'],
    issueOwner: 'happier-dev', issueRepo: 'happier', existingIssueNumber: null,
    openFallbackIssue: async () => { throw new Error('Unexpected fallback'); }, buildDraftInput: () => value,
    collectDiagnosticsArtifacts, sessionTarget,
  });
  return React.createElement('Text', { testID: 'submit', onPress: handleSubmit, submitting });
}

function ModelComposer() {
  const model = useBugReportComposerModel({
    feature, machines: [], profile: null, serverUrlDefault: 'https://reports-home.example.test', route: '/settings/report-issue',
  });
  return React.createElement('Text', { testID: 'model', model });
}

async function approveSubmit(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const created = new Promise<void>(resolve => homes.artifacts(serverId).afterNextCreate(async () => { resolve(); }));
  let pending: Promise<void> = Promise.resolve();
  await act(async () => { pending = screen.findByTestId('submit')!.props.onPress(); });
  expect(await Promise.race([created.then(() => 'approval'), pending.then(() => 'settled')])).toBe('approval');
  const artifact = homes.artifacts(serverId).list()[0]!;
  await waitForHomeGovernance(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id)).toBe(1));
  const request = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!));
  await act(async () => {
    await getSharedBlockingApprovalCoordinator().resolveBlockingDecision({
      artifactId: artifact.id, request, decision: 'approve', decisionAuthority: 'present_user',
    });
    await pending;
  });
}

describe('bug report Submit form through Action admission', () => {
  beforeEach(async () => {
    locks = installWebLockManagerMock();
    await homes.reset();
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    alerts.mockClear(); confirms.mockClear(); back.mockClear(); fetchReport.mockClear();
    reportRequests.length = 0;
    serviceUnavailable = false;
    vi.stubGlobal('fetch', fetchReport);
    // The report checkbox does not alter the independently opted-out crash
    // reporting boundary. Its separate consent owner is exercised unchanged.
    globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__ = true;
    serverId = await homes.addHome({ name: 'Reports Home', serverUrl: 'https://reports-home.example.test',
      accountId: 'reporter', serverIdentityId: 'srv_reports_home', currentAccount: true });
    const features = createRootLayoutFeaturesResponse({ capabilities: { bugReports: feature,
      serverIdentity: { serverIdentityId: 'srv_reports_home' } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    await homes.requireUiApproval(serverId, 'bugreport.submit');
    homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
    const token = homes.findByServerUrl('https://reports-home.example.test')?.token;
    if (!token) throw new Error('Expected reporter credential fixture');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token });
  });
  afterEach(async () => {
    getSharedBlockingApprovalCoordinator().dispose();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await homes.reset();
    delete globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__;
    vi.unstubAllGlobals();
    locks.restore();
  });

  it.each(['approve', 'reject'] as const)('keeps Submit pending without service writes and respects %s', async decision => {
    await persistPreRestartBugReportSnapshot(snapshot);
    await expect(peekPreRestartBugReportSnapshot()).resolves.toEqual(snapshot);
    const screen = await renderScreen(React.createElement(Composer));
    const created = new Promise<void>(resolve => homes.artifacts(serverId).afterNextCreate(async () => { resolve(); }));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => { pending = screen.findByTestId('submit')!.props.onPress(); });
    const admission = await Promise.race([
      created.then(() => ({ phase: 'approval' as const, alerts: [] })),
      pending.then(() => ({ phase: 'settled' as const, alerts: alerts.mock.calls })),
    ]);
    expect(admission).toEqual({ phase: 'approval', alerts: [] });
    await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
    const artifact = homes.artifacts(serverId).list()[0]!;
    const storedApproval = homes.artifacts(serverId).readPlainBody(artifact.id)!;
    const request = ApprovalRequestSchema.parse(JSON.parse(storedApproval));
    await waitForHomeGovernance(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id)).toBe(1));
    expect(reportRequests).toEqual([]);
    expect(back).not.toHaveBeenCalled();
    await expect(peekPreRestartBugReportSnapshot()).resolves.toEqual(snapshot);
    expect(screen.findByTestId('submit')!.props.submitting).toBe(true);
    expect(request.actionArgs).toMatchObject({ draft: { acceptedPrivacyNotice: false },
      destination: { providerUrl: feature.providerUrl, issueOwner: 'happier-dev', issueRepo: 'happier' } });
    expect(request.actionArgs).not.toHaveProperty('draft.title');
    expect(request.actionArgs).not.toHaveProperty('draft.summary');
    expect(storedApproval).not.toContain(draft.title);
    expect(storedApproval).not.toContain(draft.summary);
    await act(async () => {
      const result = await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: artifact.id, decision },
        { surface: 'ui', serverId });
      expect(result.ok).toBe(true);
      await pending;
    });
    if (decision === 'approve') {
      expect(reportRequests).toEqual([
        { path: '/v1/reports/session', body: expect.objectContaining({ form: expect.objectContaining({ title: draft.title,
          reproductionSteps: ['Open app'], consent: { includeDiagnostics: false, acceptedPrivacyNotice: true } }), artifacts: [] }) },
        { path: '/v1/reports/submit', body: expect.objectContaining({ reportId: 'report-1', issue: { owner: 'happier-dev', repo: 'happier' } }) },
      ]);
      expect(reportRequests[0]).toMatchObject({ body: { form: { currentBehavior: draft.currentBehavior } } });
      expect(JSON.stringify(reportRequests)).not.toContain(snapshot.errorDetails);
      await expect(peekPreRestartBugReportSnapshot()).resolves.toBeNull();
      expect(back).toHaveBeenCalledOnce();
    } else {
      expect(reportRequests).toEqual([]);
      expect(confirms).not.toHaveBeenCalled();
      expect(back).not.toHaveBeenCalled();
      await expect(peekPreRestartBugReportSnapshot()).resolves.toEqual(snapshot);
    }
    await screen.unmount();
  });

  it('uses the default Action review for diagnostics without imposing a second acknowledgement floor', async () => {
    await persistPreRestartBugReportSnapshot(snapshot);
    await expect(peekPreRestartBugReportSnapshot()).resolves.toEqual(snapshot);
    const screen = await renderScreen(React.createElement(Composer, { value: { ...draft, includeDiagnostics: true, acceptedPrivacyNotice: false } }));
    let pending: Promise<void> = Promise.resolve();
    try {
      const created = new Promise<void>(resolve => homes.artifacts(serverId).afterNextCreate(async () => { resolve(); }));
      await act(async () => { pending = screen.findByTestId('submit')!.props.onPress(); });
      expect(await Promise.race([created.then(() => 'approval'), pending.then(() => 'settled')])).toBe('approval');
      const artifact = homes.artifacts(serverId).list()[0]!;
      await waitForHomeGovernance(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id)).toBe(1));
      expect(reportRequests).toEqual([]);
      const request = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!));
      await act(async () => {
        await getSharedBlockingApprovalCoordinator().resolveBlockingDecision({ artifactId: artifact.id, request,
          decision: 'reject', decisionAuthority: 'present_user' });
        await pending;
      });
      expect(reportRequests).toEqual([]);
      expect(back).not.toHaveBeenCalled();
      await expect(peekPreRestartBugReportSnapshot()).resolves.toEqual(snapshot);
    } finally { getSharedBlockingApprovalCoordinator().dispose(); await pending; await screen.unmount(); }
  });

  it('submits the reviewed diagnostic bytes through approval without collecting again or persisting private content', async () => {
    const artifact = { filename: 'reviewed-note.txt', sourceKind: 'user-note', contentType: 'text/plain', content: 'Reviewed private bytes q72' };
    const collectDiagnosticsArtifacts = vi.fn(async () => ({ artifacts: [artifact], environment: draft.environment }));
    const screen = await renderScreen(<Composer value={{ ...draft, includeDiagnostics: true }} collectDiagnosticsArtifacts={collectDiagnosticsArtifacts} />);
    try {
      expect(collectDiagnosticsArtifacts).not.toHaveBeenCalled();
      await approveSubmit(screen);
      expect(reportRequests).toContainEqual({ path: '/uploads/0', body: artifact.content });
      expect(reportRequests.filter(request => request.path.startsWith('/uploads/'))).toHaveLength(1);
      expect(collectDiagnosticsArtifacts).toHaveBeenCalledOnce();
      const approval = homes.artifacts(serverId).list()[0]!;
      expect(homes.artifacts(serverId).readPlainBody(approval.id)).not.toContain(artifact.content);
      expect(back).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it('submits available reviewed evidence through the current report Account when the related Session account is unknown', async () => {
    const artifact = { filename: 'safe-context.txt', sourceKind: 'user-note', contentType: 'text/plain', content: 'Available context with target diagnostics unavailable' };
    const screen = await renderScreen(<Composer value={{ ...draft, includeDiagnostics: true }}
      sessionTarget={{ sessionId: 'unavailable-session', serverId: 'unavailable-home', accountId: null }}
      collectDiagnosticsArtifacts={async () => ({ artifacts: [artifact], environment: draft.environment })} />);
    try {
      await approveSubmit(screen);
      expect(reportRequests).toContainEqual({ path: '/uploads/0', body: artifact.content });
      expect(back).toHaveBeenCalledOnce();
      expect(fetchReport.mock.calls.some(([input]) => String(input).includes('unavailable-home'))).toBe(false);
    } finally { await screen.unmount(); }
  });

  it('keeps scope failure private without offering a public fallback or submitting another Account', async () => {
    const collectDiagnosticsArtifacts = async () => { throw new Error('bug_report_diagnostics_scope_changed'); };
    const screen = await renderScreen(<Composer value={{ ...draft, includeDiagnostics: true }} collectDiagnosticsArtifacts={collectDiagnosticsArtifacts} />);
    try {
      await act(async () => screen.findByTestId('submit')!.props.onPress());
      expect(reportRequests).toEqual([]);
      expect(homes.artifacts(serverId).list()).toEqual([]);
      expect(confirms).not.toHaveBeenCalled();
      expect(alerts).toHaveBeenCalledWith('bugReports.composer.alerts.submitFailedTitle', 'bugReports.composer.scopeChanged');
      expect(screen.findByTestId('submit')!.props.submitting).toBe(false);
    } finally { await screen.unmount(); }
  });

  it('honors a diagnostic submission waiver at the real submission owner', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'reporter' };
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'bugreport.submit': ['agent'] } });
    const accountSettings = { ...storage.getState().settings, actionsSettingsV1: settings };
    const version = (loadAccountSettings(scope).version ?? 0) + 1;
    storage.getState().applySettingsForScope(scope, accountSettings, version);
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: accountSettings }, version } });
    const produced = await createDefaultActionExecutor().execute('bugreport.submit', {
      draft: { ...draft, includeDiagnostics: true, acceptedPrivacyNotice: false },
      destination: { providerUrl: feature.providerUrl, issueOwner: 'happier-dev', issueRepo: 'happier' },
    }, { surface: 'agent', authority: 'account_automation', serverId });
    expect(produced.ok).toBe(true);
    if (!produced.ok) throw new Error(produced.error);
    expect(BugReportSubmitOutputSchema.parse(produced.result)).toEqual({
      mode: 'submitted', reportId: 'report-1', issueNumber: 123,
      issueUrl: 'https://github.com/happier-dev/happier/issues/123', artifactCount: 0,
    });
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
    expect(reportRequests[0]).toMatchObject({ path: '/v1/reports/session', body: {
      form: { consent: { includeDiagnostics: true, acceptedPrivacyNotice: true } },
    } });
  });

  it('retains the original crash and exits submitting when the approved service request fails', async () => {
    await persistPreRestartBugReportSnapshot(snapshot);
    serviceUnavailable = true;
    const screen = await renderScreen(React.createElement(Composer));
    try {
      await approveSubmit(screen);
      expect(reportRequests).toHaveLength(1);
      expect(reportRequests[0]).toMatchObject({ path: '/v1/reports/session', body: { form: { currentBehavior: draft.currentBehavior } } });
      expect(JSON.stringify(reportRequests)).not.toContain(snapshot.errorDetails);
      await expect(peekPreRestartBugReportSnapshot()).resolves.toEqual(snapshot);
      expect(back).not.toHaveBeenCalled();
      expect(confirms).toHaveBeenCalledOnce();
      expect(screen.findByTestId('submit')!.props.submitting).toBe(false);
    } finally { await screen.unmount(); }
  });

  it('retains the original crash when the approved provider-disabled fallback only opens a manual issue', async () => {
    const { Linking } = await import('react-native');
    const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const features = createRootLayoutFeaturesResponse({
      features: { bugReports: { enabled: false } },
      capabilities: { bugReports: feature, serverIdentity: { serverIdentityId: 'srv_reports_home' } },
    });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    await persistPreRestartBugReportSnapshot(snapshot);
    const screen = await renderScreen(React.createElement(Composer, { providerEnabled: false }));
    try {
      await approveSubmit(screen);
      expect(reportRequests).toEqual([]);
      expect(open).toHaveBeenCalledOnce();
      expect(String(open.mock.calls[0]?.[0])).toContain('/issues/new');
      expect(decodeURIComponent(String(open.mock.calls[0]?.[0]))).not.toContain(snapshot.errorDetails);
      await expect(peekPreRestartBugReportSnapshot()).resolves.toEqual(snapshot);
      expect(back).not.toHaveBeenCalled();
      expect(screen.findByTestId('submit')!.props.submitting).toBe(false);
    } finally { open.mockRestore(); await screen.unmount(); }
  });

  it('keeps captured and discarded crash text off automatic similar-issue requests while ordinary search still works', async () => {
    await persistPreRestartBugReportSnapshot(snapshot);
    const screen = await renderScreen(React.createElement(ModelComposer));
    const model = () => screen.findByTestId('model')!.props.model as ReturnType<typeof useBugReportComposerModel>;
    try {
      expect(model().crashReportStatus).toBe('saved');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
      expect(reportRequests).toEqual([]);
      await act(async () => model().setCurrentBehavior('Exception reviewed for a private project'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
      expect(reportRequests).toEqual([]);
      await act(async () => model().discardSavedCrash());
      expect(model().crashReportStatus).toBe('discarded');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
      expect(reportRequests).toEqual([]);
    } finally { await screen.unmount(); }

    const ordinary = await renderScreen(React.createElement(ModelComposer));
    try {
      const getModel = () => ordinary.findByTestId('model')!.props.model as ReturnType<typeof useBugReportComposerModel>;
      expect(getModel().crashReportStatus).toBe('none');
      await act(async () => getModel().setTitle('Ordinary independently written report'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
      expect(reportRequests.map(request => request.path)).toEqual(['/v1/issues/similar']);
    } finally { await ordinary.unmount(); }
  });

});
