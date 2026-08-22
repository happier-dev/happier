import {
  PluginError,
} from '@happier-dev/plugin-sdk';
import { definePlugin } from '../../src/definePlugin.js';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
} from '../../src/protocol/index.js';
import type {
  ApprovalQueueSnapshot,
  InteractionTransientApprovalResultV1,
  InteractionTransientConfirmationResultV1,
  InteractionTransientQuestionsResultV1,
  InteractionsService,
  PresentationService } from '@happier-dev/plugin-sdk/interactions';
import type {
  EventsService,
  PluginEventEnvelope } from '@happier-dev/plugin-sdk/events';
import type {
  PluginContributionRef } from '@happier-dev/plugin-sdk';
import type {
  SessionEvent,
  CurrentSessionHandle,
  SessionHandle,
  SessionSummary,
  SessionsService,
} from '@happier-dev/plugin-sdk/sessions';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      typeof error === 'object' && error !== null && 'code' in error && error.code === code,
      `expected error code ${code}`,
    );
    return;
  }
  throw new Error(`expected error code ${code}`);
}

function unexpectedSessionCapability(): never {
  throw new PluginError({
    code: 'fixture_unexpected_session_capability',
    message: 'The external fixture invoked a Session capability outside its generic service slice',
  });
}

function requirePresentation(context: Readonly<{ ui?: PresentationService }>): PresentationService {
  if (context.ui === undefined) {
    throw new PluginError({
      code: 'plugin_presentation_unavailable',
      message: 'The external fixture requires the host presentation capability.',
    });
  }
  return context.ui;
}

const summary = Object.freeze({
  id: 'session-1',
  title: 'External fixture',
  machineId: 'machine-1',
  projectId: 'project-1',
  agentId: 'example-agent',
  state: 'active',
  runtimeAvailability: Object.freeze({ status: 'available' }),
  storagePolicy: 'optional',
  encryptionMode: 'plain',
  updatedAtMs: 1,
}) satisfies SessionSummary;

const unavailableSubagents = Object.freeze({
  capabilities() {
    const unavailable = Object.freeze({ status: 'unavailable' as const, code: 'fixture_not_exercised' });
    return Object.freeze({ list: unavailable, observe: unavailable, watch: unavailable });
  },
  async list() { return unexpectedSessionCapability(); },
  async get() { return unexpectedSessionCapability(); },
  async observe() { return unexpectedSessionCapability(); },
  watch() { return unexpectedSessionCapability(); },
});

const unavailableExternalSessions: SessionsService['external'] = Object.freeze({
  async capabilities() {
    const unavailable: Awaited<ReturnType<SessionsService['external']['capabilities']>>['list'] = Object.freeze({
      status: 'unavailable',
      code: 'fixture_not_exercised',
    });
    return Object.freeze({
      list: unavailable,
      attach: unavailable,
      takeover: unavailable,
      transcript: unavailable,
      follow: unavailable,
    });
  },
  async list() { return unexpectedSessionCapability(); },
  async attach() { return unexpectedSessionCapability(); },
  async readTranscript() { return unexpectedSessionCapability(); },
  async followTranscript() { return unexpectedSessionCapability(); },
  async takeover() { return unexpectedSessionCapability(); },
});

