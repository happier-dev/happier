function createSessionRuntime(request) {
  let listener = null;
  let disposed = false;
  let activeTurnId = null;
  let sequence = 0;
  const bufferedEvents = [];

  const emit = (event) => {
    const value = Object.freeze({
      sequence: ++sequence,
      sessionId: request.sessionId,
      emittedAtMs: sequence,
      ...event,
    });
    if (listener) listener(value);
    else bufferedEvents.push(value);
  };

  emit({
    kind: 'provider-session-id',
    providerSessionId: request.kind === 'resume'
      ? request.providerSessionId
      : `provider-${request.sessionId}`,
  });

  return Object.freeze({
    async send(input) {
      if (disposed) {
        return {
          status: 'unavailable',
          diagnostic: { code: 'fixture_disposed', severity: 'error' },
          retryable: false,
        };
      }
      if (input.input.text === 'process-loss-before-result') {
        emit({
          kind: 'input-custody-unknown',
          inputIds: input.inputIds,
          issue: { code: 'fixture_process_loss', severity: 'error' },
        });
        throw new Error('fixture process lost after native write');
      }
      if (input.input.text === 'packed daemon-child bridge') {
        emit({
          kind: 'input-accepted',
          inputIds: input.inputIds,
          delivery: {
            kind: input.delivery.kind,
            turnId: input.delivery.turnId,
          },
        });
        activeTurnId = input.delivery.turnId;
        emit({
          kind: 'turn-start',
          turnId: activeTurnId,
          startedBy: 'host',
        });
        emit({
          kind: 'message-delta',
          turnId: activeTurnId,
          channel: 'assistant',
          text: input.input.text,
        });
        emit({ kind: 'turn-complete', turnId: activeTurnId });
        activeTurnId = null;
        return { status: 'admitted' };
      }
      emit({
        kind: 'input-rejected',
        sessionId: `${request.sessionId}-cross-session`,
        inputIds: input.inputIds,
        diagnostic: { code: 'fixture_cross_session_rejection', severity: 'error' },
        retryable: false,
      });
      emit({
        kind: 'input-accepted',
        inputIds: input.inputIds,
        delivery: { kind: input.delivery.kind, turnId: input.delivery.turnId },
      });
      emit({
        kind: 'input-custody-unknown',
        inputIds: input.inputIds,
        issue: { code: 'fixture_stale_after_acceptance', severity: 'error' },
      });
      activeTurnId = input.delivery.turnId;
      emit({ kind: 'turn-start', turnId: activeTurnId, startedBy: 'host' });
      if (input.input.text === 'await-cancel') return { status: 'admitted' };
      if (input.input.text === 'fail') {
        emit({
          kind: 'turn-failed',
          turnId: activeTurnId,
          diagnostic: { code: 'fixture_turn_failed', severity: 'error' },
        });
        activeTurnId = null;
        return { status: 'admitted' };
      }
      emit({ kind: 'message-delta', turnId: activeTurnId, channel: 'assistant', text: input.input.text });
      emit({ kind: 'turn-complete', turnId: activeTurnId });
      if (input.input.text === 'duplicate-terminal') {
        emit({ kind: 'turn-complete', turnId: activeTurnId });
        emit({ kind: 'message-delta', turnId: activeTurnId, channel: 'assistant', text: 'late-after-terminal' });
      }
      activeTurnId = null;
      return { status: 'admitted' };
    },
    async cancel(input) {
      if (!activeTurnId || activeTurnId !== input.turnId) {
        return { status: 'notRunning' };
      }
      emit({ kind: 'turn-cancelled', turnId: activeTurnId, cause: input.reason });
      const turnId = activeTurnId;
      activeTurnId = null;
      return { status: 'requested', turnId };
    },
    watch(nextListener) {
      listener = nextListener;
      for (const event of bufferedEvents.splice(0)) listener(event);
      return Object.freeze({
        dispose() {
          if (listener === nextListener) listener = null;
        },
      });
    },
    async dispose() {
      if (disposed) return;
      if (activeTurnId) {
        emit({ kind: 'turn-cancelled', turnId: activeTurnId, cause: 'sessionDispose' });
        activeTurnId = null;
      }
      emit({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
      disposed = true;
    },
  });
}

export function activate(api) {
  api.events.register('watch-measured-event', async () => undefined);
  api.agents.register('novel-native-agent', () => Object.freeze({
    sessions: Object.freeze({
      async open(request, context) {
        const workState = await context.workState.publisher('tasks').publish({
          sourceSequence: 1,
          observedAtMs: 1,
          items: [{
            localId: 'fixture-task',
            kind: 'task',
            origin: 'vendor',
            status: 'active',
            title: 'Measure the packed native path',
            summary: 'Provider work state consumed by the canonical host owner.',
            updatedAtMs: 1,
          }],
          primaryLocalId: 'fixture-task',
        });
        if (workState.status !== 'applied' && workState.status !== 'unchanged') {
          throw new Error(`fixture work-state publication failed: ${workState.status}`);
        }
        await context.ui.status.set('fixture-runtime', 'Native runtime active');
        await context.ui.widget.set('fixture-work', {
          placement: 'beforeComposer',
          lines: ['Packed provider', 'Persistence-ready presentation'],
        });
        return createSessionRuntime(request);
      },
    }),
  }));
  api.actions.register('prove-coexistence', async (input, context) => {
    let resolveEvent;
    const eventDelivered = new Promise((resolve) => {
      resolveEvent = resolve;
    });
    const eventSubscription = context.services.events.subscribe(
      { pluginId: 'acme.native-runtime-proof', localId: 'measured-event' },
      async () => resolveEvent(),
    );
    await context.services.events.emit('measured-event', {
      source: 'packed-contribution-action',
      phase: input.phase,
    });
    await eventDelivered;
    eventSubscription.dispose();

    const protocol = await context.services.exec.clients.spawn({
      kind: 'jsonStream',
      launch: {
        executable: { kind: 'systemTool', id: 'fixture-node' },
        args: ['-e', "process.stdin.once('data', () => { process.stderr.write('packed-action-stderr'); process.stdout.write(JSON.stringify({ acknowledged: true }) + '\\n'); setTimeout(() => process.exit(0), 10); });"],
      },
      maxFrameBytes: 1024,
    });
    let resolveRecord;
    const recordDelivered = new Promise((resolve) => {
      resolveRecord = resolve;
    });
    const recordSubscription = protocol.client.subscribe((value) => resolveRecord(value));
    await protocol.client.write({ trigger: true });
    const record = await recordDelivered;
    await protocol.wait();
    recordSubscription.dispose();
    await protocol.dispose();

    return Object.freeze({
      family: 'actions',
      mixedActivation: true,
      input,
      measuredProtocol: record,
    });
  });
}
