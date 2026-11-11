import { describe, expect, it } from 'vitest';

import { ActivityWebhookPayloadV1Schema, buildActivityWebhookPayload, MachineVitalsPushRoutingDataV1Schema,
  buildGuardStopWarningPushDataV1, GuardStopWarningPushDataV1Schema, readGuardStopWarningPushActionV1,
  isGuardStopWarningCurrentV1 } from './webhookPayload.js';
import { readUsageNoticeArtifactV1, readAccountNoticeArtifactV1, readAccountNoticeArtifactHeaderV1, AccountNoticeArtifactHeaderV1Schema,
  AccountNoticePushDataV1Schema, projectAccountNoticeInboxItemV1,
  readOwnedNoticeArtifactAdmissionV1, readOwnedNoticeArtifactV1 } from './usageNoticeArtifactV1.js';
import { MachineServiceIdentityV1Schema } from '../local/services/serviceIdentityV1.js';
import { MachineServiceRowV1Schema } from '../actions/specs/machine/services.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { buildSessionStopHoldV1, resolveSessionAutoResumeAdmissionV1 } from '../sessions/metadata/sessionExplicitStopV1.js';

describe('private Account notices', () => {
  it('settles only positively identified private retired sources without admitting them as current notices', () => {
    const content = { v: 1, type: 'update', resolved: false, source: { kind: 'host', topic: 'follow_update' },
      notice: { topic: 'follow_update', follow: { original: { source: { kind: 'workflow_run', runId: 'held' }, revision: 1 },
        event: { kind: 'update_posted' } } } };
    const header = { ...content, kind: 'account_notice.v1', title: 'Run updated', status: 'open' };
    const artifact = { ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', header, body: JSON.stringify(content) };
    expect(readOwnedNoticeArtifactAdmissionV1(artifact, 'owner')).toEqual({ kind: 'retired' });
    expect(readOwnedNoticeArtifactV1(artifact, 'owner')).toBeNull();
    for (const body of [undefined, '{', '{}', JSON.stringify({ ...content, resolved: true }),
      JSON.stringify({ ...content, source: { kind: 'host', topic: 'unknown' } })]) {
      expect(readOwnedNoticeArtifactAdmissionV1({ ...artifact, body }, 'owner')).toEqual({ kind: 'unreadable' });
    }
    expect(readOwnedNoticeArtifactAdmissionV1(artifact, 'foreign')).toEqual({ kind: 'unreadable' });
    expect(readOwnedNoticeArtifactAdmissionV1({ ...artifact, publicAudience: 'retained' }, 'owner')).toEqual({ kind: 'unreadable' });
    expect(readOwnedNoticeArtifactAdmissionV1({ ...artifact, header: { ...header,
      source: { kind: 'host', topic: 'unknown' } } }, 'owner')).toEqual({ kind: 'unreadable' });
  });
  it('round-trips adopted Machine service C1 operands from the canonical list/detail facts', () => {
    const row = MachineServiceRowV1Schema.parse({ authority: 'machine', serviceId: 'watch-a', name: 'Ingress',
      watchId: 'watch-a', watchRevision: 'watch-revision-a', lifecyclePurpose: 'infrastructure',
      generation: 'native-generation-a', state: 'unhealthy',
      capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false } });
    const service = MachineServiceIdentityV1Schema.parse({ kind: 'adopted', machineId: 'machine-a', serviceId: row.serviceId,
      watchId: row.watchId, watchRevision: row.watchRevision });
    const source = { kind: 'host', topic: 'service_health', subject: service };
    const page = { kind: 'host', page: 'machine_service', machine: { serverId: 'home', machineId: 'machine-a' }, service };
    const content = { v: 1, source, page, type: 'update', resolved: false, healthPhase: 'open' };
    const header = { ...content, kind: 'account_notice.v1', title: 'Service unavailable', status: 'open' };
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toEqual(header);
    const push = { v: 1, topic: 'account_notice', accountId: 'owner', artifactId: 'notice', source, page, serverId: 'home' };
    expect(AccountNoticePushDataV1Schema.parse(push)).toEqual(push);
    for (const invalidPage of [
      { ...page, machine: { ...page.machine, machineId: 'foreign-machine' } },
      { ...page, service: { ...service, watchRevision: 'replaced-watch' } },
      { ...page, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' } },
      { ...page, service: { ...service, kind: 'infrastructure' } },
    ]) {
      expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, page: invalidPage }).success).toBe(false);
      expect(AccountNoticePushDataV1Schema.safeParse({ ...push, page: invalidPage }).success).toBe(false);
    }
    for (const actionId of ['deployments.health.read', 'deployments.drift.read', 'deployments.logs.read'] as const) {
      const input = { serverId: 'home', machineId: 'machine-a', environmentId: 'environment', deploymentId: 'deployment',
        targetLinkId: 'runtime', installationId: 'installation', service,
        ...(actionId === 'deployments.drift.read' ? { expectedRevision: 1 } : {}),
        ...(actionId === 'deployments.logs.read' ? { kind: 'runtime' } : {}) };
      expect(getActionSpec(actionId).inputSchema.safeParse(input).success).toBe(false);
      expect(getActionSpec(actionId).inputSchema.safeParse({ ...input, service: {
        kind: 'deployment', machineId: 'machine-a', environmentId: 'environment', environmentInstanceId: 'instance',
        composeService: 'web', serviceId: 'instance/web',
      } }).success).toBe(true);
    }
  });
  it('retains one bounded provider investigation operand without granting routing authority', () => {
    const content = { v: 1, source: { kind: 'plugin', pluginId: 'qa.alerts', itemId: 'source:issue' },
      type: 'update', resolved: false, healthPhase: 'open', body: 'Bounded provider evidence' };
    const header = { ...content, kind: 'account_notice.v1', title: 'Issue', status: 'open' };
    const investigation = { kind: 'alertEntry', entry: {
      entryRef: { source: { pluginId: 'qa.alerts', localId: 'issues' }, kindId: 'issue', collisionScope: 'project', entryId: 'issue-1' },
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
    } };
    const authored = { ...header, investigation };
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse(authored).success).toBe(true);
    expect(readAccountNoticeArtifactV1({ header: authored, body: JSON.stringify({ ...content, investigation }) })).toEqual(authored);
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toEqual(header);
    expect(readAccountNoticeArtifactV1({ header: authored, body: JSON.stringify(content) })).toBeNull();
    for (const invalid of [
      { ...investigation, configuredActionId: 'hidden-profile' },
      { ...investigation, entry: { ...investigation.entry, machineId: 'chosen-machine' } },
      { ...investigation, entry: { ...investigation.entry, sourceInstanceId: 'unbounded-source-routing-token' } },
      { ...investigation, entry: { ...investigation.entry, entryRef: { ...investigation.entry.entryRef,
        source: { pluginId: 'other.plugin', localId: 'issues' } } } },
      { ...investigation, entry: { ...investigation.entry, entryRef: { ...investigation.entry.entryRef,
        entryId: 'x'.repeat(129) } } },
    ]) {
      const invalidHeader = { ...header, investigation: invalid };
      expect(AccountNoticeArtifactHeaderV1Schema.safeParse(invalidHeader).success).toBe(false);
      expect(readAccountNoticeArtifactHeaderV1(invalidHeader)).toBeNull();
      expect(readAccountNoticeArtifactV1({ header: invalidHeader,
        body: JSON.stringify({ ...content, investigation: invalid }) })).toBeNull();
    }
  });

  it('admits explicit plugin health lifecycle while preserving ordinary plugin notices', () => {
    const content = { v: 1, source: { kind: 'plugin', pluginId: 'qa.alerts', itemId: 'source:issue' },
      type: 'update', resolved: false, page: { pageId: 'alerts', subPath: 'issue' } };
    const header = { ...content, kind: 'account_notice.v1', title: 'Issue', status: 'open' };
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toEqual(header);
    for (const healthPhase of ['open', 'recovered']) {
      const health = { ...content, healthPhase };
      const healthHeader = { ...header, healthPhase };
      expect(readAccountNoticeArtifactV1({ header: healthHeader, body: JSON.stringify(health) })).toEqual(healthHeader);
    }
    for (const invalid of [{ healthPhase: 'recovered', type: 'blocked' }, { healthPhase: 'open', resolved: true },
      { healthPhase: 'open', type: 'approval' }]) {
      expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, ...invalid }).success).toBe(false);
    }
  });

  it.each([
    { kind: 'platformTarget', environmentId: 'environment', targetLinkId: 'runtime' },
    { kind: 'environment', environmentId: 'environment', targetLinkId: 'runtime', condition: 'health' },
    { kind: 'environment', environmentId: 'environment', targetLinkId: 'runtime', condition: 'deployment_failed' },
    ...['run', 'verify', 'prune', 'restore'].map(check => ({ kind: 'backup', environmentId: 'environment', check })),
    { kind: 'healthCheck', subject: { kind: 'environment', environmentId: 'environment' }, checkId: 'http' },
    ...['domain_probe_failed', 'certificate_renewal_failed'].map(condition => ({ kind: 'domain',
      environmentId: 'environment', targetLinkId: 'runtime', domainId: 'domain', condition })),
  ])('binds each non-service condition to its Environment page without a Machine: %#', subject => {
    const source = { kind: 'host', topic: 'service_health', subject };
    const page = { kind: 'host', page: 'environment', targetLinkId: 'runtime',
      environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' } };
    const content = { v: 1, source, page, type: 'update', resolved: false, healthPhase: 'open' };
    const header = { ...content, kind: 'account_notice.v1', title: 'Needs attention', status: 'open' };
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toEqual(header);
    const push = { v: 1, topic: 'account_notice', accountId: 'owner', artifactId: 'notice', source, page, serverId: 'home' };
    expect(AccountNoticePushDataV1Schema.parse(push)).toEqual(push);
    for (const invalidPage of [undefined, { ...page, environment: { ...page.environment, environmentId: 'other' } },
      ...('targetLinkId' in subject ? [{ ...page, targetLinkId: 'other' }] : [])]) {
      expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, page: invalidPage }).success).toBe(false);
      expect(AccountNoticePushDataV1Schema.safeParse({ ...push, page: invalidPage }).success).toBe(false);
    }
    expect(AccountNoticePushDataV1Schema.safeParse({ ...push, serverId: 'other' }).success).toBe(false);
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header,
      source: { ...source, subject: { ...subject, deploymentId: 'attempt' } } }).success).toBe(false);
  });

  it('binds a deployed health notice and push to the exact service, Machine and Environment', () => {
    const service = MachineServiceIdentityV1Schema.parse({ kind: 'deployment', machineId: 'machine',
      environmentId: 'environment', environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' });
    const source = { kind: 'host', topic: 'service_health', subject: service };
    const page = { kind: 'host', page: 'machine_service', machine: { serverId: 'home', machineId: 'machine' },
      service, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' } };
    const content = { v: 1, source, page, type: 'blocked', resolved: false, healthPhase: 'open', body: 'Connection refused' };
    const header = { ...content, kind: 'account_notice.v1', title: 'Service unavailable', status: 'open' };
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toEqual(header);
    const admitted = AccountNoticeArtifactHeaderV1Schema.parse(header);
    expect(projectAccountNoticeInboxItemV1({ header: admitted, artifactId: 'notice', serverId: 'home',
      createdAt: 1, pageRoute: '/inbox' })).toMatchObject({ view: 'needs_you' });
    const push = { v: 1, topic: 'account_notice', accountId: 'owner', artifactId: 'notice', source, page, serverId: 'home' };
    expect(AccountNoticePushDataV1Schema.parse(push)).toEqual(push);
    for (const invalidPage of [undefined, { ...page, machine: { ...page.machine, machineId: 'another' } },
      { ...page, service: { ...service, machineId: 'another' } },
      { ...page, environment: { ...page.environment, environmentId: 'another' } },
      { ...page, environment: { ...page.environment, serverId: 'another' } }]) {
      expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, page: invalidPage }).success).toBe(false);
      expect(AccountNoticePushDataV1Schema.safeParse({ ...push, page: invalidPage }).success).toBe(false);
    }
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, healthPhase: undefined }).success).toBe(false);
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, notice: { topic: 'resource_limit' } }).success).toBe(false);
    const check = { kind: 'host', topic: 'service_health', subject: { kind: 'healthCheck',
      subject: { kind: 'machineService', machineId: service.machineId, serviceId: service.serviceId }, checkId: 'http' } };
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, source: check }).success).toBe(true);
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, source: { ...check,
      subject: { ...check.subject, subject: { ...check.subject.subject, serviceId: 'another-service' } } } }).success).toBe(false);
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, source: { ...check,
      subject: { ...check.subject, subject: { ...check.subject.subject, machineId: 'another-machine' } } } }).success).toBe(false);
    expect(AccountNoticePushDataV1Schema.safeParse({ ...push, pluginNotification: { pluginId: 'qa.plugin', categoryId: 'alert',
      occurrenceId: 'occurrence', clientRequestId: 'request' } }).success).toBe(false);
  });

  it('binds the stored body to its plugin source and preserves independent personal state', () => {
    const content = { v: 1, source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' },
      type: 'update', resolved: false, page: { pageId: 'tasks', subPath: 'task-1' }, body: 'Changed' };
    const header = { ...content, kind: 'account_notice.v1', title: 'Task changed', status: 'dismissed', readAt: 123 };
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toEqual(header);
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify({ ...content,
      source: { ...content.source, pluginId: 'another.plugin' } }) })).toBeNull();
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, accountId: 'claimed' }).success).toBe(false);
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, page: { ...content.page, pluginId: 'other' } }).success).toBe(false);
    expect(readAccountNoticeArtifactHeaderV1({ ...header, retiredPresentation: true })).toEqual(header);
    expect(readAccountNoticeArtifactHeaderV1({ ...header, source: { ...content.source, accountId: 'claimed' } })).toBeNull();
    expect(readAccountNoticeArtifactHeaderV1({ ...header, page: { ...content.page, pluginId: 'other' } })).toBeNull();
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify({ ...content, source: { ...content.source, accountId: 'claimed' } }) })).toBeNull();
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify({ ...content, page: { ...content.page, pluginId: 'other' } }) })).toBeNull();
    expect(AccountNoticeArtifactHeaderV1Schema.safeParse({ ...header, page: { pageId: 'tasks', subPath: '../escape' } }).success).toBe(false);
    expect(readAccountNoticeArtifactHeaderV1({ ...header, page: { pageId: 'tasks', subPath: '../escape' } })).toBeNull();
  });
});