function createSessionHandle(onWatch: () => void): SessionHandle {
  return Object.freeze({
    async summary(options?: Parameters<SessionHandle['summary']>[0]) {
      options?.signal?.throwIfAborted();
      return summary;
    },
    async send() { return unexpectedSessionCapability(); },
    async listSystemRecords(
      _query: Parameters<SessionHandle['listSystemRecords']>[0],
      _options?: Parameters<SessionHandle['listSystemRecords']>[1],
    ): ReturnType<SessionHandle['listSystemRecords']> {
      return unexpectedSessionCapability();
    },
    async upsertSystemRecord(
      _request: Parameters<SessionHandle['upsertSystemRecord']>[0],
      _options?: Parameters<SessionHandle['upsertSystemRecord']>[1],
    ): ReturnType<SessionHandle['upsertSystemRecord']> {
      return unexpectedSessionCapability();
    },
    async readSystemRecord(
      _request: Parameters<SessionHandle['readSystemRecord']>[0],
      _options?: Parameters<SessionHandle['readSystemRecord']>[1],
    ): ReturnType<SessionHandle['readSystemRecord']> {
      return unexpectedSessionCapability();
    },
    async deleteSystemRecord(
      _request: Parameters<SessionHandle['deleteSystemRecord']>[0],
      _options?: Parameters<SessionHandle['deleteSystemRecord']>[1],
    ): ReturnType<SessionHandle['deleteSystemRecord']> {
      return unexpectedSessionCapability();
    },
    watch(listener: Parameters<SessionHandle['watch']>[0]) {
      let disposed = false;
      listener(Object.freeze({ sequence: 1, kind: 'changed', summary }));
      return Object.freeze({
        dispose() {
          assert(!disposed, 'Session handle watch was disposed more than once');
          disposed = true;
          onWatch();
        },
      });
    },
    auth: Object.freeze({
      services: Object.freeze({
        async refreshRuntimeAuth() { return unexpectedSessionCapability(); },
      }),
    }),
    permissions: Object.freeze({
      async requestDecision() { return unexpectedSessionCapability(); },
      getMode() { return 'default'; },
    }),
    mcp: Object.freeze({
      async elicit() { return unexpectedSessionCapability(); },
    }),
    media: Object.freeze({
      async registerSourceRoot() { return unexpectedSessionCapability(); },
    }),
    subagents: unavailableSubagents,
  });
}

class SessionsBoundaryFixture {
  readonly calls: string[] = [];
  readonly current: CurrentSessionHandle;
  readonly subagents = unavailableSubagents;
  readonly external = unavailableExternalSessions;
  private handleWatchDisposals = 0;
  private inventoryWatchDisposals = 0;

  constructor() {
    const fixture = this;
    this.current = Object.freeze({
      ...createSessionHandle(() => { this.handleWatchDisposals += 1; }),
      async setDisplayTitle(
        title: Parameters<CurrentSessionHandle['setDisplayTitle']>[0],
        options?: Parameters<CurrentSessionHandle['setDisplayTitle']>[1],
      ) {
        options?.signal?.throwIfAborted();
        fixture.calls.push(`setDisplayTitle:${title ?? 'clear'}`);
      },
    });
  }

  async list(
    query: Parameters<SessionsService['list']>[0] = {},
    options?: Parameters<SessionsService['list']>[1],
  ): ReturnType<SessionsService['list']> {
    this.calls.push(`list:${query?.limit ?? 'none'}`);
    const signal = options?.signal;
    assert(signal !== undefined, 'Sessions.list did not receive the invocation signal');
    signal.throwIfAborted();
    if (query?.machineId === 'wait') {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return Object.freeze({ items: Object.freeze([summary]) });
  }

  async get(
    id: string,
    options?: Parameters<SessionsService['get']>[1],
  ): ReturnType<SessionsService['get']> {
    this.calls.push(`get:${id}`);
    assert(options?.signal !== undefined, 'Sessions.get did not receive the invocation signal');
    options.signal.throwIfAborted();
    return id === summary.id
      ? createSessionHandle(() => { this.handleWatchDisposals += 1; })
      : null;
  }

  watch(
    query: Parameters<SessionsService['watch']>[0],
    listener: Parameters<SessionsService['watch']>[1],
  ): ReturnType<SessionsService['watch']> {
    this.calls.push(`watch:${query.projectId ?? 'all'}`);
    listener(Object.freeze({ kind: 'snapshot', revision: 'fixture-1', items: Object.freeze([summary]) }));
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        assert(!disposed, 'Sessions watch was disposed more than once');
        disposed = true;
        this.inventoryWatchDisposals += 1;
      },
    });
  }

  assertDisposed(): void {
    assert(this.handleWatchDisposals === 1, 'Session handle watch was not disposed exactly once');
    assert(this.inventoryWatchDisposals === 1, 'Sessions inventory watch was not disposed exactly once');
  }
}

class EventsBoundaryFixture implements EventsService {
  readonly calls: string[] = [];
  private sequence = 0;
  private readonly subscribers: Array<{
    active: boolean;
    event: PluginContributionRef;
    listener: (event: PluginEventEnvelope) => void | Promise<void>;
  }> = [];

