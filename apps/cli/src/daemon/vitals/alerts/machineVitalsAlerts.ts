import { evaluateMachineVitalsAlertsV1, type MachineVitalsAlertTransitionV1 } from '@happier-dev/protocol/machines/vitals/evaluateMachineVitalsAlertsV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { MachineResourcesPolicyV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineResourcesPolicyRuntime } from '../../resources/machineResourcesPolicy';
import type { MachineVitalsSampler } from '../createMachineVitalsSampler';
import type { MinuteHistoryStore } from '../history/minuteHistoryStore';

export function createMachineVitalsAlerts(input: Readonly<{
  sampler: MachineVitalsSampler;
  historyStore: MinuteHistoryStore;
  policy: MachineResourcesPolicyRuntime;
  notify: (transition: MachineVitalsAlertTransitionV1, sample: MachineVitalsSampleV1, policy: MachineResourcesPolicyV1) => Promise<void>;
  emit?: (transition: MachineVitalsAlertTransitionV1) => void;
  onError?: (error: unknown) => void;
}>): Readonly<{ stop: () => Promise<void> }> {
  let pending = Promise.resolve();
  let stopped = false;
  const release = input.sampler.subscribe(({ sample, minute }) => {
    if (stopped || !minute) return;
    const snapshot = input.policy.read();
    if (snapshot.status !== 'ready') return;
    const sustainMs = Math.max(snapshot.policy.alerts.memory.sustainMs, snapshot.policy.alerts.cpu.sustainMs);
    const records = input.sampler.minutes(minute.t - sustainMs);
    pending = pending.then(async () => {
      const transitions = evaluateMachineVitalsAlertsV1({ policy: snapshot.policy.alerts, records,
        episodes: input.historyStore.alerts(), now: minute.t, disk: sample.disk });
      for (const transition of transitions) {
        // Retain suppression before delivery within this daemon lifetime; restart begins fresh.
        await input.historyStore.appendAlert(transition.episode);
        try { input.emit?.(transition); } catch (error) { input.onError?.(error); }
        try { await input.notify(transition, sample, snapshot.policy); } catch (error) { input.onError?.(error); }
      }
    }).catch(error => input.onError?.(error));
  });
  return { async stop() { stopped = true; release(); await pending; } };
}
