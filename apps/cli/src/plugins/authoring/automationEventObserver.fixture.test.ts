import {
  AutomationSourceSelectorIdV1Schema,
  AutomationTriggerIdSchema,
  deriveAutomationOccurrenceKeyV1,
  ingestPluginManifestV2,
  type AutomationRunStateChangedHostEventV1,
} from '@happier-dev/protocol';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  bindDeclaredEventSubscriptions,
  createStablePluginEventsBroker,
} from '@/plugins/runtime/invocation/services/events';

const fixtureModuleUrl = new URL(
  '../../../../../packages/tests/fixtures/plugin-platform/automation-event-observer/index.ts',
  import.meta.url,
).href;
const eventRef = {
  pluginId: 'com.example.automation-event-observer',
  localId: 'ledger-entry-appended',
} as const;
const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
  '3f5b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d91',
);

const lifecyclePayload = Object.freeze({
  runId: 'run-1',
  automationId: 'automation-1',
  runCause: {
    kind: 'trigger',
    triggerId: AutomationTriggerIdSchema.parse('trigger-external-ledger'),
    triggerRevision: 4,
    triggerKind: 'pluginEvent',
    occurrenceKey: deriveAutomationOccurrenceKeyV1({
      triggerId: AutomationTriggerIdSchema.parse('trigger-external-ledger'),
      evidence: {
        v: 1,
        kind: 'pluginEvent',
        eventRef,
        sourceSelectorId,
        occurrenceId: 'entry-1',
        occurredAt: 1_725_000_000_000,
        payload: { entryId: 'entry-1' },
      },
    }),
    occurredAt: 1_725_000_000_000,
    evidence: { eventRef, sourceSelectorId },
  },
  previousState: 'claimed',
  currentState: 'running',
  transitionedAt: 1_725_000_000_000,
  claimedByMachineId: 'machine-1',
} satisfies AutomationRunStateChangedHostEventV1);

describe('Automation lifecycle public observer fixture', () => {
  it('observes the strict Account lifecycle payload without becoming a trigger or durable Run owner', async () => {
    const { activate, manifest } = await import(fixtureModuleUrl);
    const parsed = ingestPluginManifestV2(manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The lifecycle observer is one host-event subscription. The same external
    // plugin also contributes an Automation Event source, so this arm proves
    // the subscription itself never carries trigger or Run authority.
    const subscription = parsed.manifest.contributes.events.find((event) => (
      event.id === 'observe-run-state-changed'
    ));
    expect(subscription).toEqual(expect.objectContaining({
      id: 'observe-run-state-changed',
      kind: 'subscription',
      target: {
        kind: 'host',
        eventId: '@happier/automation/run-state-changed',
        scope: { kind: 'account' },
      },
    }));
    expect(subscription).not.toHaveProperty('automation');

    const testkit = await createPluginTestkit({ manifest, module: { activate } });
    const handler = testkit.registration('events', 'observe-run-state-changed');
    expect(handler).toEqual(expect.any(Function));
    if (!handler) {
      await testkit.dispose();
      throw new Error('Automation event observer fixture did not register its declared listener');
    }

    const logInfo = vi.fn();
    let generationCurrent = true;
    const listenerFailures = vi.fn();
    const broker = createStablePluginEventsBroker({ onHostListenerError: listenerFailures });
    const binding = bindDeclaredEventSubscriptions({
      host: {
        broker,
        declarationsByPluginId: new Map([[parsed.manifest.id, parsed.manifest.contributes.events]]),
        activePluginIds: new Set([parsed.manifest.id]),
      },
      registrations: [{
        pluginId: parsed.manifest.id,
        pluginVersion: parsed.manifest.version,
        generation: 'observer-generation',
        localId: 'observe-run-state-changed',
        handler,
      }],
      isGenerationCurrent: () => generationCurrent,
      createContext: ({ signal }) => ({
        context: Object.freeze({
          signal,
          services: Object.freeze({
            logger: Object.freeze({ info: logInfo }),
          }),
        }) as never,
        complete: () => {},
      }),
    });

    try {
      // A new daemon connected to an old server receives no additive update;
      // the observer must not synthesize a lifecycle transition.
      expect(logInfo).not.toHaveBeenCalled();

      broker.publishHostEventEnvelope({
        eventId: '@happier/automation/run-state-changed',
        scope: { kind: 'account' },
        payload: lifecyclePayload,
      });
      await vi.waitFor(() => expect(logInfo).toHaveBeenCalledWith(
        'automation_event_observer.received',
        { transition: lifecyclePayload },
      ));

      // Host-event listener failure is isolated from the already-committed
      // transition; this fixture can only observe the payload it is given.
      logInfo.mockImplementationOnce(() => {
        throw new Error('fixture observer failure');
      });
      expect(() => broker.publishHostEventEnvelope({
        eventId: '@happier/automation/run-state-changed',
        scope: { kind: 'account' },
        payload: lifecyclePayload,
      })).not.toThrow();
      await vi.waitFor(() => expect(listenerFailures).toHaveBeenCalledWith(expect.objectContaining({
        event: expect.objectContaining({ payload: lifecyclePayload }),
      })));

      // Registry retirement drops later deliveries rather than replaying them
      // into a stale observer generation.
      generationCurrent = false;
      broker.publishHostEventEnvelope({
        eventId: '@happier/automation/run-state-changed',
        scope: { kind: 'account' },
        payload: lifecyclePayload,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listenerFailures).toHaveBeenCalledOnce();
      expect(logInfo).toHaveBeenCalledTimes(2);
    } finally {
      await binding.dispose();
      await testkit.dispose();
    }
  });
});