  readonly plugin = Object.freeze({
    emit: async (localId: string, payload: Parameters<EventsService['plugin']['emit']>[1], options?: Parameters<EventsService['plugin']['emit']>[2]) => {
      assert(options?.signal !== undefined, 'Plugin Event emit did not receive the invocation signal');
      options.signal.throwIfAborted();
      this.sequence += 1;
      const ref = Object.freeze({ pluginId: 'example.public-services', localId });
      const envelope = Object.freeze({ ref, payload, sequence: this.sequence });
      const active = this.subscribers.filter((entry) => (
        entry.active && entry.event.pluginId === ref.pluginId && entry.event.localId === ref.localId
      ));
      for (const entry of active) await entry.listener(envelope);
      this.calls.push(`emit:${localId}`);
      return Object.freeze({ status: 'admitted' as const, sequence: this.sequence, subscriberCount: active.length });
    },
    subscribe: (event: PluginContributionRef, listener: (event: PluginEventEnvelope) => void | Promise<void>) => {
      const subscription = { active: true, event, listener };
      this.subscribers.push(subscription);
      this.calls.push(`plugin-subscribe:${event.localId}`);
      return Object.freeze({
        dispose: () => {
          assert(subscription.active, 'Plugin Event subscription was disposed more than once');
          subscription.active = false;
          this.calls.push(`plugin-dispose:${event.localId}`);
        },
      });
    },
  });

  readonly host = Object.freeze({
    subscribe: ((target, _listener) => {
      assert(target.eventId === '@happier/runtime/turn-complete', 'unexpected Host Event target');
      assert(target.scope.kind === 'current-session', 'unexpected Host Event scope');
      this.calls.push('host-subscribe:turn-complete');
      let disposed = false;
      return Object.freeze({
        dispose: () => {
          assert(!disposed, 'Host Event subscription was disposed more than once');
          disposed = true;
          this.calls.push('host-dispose:turn-complete');
        },
      });
    }) satisfies EventsService['host']['subscribe'],
  });
}

class InteractionsBoundaryFixture implements InteractionsService {
  readonly calls: string[] = [];
  readonly mode: 'available' | 'unavailable';
  private approvalWatchDisposals = 0;

  constructor(mode: 'available' | 'unavailable') {
    this.mode = mode;
  }

  async requestApproval(
    _request: Parameters<InteractionsService['requestApproval']>[0],
    options?: Parameters<InteractionsService['requestApproval']>[1],
  ): Promise<InteractionTransientApprovalResultV1> {
    assert(options?.signal !== undefined, 'requestApproval did not receive the invocation signal');
    options.signal.throwIfAborted();
    this.calls.push('requestApproval');
    return this.mode === 'available'
      ? Object.freeze({
        requestId: 'fixture-approval-1',
        kind: 'approval' as const,
        status: 'approved' as const,
        persistence: 'once' as const,
      })
      : Object.freeze({
        requestId: 'fixture-approval-1',
        kind: 'approval' as const,
        status: 'unavailable' as const,
      });
  }

  async askQuestions(
    _questions: Parameters<InteractionsService['askQuestions']>[0],
    options?: Parameters<InteractionsService['askQuestions']>[1],
  ): Promise<InteractionTransientQuestionsResultV1> {
    assert(options?.signal !== undefined, 'askQuestions did not receive the invocation signal');
    options.signal.throwIfAborted();
    this.calls.push('askQuestions');
    return this.mode === 'available'
      ? Object.freeze({
        requestId: 'fixture-questions-1',
        kind: 'questions' as const,
        status: 'answered' as const,
        answers: Object.freeze({ name: Object.freeze({ kind: 'text' as const, value: 'Ada' }) }),
      })
      : Object.freeze({
        requestId: 'fixture-questions-1',
        kind: 'questions' as const,
        status: 'unavailable' as const,
      });
  }

  async confirm(
    _request: Parameters<InteractionsService['confirm']>[0],
    options?: Parameters<InteractionsService['confirm']>[1],
  ): Promise<InteractionTransientConfirmationResultV1> {
    assert(options?.signal !== undefined, 'confirm did not receive the invocation signal');
    options.signal.throwIfAborted();
    this.calls.push('confirm');
    return this.mode === 'available'
      ? Object.freeze({
        requestId: 'fixture-confirmation-1',
        kind: 'confirmation' as const,
        status: 'approved' as const,
      })
      : Object.freeze({
        requestId: 'fixture-confirmation-1',
        kind: 'confirmation' as const,
        status: 'unavailable' as const,
      });
  }

