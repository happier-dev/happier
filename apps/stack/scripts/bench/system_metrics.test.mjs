import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDarwinHostMetrics, parseLinuxHostMetrics } from './system_metrics.mjs';

test('Linux benchmark metrics distinguish capacity, pressure, paging, and runnable work', () => {
  const metrics = parseLinuxHostMetrics({
    meminfoText: [
      'MemTotal:       24000000 kB',
      'MemAvailable:   12000000 kB',
      'SwapTotal:       8000000 kB',
      'SwapFree:        6000000 kB',
    ].join('\n'),
    loadavgText: '4.50 3.00 2.00 7/1000 12345\n',
    vmstatText: 'pswpin 11\npswpout 13\n',
    statText: 'cpu  1 2 3 4\nctxt 98765\nprocs_running 7\n',
    cpuPsiText: 'some avg10=1.25 avg60=0.50 avg300=0.10 total=9\n',
    memoryPsiText: 'some avg10=2.50 avg60=1.00 avg300=0.20 total=8\n',
    ioPsiText: 'some avg10=3.75 avg60=1.50 avg300=0.30 total=7\n',
  });

  assert.deepEqual(metrics, {
    loadAverage1m: 4.5,
    runQueue: 7,
    runningProcesses: 7,
    contextSwitches: 98_765,
    availableMemoryBytes: 12_000_000 * 1024,
    totalMemoryBytes: 24_000_000 * 1024,
    swapUsedBytes: 2_000_000 * 1024,
    swapTotalBytes: 8_000_000 * 1024,
    swapInPages: 11,
    swapOutPages: 13,
    psi: {
      cpu: { some: { avg10: 1.25, avg60: 0.5, avg300: 0.1, total: 9 } },
      memory: { some: { avg10: 2.5, avg60: 1, avg300: 0.2, total: 8 } },
      io: { some: { avg10: 3.75, avg60: 1.5, avg300: 0.3, total: 7 } },
    },
  });
});

test('Darwin benchmark metrics preserve compression, paging, memory pressure, and unavailable thermal state', () => {
  const metrics = parseDarwinHostMetrics({
    vmStatText: [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free: 100.',
      'Pages active: 200.',
      'Pages inactive: 300.',
      'Pages speculative: 25.',
      'Pages wired down: 50.',
      'Pages occupied by compressor: 75.',
      'Swapins: 1234.',
      'Swapouts: 5678.',
    ].join('\n'),
    memoryPressureText: 'System-wide memory free percentage: 42%\n',
    swapUsageText: 'total = 8192.00M used = 6144.00M free = 2048.00M (encrypted)',
    totalMemoryText: '137438953472\n',
    thermalPressureText: '',
  });

  assert.deepEqual(metrics, {
    availableMemoryBytes: 125 * 16_384,
    totalMemoryBytes: 137_438_953_472,
    compressedMemoryBytes: 75 * 16_384,
    wiredMemoryBytes: 50 * 16_384,
    memoryFreePercent: 42,
    swapUsedBytes: 6144 * 1024 ** 2,
    swapTotalBytes: 8192 * 1024 ** 2,
    swapInPages: 1234,
    swapOutPages: 5678,
    thermalPressure: null,
  });
});
