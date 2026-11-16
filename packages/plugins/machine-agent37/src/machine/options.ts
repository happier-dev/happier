import { KINDS } from './kinds.js';
import type { MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { DISK_GB, DOCS_OBSERVED_AT, RETENTION, SIZES } from './schemas.js';

/** Agent37 sizing, billing and auto-sleep references, observed 2026-11-05. */
export function options(): MachineProvisionerOptionsResultV1 {
  // Agent37 has no init system; the existing sandbox role selects guest-process enrollment.
  return { base: { launch: {}, guestPlatform: 'linux', enrollmentRole: 'sandbox', retention: RETENTION }, dimensions: {
    image: KINDS.map(({ id, title, description }) => ({ id, title, assignments: [{ path: 'kind', value: id }], guestPlatform: 'linux',
      nativeFacts: { image: { id, title, description }, preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' } } })),
    size: SIZES.map(size => ({ id: size.id, title: `${size.cpu} vCPU · ${size.memory} GB RAM · ${DISK_GB} GB disk`,
      assignments: [{ path: 'size', value: size.id }], nativeFacts: { size: { id: size.id, title: size.id,
        cpuCores: size.cpu, memoryBytes: size.memory * 1000 ** 3, diskBytes: DISK_GB * 1000 ** 3 } },
      prices: KINDS.map(kind => ({ amount: (size.containerCompute * kind.computeMultiplier + DISK_GB * 0.09).toFixed(2),
        label: 'Running compute and retained disk; stopped disk is still billed', currency: 'USD', unit: 'month',
        source: 'https://www.agent37.com/docs/agents-api/billing', observedAt: DOCS_OBSERVED_AT,
        when: [{ dimension: 'image', optionIds: [kind.id] }] })),
    })),
    location: [ { id: 'us', title: 'US', countryCode: 'US' }, { id: 'eu', title: 'Europe (France)', countryCode: 'FR' },
      { id: 'ap-south', title: 'Asia Pacific (Mumbai)', countryCode: 'IN' } ].map(({ id, title, countryCode }) => ({
        id, title, assignments: [{ path: 'region', value: id }], nativeFacts: { location: { id, title, countryCode } },
      })),
    network: [], duration: [],
  }, constraints: KINDS.map(kind => ({ when: { dimension: 'image', optionIds: [kind.id] }, requires: { dimension: 'location', optionIds: kind.regions } })) };
}