  readonly approvals = Object.freeze({
    request: async (
      request: Parameters<InteractionsService['approvals']['request']>[0],
      options?: Parameters<InteractionsService['approvals']['request']>[1],
    ) => {
      assert(options?.signal !== undefined, 'approval queue request did not receive the invocation signal');
      options.signal.throwIfAborted();
      assert(request.actionId === 'session.permission.remote.respond', 'unexpected queued Action id');
      this.calls.push('approvals.request');
      return Object.freeze({ approvalRequestId: 'approval-1' });
    },
    get: async (
      approvalRequestId: string,
      options?: Parameters<InteractionsService['approvals']['get']>[1],
    ) => {
      assert(options?.signal !== undefined, 'approval queue get did not receive the invocation signal');
      options.signal.throwIfAborted();
      this.calls.push('approvals.get');
      if (approvalRequestId !== 'approval-1') return null;
      return Object.freeze({
        approvalRequestId,
        status: 'open' as const,
        actionId: 'session.permission.remote.respond',
        input: Object.freeze({
          sessionId: 'session-1',
          turnId: 'turn-1',
          requestId: 'permission-1',
          sourceRef: 'binding:fixture',
          sourceRevisionOrEpoch: '1',
          idempotencyKey: 'fixture-approval-1',
          actor: Object.freeze({ namespace: 'fixture', principalId: 'operator-1' }),
          decision: 'allow',
          scope: 'request',
        }),
        summary: 'Approve fixture',
        createdAtMs: 1,
        updatedAtMs: 1,
      });
    },
    list: async (
      _query?: Parameters<InteractionsService['approvals']['list']>[0],
      options?: Parameters<InteractionsService['approvals']['list']>[1],
    ): Promise<ApprovalQueueSnapshot> => {
      assert(options?.signal !== undefined, 'approval queue list did not receive the invocation signal');
      options.signal.throwIfAborted();
      this.calls.push('approvals.list');
      return Object.freeze({
        items: Object.freeze([Object.freeze({
          approvalRequestId: 'approval-1',
          status: 'open' as const,
          actionId: 'session.permission.remote.respond',
          summary: 'Approve fixture',
          sessionId: 'session-1',
          updatedAtMs: 1,
        })]),
      });
    },
    watch: async (
      _query: Parameters<InteractionsService['approvals']['watch']>[0],
      listener: Parameters<InteractionsService['approvals']['watch']>[1],
      options?: Parameters<InteractionsService['approvals']['watch']>[2],
    ) => {
      assert(options?.signal !== undefined, 'approval queue watch did not receive the invocation signal');
      options.signal.throwIfAborted();
      const snapshot = await this.approvals.list(undefined, options);
      await listener(snapshot);
      this.calls.push('approvals.watch');
      let disposed = false;
      return Object.freeze({
        dispose: () => {
          assert(!disposed, 'approval queue watch was disposed more than once');
          disposed = true;
          this.approvalWatchDisposals += 1;
        },
      });
    },
  }) satisfies InteractionsService['approvals'];

  assertDisposed(): void {
    assert(this.approvalWatchDisposals === 1, 'approval queue watch was not disposed exactly once');
  }
}

class PresentationBoundaryFixture implements PresentationService {
  readonly calls: string[] = [];

  private record(call: string, signal: AbortSignal | undefined): void {
    assert(signal !== undefined, `${call} did not receive the invocation signal`);
    signal.throwIfAborted();
    this.calls.push(call);
  }

  async notify(_message: string, options?: Parameters<PresentationService['notify']>[1]): Promise<void> {
    this.record('notify', options?.signal);
  }

  readonly status = Object.freeze({
    set: async (_key, _text, options) => { this.record('status.set', options?.signal); },
  }) satisfies PresentationService['status'];

  readonly widget = Object.freeze({
    set: async (_key, _widget, options) => { this.record('widget.set', options?.signal); },
  }) satisfies PresentationService['widget'];