describe('guard warning routing and withdrawal', () => {
  it('binds each action and dismissal to the exact Session or terminal occurrence', () => {
    const session = buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'machine',
      sessionId: 'session', rule: 'idle_sessions', stopAt: 300_000 });
    const home = { serverId: 'admitted-home' };
    expect(readGuardStopWarningPushActionV1(session, 'keepRunning', home)).toEqual({
      actionId: 'machines.guard.idleStop.keepRunning', input: { machineId: 'machine', sessionId: 'session', serverId: home.serverId } });
    expect(readGuardStopWarningPushActionV1(session, 'stopNow', home)).toEqual({ actionId: 'session.stop',
      input: { sessionId: 'session', serverId: home.serverId, stopIntent: 'lifecycle_control' } });
    const action = readGuardStopWarningPushActionV1(session, 'stopNow', home);
    if (!action || action.actionId !== 'session.stop') throw new Error('Expected the admitted Session Stop action');
    const hold = buildSessionStopHoldV1({ rawSession: { id: 'session' }, requestId: 'guard-stop', requestedAtMs: 1,
      stopIntent: action.input.stopIntent ?? 'explicit_stop' });
    expect(hold).toEqual({ kind: 'no_hold' });
    expect(resolveSessionAutoResumeAdmissionV1({ metadata: hold.kind === 'hold' ? { sessionExplicitStopV1: hold.stop } : {},
      machineAvailable: true, authorityAvailable: true })).toBe('eligible');
    // @ts-expect-error A JavaScript consumer can violate the required admitted-Home context.
    expect(readGuardStopWarningPushActionV1(session, 'keepRunning', {})).toBeNull();
    const state = { v: 1, kind: 'stopping', rule: 'idle_sessions', stopAt: 300_000 };
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state })).toBe(true);
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state: undefined })).toBe(false);
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state: { ...state, stopAt: 600_000 } })).toBe(false);
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state: { v: 1, kind: 'configured', ceilingBytes: 4096 } })).toBe(false);
    const terminal = buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'machine',
      terminalId: 'terminal', terminalKey: 'shell', rule: 'idle_terminals', stopAt: 300_000 });
    const current = { machineId: 'machine', terminalId: 'terminal', terminalKey: 'shell',
      state: { v: 1, kind: 'stopping', rule: 'idle_terminals', stopAt: 300_000 } };
    expect(isGuardStopWarningCurrentV1(terminal, current)).toBe(true);
    expect(readGuardStopWarningPushActionV1(terminal, 'stopNow', home)).toEqual({
      actionId: 'machines.terminal.close', input: { machineId: 'machine', terminalId: 'terminal', serverId: home.serverId } });
    expect(isGuardStopWarningCurrentV1(terminal, { ...current, terminalId: 'reopened-terminal' })).toBe(false);
    expect(isGuardStopWarningCurrentV1(terminal, { ...current, state: undefined })).toBe(false);
    expect(GuardStopWarningPushDataV1Schema.safeParse({ ...terminal, sessionId: 'invented' }).success).toBe(false);
    expect(readGuardStopWarningPushActionV1({ ...session, notificationId: 'another-occurrence' }, 'stopNow', home)).toBeNull();
    expect(readGuardStopWarningPushActionV1({ ...terminal, actions: { ...terminal.actions,
      stopNow: { actionId: 'machines.terminal.close', input: { machineId: 'machine', terminalId: 'another-terminal' } } } }, 'stopNow', home)).toBeNull();
  });
});

