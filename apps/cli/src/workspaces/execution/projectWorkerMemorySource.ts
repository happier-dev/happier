import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';

import type { ProjectWorkerMemoryObservation } from './projectWorkerAdmission';

/** The sampler's memory reading, and a current-demand hold for work queued on available memory. */
export function createProjectWorkerMemorySource(readSampler: () => Pick<MachineVitalsSampler, 'latest' | 'state' | 'demand'> | null) {
  const readMemory = (): ProjectWorkerMemoryObservation | null => {
    const sampler = readSampler();
    const sample = sampler?.latest();
    if (!sampler || !sample || sampler.state().state !== 'reporting' || !sample.memory.reported
      || Date.now() - sample.sampledAt > 2 * sample.intervalMs) return null;
    return { totalBytes: sample.memory.totalBytes, availableBytes: sample.memory.availableBytes };
  };
  return Object.freeze({
    readMemory,
    holdMemoryDemand: () => {
      const sampler = readSampler();
      // A reading taken before this hold may be a minute old; admission waits for the next one.
      const baseline = sampler?.latest() ?? null;
      const release = sampler?.demand('live') ?? (() => {});
      return Object.freeze({ readFresh: () => (readSampler()?.latest() ?? null) === baseline ? null : readMemory(), release });
    },
  });
}
