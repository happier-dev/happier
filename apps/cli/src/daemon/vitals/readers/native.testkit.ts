/** Schema-faithful stdout from the external native vitals provider. */
export const nativeVitalsOutputFixture = (offset: number) => JSON.stringify({ v: 1, t: 'vitals-sample', sample: {
  cpu: [{ idle: 9000 + offset * 5, user: 3000 + offset * 3, system: 2000 + offset * 2 }],
  memory: { totalBytes: 32_000, availableBytes: 10_000, pressureLevel: 'not_reported', pressureSource: 'none', lowMemorySignal: true,
    swap: { kind: 'page_file', totalBytes: 64_000, usedBytes: 30_000 } },
  volumes: [{ id: 'volume-guid', label: 'System', mount: 'C:\\', totalBytes: 100_000, availableBytes: 50_000 }],
  interfaces: [{ id: '1', name: 'Ethernet', rxBytes: 8_000 + offset * 2, txBytes: 4_000 + offset, included: true },
    { id: '2', name: 'VPN', rxBytes: 900_000 + offset * 10, txBytes: 100_000 + offset * 10, included: false }],
} });