describe('machine vitals Inbox notices', () => {
  const common = { topic: 'resource_limit', machineId: 'machine-1', at: 120_000, since: 0,
    workingSessionCount: 2, guardEnabled: false };
  const notices = [
    { ...common, kind: 'memory_pressure', evidence: { level: 'elevated', sustainMs: 120_000, swapUsedBytes: 10 } },
    { ...common, kind: 'cpu_busy', evidence: { abovePct: 90, sustainMs: 120_000, busyPct: 95 } },
    { ...common, kind: 'disk_nearly_full', volumeId: 'volume-1', evidence: {
      freeBytes: 10, totalBytes: 1000, threshold: { freeFraction: 0.1 } } },
  ];
  it.each(notices)('opens started and recovered $kind through the existing Artifact reader', notice => {
    for (const phase of ['started', 'recovered']) {
      const value = { ...notice, phase };
      const header = { v: 1, kind: 'usage_notice.v1', title: 'Machine resources', status: 'open', notice: value };
      expect(readUsageNoticeArtifactV1({ header, body: JSON.stringify({ v: 1, notice: value }) })).toEqual(header);
      const content = { v: 1, source: { kind: 'host', topic: 'resource_limit' }, type: 'update', resolved: false, notice: value };
      const current = { ...content, kind: 'account_notice.v1', title: 'Machine resources', status: 'open' };
      expect(readAccountNoticeArtifactV1({ header: current, body: JSON.stringify(content) })).toEqual(current);
    }
  });
  it('drops retired stored fields while rejecting mismatched evidence and divergent Artifact copies', () => {
    const value = { ...notices[0], phase: 'started' };
    const read = (notice: unknown, bodyNotice: unknown = notice) => readUsageNoticeArtifactV1({
      header: { v: 1, kind: 'usage_notice.v1', title: 'Resources', status: 'open', notice },
      body: JSON.stringify({ v: 1, notice: bodyNotice }),
    });
    expect(read({ ...value, evidence: notices[1]!.evidence })).toBeNull();
    const expected = read(value);
    expect(read({ ...value, privateSessionTitle: 'secret' })).toEqual(expected);
    expect(read({ ...value, evidence: { ...notices[0]!.evidence, extra: 1 } })).toEqual(expected);
    expect(read(value, { ...value, phase: 'recovered' })).toBeNull();
  });
  it('keeps routing bound to the notice and rejects unknown routing authority', () => {
    const machineVitals = { ...notices[0], phase: 'started' };
    const data = { topic: 'resource_limit', kind: 'memory_pressure', phase: 'started', machineId: 'machine-1',
      notificationId: 'resource-1', nextSteps: ['review_processes'], machineVitals,
      serverUrl: 'https://home.example.test' };
    expect(MachineVitalsPushRoutingDataV1Schema.parse(data)).toEqual(data);
    expect(MachineVitalsPushRoutingDataV1Schema.safeParse({ ...data, machineId: 'other-machine' }).success).toBe(false);
    expect(MachineVitalsPushRoutingDataV1Schema.safeParse({ ...data, action: 'stop_everything' }).success).toBe(false);
  });
});