  readonly composer = Object.freeze({
    replace: async (_text, options) => { this.record('composer.replace', options?.signal); },
  }) satisfies PresentationService['composer'];
}

const inputSchema = defineProtocolObject({
  scenario: defineProtocolUnion([
    defineProtocolLiteral('positive'),
    defineProtocolLiteral('wait-sessions'),
    defineProtocolLiteral('unavailable-interactions'),
    defineProtocolLiteral('presentation'),
  ]),
}, { policy: 'closed' });
const resultSchema = defineProtocolObject({
  status: defineProtocolLiteral('ok'),
}, { policy: 'closed' });

const { manifest, activate } = definePlugin({
  id: 'example.public-services',
  version: '0.1.0',
  actions: {
    exercise: {
      title: 'Exercise generic public services',
      execution: { target: 'daemon' },
      inputSchema,
      resultSchema,
      async run(input, context) {
        if (input.scenario === 'wait-sessions') {
          await context.services.sessions.list({ machineId: 'wait' }, { signal: context.signal });
          return { status: 'ok' };
        }

        if (input.scenario === 'unavailable-interactions') {
          const approval = await context.services.interactions.requestApproval({
            kind: 'approval',
            title: 'Unavailable approval',
            subject: { kind: 'tool', name: 'fixture', input: null },
          }, { signal: context.signal });
          const questions = await context.services.interactions.askQuestions({
            kind: 'questions',
            questions: [{ id: 'name', prompt: 'Name?', type: 'text', required: true }],
          }, { signal: context.signal });
          const confirmation = await context.services.interactions.confirm({
            kind: 'confirmation',
            message: 'Continue?',
          }, { signal: context.signal });
          assert(approval.status === 'unavailable', 'requestApproval did not preserve typed unavailability');
          assert(questions.status === 'unavailable', 'askQuestions did not preserve typed unavailability');
          assert(confirmation.status === 'unavailable', 'confirm did not preserve typed unavailability');
          return { status: 'ok' };
        }

        if (input.scenario === 'presentation') {
          await requirePresentation(context).notify('Fixture', { severity: 'info', signal: context.signal });
          return { status: 'ok' };
        }

        const page = await context.services.sessions.list({ limit: 1 }, { signal: context.signal });
        assert(page.items.length === 1 && page.items[0]?.id === 'session-1', 'Sessions.list result changed');
        const handle = await context.services.sessions.get('session-1', { signal: context.signal });
        assert(handle !== null && handle !== context.services.sessions.current, 'Sessions.get must remain a base handle');
        const handleSummary = await handle.summary({ signal: context.signal });
        assert(handleSummary.id === 'session-1', 'SessionHandle.summary result changed');
        const handleEvents: SessionEvent[] = [];
        const handleWatch = handle.watch((event) => { handleEvents.push(event); });
        let inventorySnapshots = 0;
        const inventoryWatch = context.services.sessions.watch(
          { projectId: 'project-1' },
          (event) => { if (event.kind === 'snapshot') inventorySnapshots += 1; },
        );

        let pluginDeliveries = 0;
        const pluginSubscription = context.services.events.plugin.subscribe(
          { pluginId: context.plugin.id, localId: 'published' },
          () => { pluginDeliveries += 1; },
        );
        const hostSubscription = context.services.events.host.subscribe(
          { eventId: '@happier/runtime/turn-complete', scope: { kind: 'current-session' } },
          () => undefined,
        );
        const emitted = await context.services.events.plugin.emit(
          'published',
          { ready: true },
          { signal: context.signal },
        );

        const approval = await context.services.interactions.requestApproval({
          kind: 'approval',
          title: 'Approve fixture',
          subject: { kind: 'tool', name: 'fixture', input: { ready: true } },
        }, { signal: context.signal });
        const questions = await context.services.interactions.askQuestions({
          kind: 'questions',
          title: 'Fixture',
          questions: [{ id: 'name', prompt: 'Name?', type: 'text', required: true }],
        }, { signal: context.signal });
        const confirmed = await context.services.interactions.confirm({
          kind: 'confirmation',
          title: 'Fixture',
          message: 'Continue?',
        }, { signal: context.signal });
        const queued = await context.services.interactions.approvals.request({
          actionId: 'session.permission.remote.respond',
          input: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            requestId: 'permission-1',
            sourceRef: 'binding:fixture',
            sourceRevisionOrEpoch: '1',
            idempotencyKey: 'fixture-approval-1',
            actor: { namespace: 'fixture', principalId: 'operator-1' },
            decision: 'allow',
            scope: 'request',
          },
          summary: 'Approve fixture',
        }, { signal: context.signal });
        const queuedRequest = await context.services.interactions.approvals.get(
          queued.approvalRequestId,
          { signal: context.signal },
        );
        const queueSnapshot = await context.services.interactions.approvals.list(
          { status: 'open', limit: 1 },
          { signal: context.signal },
        );
        let queueSnapshots = 0;
        const queueWatch = await context.services.interactions.approvals.watch(
          { status: 'open', limit: 1 },
          () => { queueSnapshots += 1; },
          { signal: context.signal },
        );

        const presentation = requirePresentation(context);
        await presentation.notify('Fixture ready', { severity: 'info', signal: context.signal });
        await presentation.status.set('fixture', 'Ready', { signal: context.signal });
        await presentation.widget.set('fixture', {
          placement: 'beforeComposer', lines: ['Ready'],
        }, { signal: context.signal });
        await context.services.sessions.current?.setDisplayTitle('Fixture', { signal: context.signal });
        await presentation.composer.replace('Continue', { signal: context.signal });

        queueWatch.dispose();
        hostSubscription.dispose();
        pluginSubscription.dispose();
        inventoryWatch.dispose();
        handleWatch.dispose();

        assert(handleEvents.length === 1, 'SessionHandle.watch did not deliver its event');
        assert(inventorySnapshots === 1, 'Sessions.watch did not deliver its snapshot');
        assert(emitted.subscriberCount === 1 && pluginDeliveries === 1, 'Plugin Events publish/subscribe changed');
        assert(approval.status === 'approved', 'requestApproval positive result changed');
        assert(questions.status === 'answered', 'askQuestions positive result changed');
        assert(confirmed.status === 'approved', 'confirm positive result changed');
        assert(queuedRequest?.approvalRequestId === 'approval-1', 'ApprovalQueue.get result changed');
        assert(queueSnapshot.items.length === 1 && queueSnapshots === 1, 'ApprovalQueue list/watch changed');
        return { status: 'ok' };
      },
    },
  },
});