describe('buildActivityWebhookPayload', () => {
  it('keeps Discussion Follow navigation bound to the exact committed C3 message reference', () => {
    const original = { kind: 'discussion' as const, discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'message' };
    const follow = { original, event: { kind: 'person_wrote' as const } };
    const payload = buildActivityWebhookPayload({ channelId: 'hook', createdAt: 1, topic: 'follow_update',
      content: { title: 'A person wrote in the discussion', body: '' }, follow });
    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toMatchObject({ follow, navigation: { message: original } });
    expect(ActivityWebhookPayloadV1Schema.safeParse({ ...payload,
      navigation: { message: { ...original, messageId: 'another-message' } } }).success).toBe(false);
    expect(ActivityWebhookPayloadV1Schema.safeParse({ ...payload, navigation: { sessionId: 'unrelated-parent' } }).success).toBe(false);
  });
  it.each([
    { source: { kind: 'execution_run' as const, sessionId: 'c111111111111111111111111', runId: 'execution' }, terminalEventId: 'terminal' },
    { source: { kind: 'workflow_run' as const, runId: 'workflow' }, revision: 3 },
  ])('preserves exact Run originals through webhooks while rejecting retired Inbox notice copies', original => {
    const follow = { original, event: { kind: 'failed_or_stopped' as const } };
    const notice = { topic: 'follow_update' as const, follow };
    const payload = buildActivityWebhookPayload({ channelId: 'run-hook', createdAt: 1, topic: notice.topic,
      content: { title: 'Run failed or stopped', body: '' }, follow });
    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toMatchObject({ follow, navigation: { source: original.source } });
    expect(ActivityWebhookPayloadV1Schema.safeParse({ ...payload,
      navigation: { source: { ...original.source, runId: 'another-run' } } }).success).toBe(false);
    const content = { v: 1, source: { kind: 'host', topic: notice.topic }, type: 'update', resolved: false, notice };
    const header = { ...content, kind: 'account_notice.v1', title: 'Run failed', status: 'open' };
    expect(readAccountNoticeArtifactV1({ header, body: JSON.stringify(content) })).toBeNull();
  });
  it('carries one strict Follow original without private rules or forwarded human text', () => {
    const follow = { event: { kind: 'person_wrote' as const }, sourceMessage: { localId: 'human-original', seq: 3 } };
    const payload = buildActivityWebhookPayload({ channelId: 'follow-hook', createdAt: 1, topic: 'follow_update',
      content: { title: 'A person wrote in the session', body: '' }, session: { sessionId: 'source' }, follow });
    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({ follow, navigation: { sessionId: 'source' } });
    for (const extra of [{ rules: ['private-rule'] }, { text: 'private human message' },
      { sourceRequests: { agentStateVersion: 1, requests: [{ requestId: 'request', createdAt: 1 }] } }]) {
      expect(ActivityWebhookPayloadV1Schema.safeParse({ ...payload, follow: { ...follow, ...extra } }).success).toBe(false);
    }
    expect(ActivityWebhookPayloadV1Schema.safeParse({ ...payload, navigation: { sessionId: 'source', accountId: 'claimed' } }).success).toBe(false);
  });

  it('builds a ready webhook payload with session navigation', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 123,
      topic: 'ready',
      content: {
        title: 'Review branch',
        body: 'The branch is ready to review.',
      },
      session: {
        sessionId: 'session-1',
        title: 'Review branch',
      },
      metadata: {
        providerLabel: 'Codex',
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload.navigation).toEqual({ sessionId: 'session-1' });
  });

  it('builds a request webhook payload without raw input fields', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 456,
      topic: 'permission_request',
      content: {
        title: 'Deploy fix',
        body: 'Claude asks permission to use Bash\nCommand: git',
      },
      session: {
        sessionId: 'session-2',
        title: 'Deploy fix',
      },
      request: {
        requestId: 'request-1',
        kind: 'permission',
        toolName: 'Bash',
        toolDetails: 'Command: git',
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload.navigation).toEqual({ sessionId: 'session-2', requestId: 'request-1' });
    expect(JSON.stringify(payload)).not.toContain('toolInput');
  });

  it('accepts connected-service quota and account-switch webhook topics', () => {
    for (const topic of [
      'connected_service_account_switch',
      'connected_service_credential_health',
      'connected_service_quota_blocked',
      'connected_service_quota_recovered',
    ] as const) {
      const payload = buildActivityWebhookPayload({
        channelId: 'webhook-primary',
        createdAt: 789,
        topic,
        content: {
          title: 'Provider account updated',
          body: 'A provider account state changed.',
        },
        session: {
          sessionId: 'session-3',
          title: 'Quota recovery',
        },
      });

      expect(ActivityWebhookPayloadV1Schema.parse(payload).topic).toBe(topic);
    }
  });

  it('builds a strict workflow Run update with exact Run navigation and no private content', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 790,
      topic: 'workflow_run_update',
      content: {
        title: 'Workflow needs attention',
        body: 'A workflow Run was interrupted and needs attention.',
      },
      workflowRun: {
        runId: 'run-42',
        updateKind: 'interrupted',
        reason: { code: 'approval_required' },
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    if (payload.topic !== 'workflow_run_update') throw new Error('Expected workflow webhook payload');
    expect(payload).toEqual({
      v: 1,
      channelId: 'webhook-primary',
      createdAt: 790,
      topic: 'workflow_run_update',
      content: {
        title: 'Workflow needs attention',
        body: 'A workflow Run was interrupted and needs attention.',
      },
      workflowRun: {
        runId: 'run-42',
        updateKind: 'interrupted',
        reason: { code: 'approval_required' },
      },
      navigation: { runId: 'run-42' },
    });
    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...payload,
      workflowRun: { ...payload.workflowRun, prompt: 'private prompt' },
    }).success).toBe(false);
    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...payload,
      workflowRun: {
        ...payload.workflowRun,
        reason: { code: 'approval_required', message: 'private diagnostic' },
      },
    }).success).toBe(false);
    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...payload,
      workflowRun: { ...payload.workflowRun, updateKind: 'invented' },
    }).success).toBe(false);
  });

  it('rejects a workflow topic without the workflow arm', () => {
    const ordinary = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 791,
      topic: 'ready',
      content: { title: 'Ready', body: 'Ready.' },
      session: { sessionId: 'session-1' },
    });

    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...ordinary,
      topic: 'workflow_run_update',
      navigation: { runId: 'run-42' },
    }).success).toBe(false);
  });
});