export async function exercisePublicServices(): Promise<void> {
  const sessions = new SessionsBoundaryFixture();
  const events = new EventsBoundaryFixture();
  const interactions = new InteractionsBoundaryFixture('available');
  const presentation = new PresentationBoundaryFixture();
  const testkit = await createPluginTestkit({
    manifest,
    module: { activate },
    services: { sessions, events, interactions },
    presentation,
  });
  try {
    const result = await testkit.invokeAction('exercise', { scenario: 'positive' });
    assert(
      typeof result === 'object' && result !== null && 'status' in result && result.status === 'ok',
      'generic service fixture did not return its validated result',
    );
    sessions.assertDisposed();
    interactions.assertDisposed();
    assert(events.calls.includes('emit:published'), 'Events fixture was not consumed');
    assert(presentation.calls.length === 4, 'Presentation fixture did not receive all retained public operations');

    const caller = new AbortController();
    const pending = testkit.invokeAction('exercise', { scenario: 'wait-sessions' }, { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error('external service fixture caller cancelled'));
    await expectErrorCode(pending, 'plugin_action_aborted');
  } finally {
    await testkit.dispose();
  }

  const unavailableInteractions = await createPluginTestkit({
    manifest,
    module: { activate },
    services: { interactions: new InteractionsBoundaryFixture('unavailable') },
  });
  try {
    await unavailableInteractions.invokeAction('exercise', { scenario: 'unavailable-interactions' });
    await expectErrorCode(
      unavailableInteractions.invokeAction('exercise', { scenario: 'presentation' }),
      'plugin_presentation_unavailable',
    );
  } finally {
    await unavailableInteractions.dispose();
  }

  const omittedSessions = await createPluginTestkit({ manifest, module: { activate } });
  try {
    await expectErrorCode(
      omittedSessions.invokeAction('exercise', { scenario: 'positive' }),
      'plugin_test_service_unavailable',
    );
  } finally {
    await omittedSessions.dispose();
  }
}
