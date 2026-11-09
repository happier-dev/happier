import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  isTcpPortFree,
  listListenPids,
  observeTcpPortAvailability,
  pickNextFreeTcpPort,
  waitForTcpPortFree,
} from './ports.mjs';

function completeNetworkInterfaceInventory(interfaces) {
  return { status: 'complete', interfaces };
}

async function getUnusedLoopbackPort() {
  const srv = net.createServer();
  await new Promise((resolvePromise, reject) => {
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise());
  });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to allocate a free TCP port');
  await new Promise((resolvePromise) => srv.close(resolvePromise));
  return port;
}

test(
  'isTcpPortFree resolves (fails closed) when the bind-probe cannot close cleanly',
  { timeout: 2000 },
  async (t) => {
    const port = await getUnusedLoopbackPort();

    t.mock.method(net, 'createServer', () => {
      return {
        unref() {},
        on() {
          return this;
        },
        listen(_opts, cb) {
          queueMicrotask(cb);
          return this;
        },
        close() {
          // Simulate a broken/never-closing server.close callback.
        },
      };
    });

    const out = await isTcpPortFree(port, { host: '127.0.0.1', timeoutMs: 25 });
    assert.equal(out, false);
  }
);

test('listListenPidsWithStatus reports unsupported listener discovery when lsof is unavailable', async () => {
  const ports = await import('./ports.mjs');
  assert.equal(typeof ports.listListenPidsWithStatus, 'function');

  const out = await ports.listListenPidsWithStatus(34567, {
    resolveCommandPathImpl: async () => '',
    runCaptureImpl: async () => {
      throw new Error('must not run listener discovery without a resolved command');
    },
    platform: 'linux',
  });

  assert.equal(out.supported, false);
  assert.equal(out.status, 'unsupported');
  assert.deepEqual(out.pids, []);
});

test('isTcpPortFree is a Boolean compatibility wrapper over typed availability evidence', async () => {
  const observations = [];
  const free = await isTcpPortFree(34567, {
    observeTcpPortAvailabilityImpl: async (port, options) => {
      observations.push([port, options.host, options.timeoutMs]);
      return { status: 'inconclusive', reason: 'interface-inventory-unavailable' };
    },
  });

  assert.equal(free, false);
  assert.deepEqual(observations, [[34567, '127.0.0.1', 250]]);
});

test('observeTcpPortAvailability requires complete bind evidence and lets occupied evidence dominate errors', async () => {
  const bindingHosts = [];
  const occupied = await observeTcpPortAvailability(34567, {
    timeoutMs: 500,
    networkInterfacesImpl: () => completeNetworkInterfaceInventory({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.0.2.15', family: 'IPv4', internal: false }],
    }),
    probeTcpPortBindingImpl: async (_port, { host }) => {
      bindingHosts.push(host);
      if (host === '127.0.0.1') return { status: 'error', reason: 'port-bind-error' };
      if (host === '192.0.2.15') return { status: 'in_use', reason: 'address-in-use' };
      return { status: 'free' };
    },
  });

  assert.deepEqual(occupied, { status: 'occupied', reason: 'address-in-use' });
  assert.deepEqual(bindingHosts, ['127.0.0.1', '192.0.2.15']);

  const free = await observeTcpPortAvailability(34568, {
    timeoutMs: 500,
    networkInterfacesImpl: () => completeNetworkInterfaceInventory({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.0.2.15', family: 'IPv4', internal: false }],
    }),
    probeTcpPortBindingImpl: async () => ({ status: 'free' }),
  });

  assert.deepEqual(free, { status: 'free' });
});

test('observeTcpPortAvailability preserves incomplete inventory and bind failures as inconclusive', async () => {
  let bindingProbes = 0;
  const incompleteInventory = await observeTcpPortAvailability(34567, {
    networkInterfacesImpl: () => ({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    }),
    probeTcpPortBindingImpl: async () => {
      bindingProbes += 1;
      return { status: 'free' };
    },
  });
  assert.deepEqual(incompleteInventory, {
    status: 'inconclusive',
    reason: 'interface-inventory-unavailable',
  });
  assert.equal(bindingProbes, 0);

  const bindFailure = await observeTcpPortAvailability(34567, {
    networkInterfacesImpl: () => completeNetworkInterfaceInventory({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    }),
    probeTcpPortBindingImpl: async (_port, { host }) => (
      host === '127.0.0.1'
        ? { status: 'timeout', reason: 'port-bind-timeout' }
        : { status: 'free' }
    ),
  });
  assert.deepEqual(bindFailure, { status: 'inconclusive', reason: 'port-bind-timeout' });
});

test('waitForTcpPortFree returns typed final evidence under one absolute deadline', async () => {
  let now = 0;
  const observationBudgets = [];
  const waits = [];
  const evidence = [
    { status: 'occupied', reason: 'address-in-use' },
    { status: 'inconclusive', reason: 'port-bind-error' },
  ];

  const result = await waitForTcpPortFree(34567, {
    timeoutMs: 100,
    intervalMs: 25,
    nowImpl: () => now,
    delayImpl: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    observeTcpPortAvailabilityImpl: async (_port, options) => {
      observationBudgets.push(options.timeoutMs);
      now += 30;
      return evidence.shift() ?? { status: 'free' };
    },
  });

  assert.deepEqual(result, { status: 'inconclusive', reason: 'port-bind-error' });
  assert.deepEqual(observationBudgets, [100, 45]);
  assert.deepEqual(waits, [25, 15]);
  assert.equal(now, 100);
});

test('waitForTcpPortFree re-observes transient evidence and returns as soon as free is proven', async () => {
  let now = 0;
  const evidence = [
    { status: 'occupied', reason: 'address-in-use' },
    { status: 'inconclusive', reason: 'port-bind-error' },
    { status: 'free' },
  ];

  const result = await waitForTcpPortFree(34567, {
    timeoutMs: 100,
    intervalMs: 10,
    nowImpl: () => now,
    delayImpl: async (milliseconds) => { now += milliseconds; },
    observeTcpPortAvailabilityImpl: async () => evidence.shift(),
  });

  assert.deepEqual(result, { status: 'free' });
  assert.equal(now, 20);
});

test('pickNextFreeTcpPort checks every local interface for fresh allocation', async () => {
  const bindingProbes = [];
  const bindingByPortAndHost = new Map([
    ['43000@192.0.2.15', { status: 'in_use', reason: 'address-in-use' }],
    ['43001@192.0.2.15', { status: 'error', reason: 'port-bind-error' }],
    ['43002@192.0.2.15', { status: 'timeout', reason: 'port-bind-timeout' }],
  ]);

  const port = await pickNextFreeTcpPort(43000, {
    tries: 4,
    networkInterfacesImpl: () => completeNetworkInterfaceInventory({
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true },
      ],
      en0: [
        { address: '192.0.2.15', family: 'IPv4', internal: false },
      ],
    }),
    probeTcpPortBindingImpl: async (candidate, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      bindingProbes.push([candidate, { host: options.host, timeoutMs: options.timeoutMs }]);
      return bindingByPortAndHost.get(`${candidate}@${options.host}`) ?? { status: 'free' };
    },
  });

  assert.equal(port, 43003);
  assert.deepEqual(
    bindingProbes.filter(([candidate]) => candidate === 43000),
    [
      [43000, { host: '127.0.0.1', timeoutMs: 250 }],
      [43000, { host: '::1', timeoutMs: 250 }],
      [43000, { host: '192.0.2.15', timeoutMs: 250 }],
    ],
    'a non-loopback collision must reject a candidate even when loopback binding is free',
  );
  assert.deepEqual(
    bindingProbes.filter(([candidate]) => candidate === 43003),
    [
      [43003, { host: '127.0.0.1', timeoutMs: 250 }],
      [43003, { host: '::1', timeoutMs: 250 }],
      [43003, { host: '192.0.2.15', timeoutMs: 250 }],
      [43003, { host: '0.0.0.0', timeoutMs: 250 }],
      [43003, { host: '::', timeoutMs: 250 }],
    ],
    'fallback must prove both interface-specific and eventual wildcard bind scopes',
  );
});

test('pickNextFreeTcpPort delegates candidate decisions to the typed availability owner', async () => {
  const candidates = [];
  const port = await pickNextFreeTcpPort(43100, {
    tries: 3,
    observeTcpPortAvailabilityImpl: async (candidate, options) => {
      candidates.push([candidate, options.deadline]);
      return candidate === 43102
        ? { status: 'free' }
        : { status: 'inconclusive', reason: 'port-bind-error' };
    },
  });

  assert.equal(port, 43102);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map(([candidate]) => candidate), [43100, 43101, 43102]);
  assert.equal(new Set(candidates.map(([, deadline]) => deadline)).size, 1);
});

test('pickNextFreeTcpPort formats scoped IPv6 bind hosts for the target platform', async () => {
  const cases = [
    { platform: 'win32', expectedScopedHost: 'fe80::1234%12' },
    { platform: 'linux', expectedScopedHost: 'fe80::1234%Ethernet' },
  ];

  for (const [index, fixture] of cases.entries()) {
    const bindingHosts = [];
    const startPort = 43200 + index;
    // eslint-disable-next-line no-await-in-loop
    const port = await pickNextFreeTcpPort(startPort, {
      platform: fixture.platform,
      networkInterfacesImpl: () => completeNetworkInterfaceInventory({
        Ethernet: [
          {
            address: 'fe80::1234',
            family: 'IPv6',
            internal: false,
            scopeid: 12,
          },
        ],
      }),
      probeTcpPortBindingImpl: async (_candidate, { host }) => {
        bindingHosts.push(host);
        return { status: 'free' };
      },
    });

    assert.equal(port, startPort);
    assert.deepEqual(bindingHosts, [
      '127.0.0.1',
      fixture.expectedScopedHost,
      '0.0.0.0',
      '::',
    ]);
  }
});

test('pickNextFreeTcpPort rejects partial interface inventories that can omit an occupied LAN address', async () => {
  const occupiedLanHost = '192.0.2.15';
  const partialObservations = [
    completeNetworkInterfaceInventory({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [],
    }),
    {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    },
  ];

  for (const observation of partialObservations) {
    // The bind boundary knows the omitted LAN address is occupied. The allocator must not
    // authorize selection from a snapshot that cannot prove it enumerated that address.
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => pickNextFreeTcpPort(43500, {
        tries: 1,
        networkInterfacesImpl: () => observation,
        probeTcpPortBindingImpl: async (_candidate, { host }) => (
          host === occupiedLanHost
            ? { status: 'in_use', reason: 'address-in-use' }
            : { status: 'free' }
        ),
      }),
      /unable to find a free TCP port/,
    );
  }
});

test('pickNextFreeTcpPort rejects an unusable interface inventory instead of collapsing to requested-host-only proof', async () => {
  const bindingProbes = [];

  for (const inventory of [
    null,
    [],
    {},
    { en0: ['not-an-interface-address'] },
    {
      en0: undefined,
      unusable: [{ address: 'not-an-ip-address', family: 'IPv4', internal: false }],
    },
    {
      lo0: [{ address: '::1', family: 'IPv6', internal: true }],
      en0: [{ address: 'not-an-ip-address', family: 'IPv4', internal: false }],
    },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => pickNextFreeTcpPort(44000, {
        tries: 1,
        networkInterfacesImpl: () => completeNetworkInterfaceInventory(inventory),
        probeTcpPortBindingImpl: async (candidate, options) => {
          bindingProbes.push([candidate, options]);
          return { status: 'free' };
        },
      }),
      /unable to find a free TCP port/,
    );
  }

  assert.deepEqual(bindingProbes, [], 'an unusable inventory cannot authorize requested-host-only selection');
});

test('pickNextFreeTcpPort advances past three occupied candidates to a fourth free candidate', { timeout: 2000 }, async () => {
  const bindingProbes = [];
  const startedAt = Date.now();

  const port = await pickNextFreeTcpPort(44500, {
    tries: 4,
    totalTimeoutMs: 750,
    networkInterfacesImpl: () => completeNetworkInterfaceInventory({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    }),
    probeTcpPortBindingImpl: async (candidate, options) => {
      bindingProbes.push([candidate, options.host]);
      return candidate < 44503
        ? { status: 'in_use', reason: 'address-in-use' }
        : { status: 'free' };
    },
  });

  assert.equal(port, 44503);
  assert.ok(Date.now() - startedAt < 750);
  assert.deepEqual(bindingProbes.map(([candidate]) => candidate), [44500, 44501, 44502, 44503, 44503]);
});

test('pickNextFreeTcpPort spends one absolute timeout budget across bind boundaries', async () => {
  let now = 0;
  const bindingBudgets = [];

  await assert.rejects(
    () => pickNextFreeTcpPort(45000, {
      tries: 200,
      totalTimeoutMs: 300,
      nowImpl: () => now,
      networkInterfacesImpl: () => completeNetworkInterfaceInventory({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      }),
      probeTcpPortBindingImpl: async (_candidate, options) => {
        bindingBudgets.push(options.timeoutMs);
        now += options.timeoutMs;
        return { status: 'timeout', reason: 'port-bind-timeout' };
      },
    }),
    (error) => error?.code === 'EPORTALLOCATIONTIMEOUT',
  );

  assert.deepEqual(bindingBudgets, [250, 50]);
  assert.equal(now, 300);
});

test('pickNextFreeTcpPort aborts an in-flight boundary at its absolute deadline', { timeout: 2000 }, async () => {
  let activeBindings = 0;
  const startedAt = Date.now();

  await assert.rejects(
    () => pickNextFreeTcpPort(46000, {
      tries: 1,
      totalTimeoutMs: 30,
      networkInterfacesImpl: () => completeNetworkInterfaceInventory({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      }),
      probeTcpPortBindingImpl: async (_candidate, { signal }) => await new Promise((resolve) => {
        activeBindings += 1;
        const timer = setTimeout(() => {
          activeBindings -= 1;
          resolve({ status: 'timeout', reason: 'fixture-timeout' });
        }, 500);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          activeBindings -= 1;
          resolve({ status: 'timeout', reason: 'port-bind-aborted' });
        }, { once: true });
      }),
    }),
    (error) => error?.code === 'EPORTALLOCATIONTIMEOUT',
  );

  assert.ok(Date.now() - startedAt < 200, 'allocator must settle at the absolute deadline');
  assert.equal(activeBindings, 0);
});

test('listListenPids retains its best-effort empty fallback when listener discovery is unsupported', async () => {
  const pids = await listListenPids(34567, {
    resolveCommandPathImpl: async () => '',
    platform: 'linux',
  });
  assert.deepEqual(pids, []);
});

test('listListenPidsWithStatus discovers Windows listeners through netstat', async () => {
  const ports = await import('./ports.mjs');
  const out = await ports.listListenPidsWithStatus(45678, {
    platform: 'win32',
    resolveCommandPathImpl: async (command) => command === 'netstat' ? 'C:\\Windows\\System32\\netstat.exe' : '',
    runCaptureImpl: async () => [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:45678          0.0.0.0:0              LISTENING       321',
      '  TCP    [::]:45678             [::]:0                 LISTENING       321',
    ].join('\n'),
  });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.pids, [321]);
});

test('listListenPidsWithStatus uses the supplied environment to resolve the discovery command', async () => {
  const ports = await import('./ports.mjs');
  const env = { PATH: '/fixture/bin' };
  let resolverOptions = null;

  const out = await ports.listListenPidsWithStatus(45678, {
    env,
    platform: 'linux',
    resolveCommandPathImpl: async (_command, options) => {
      resolverOptions = options;
      return '/fixture/bin/lsof';
    },
    runCaptureImpl: async () => '321\n',
  });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.pids, [321]);
  assert.equal(resolverOptions?.env, env);
});

test('listListenPidsWithStatus keeps process-group filtering unsupported on Windows', async () => {
  const ports = await import('./ports.mjs');
  let commands = 0;

  const out = await ports.listListenPidsWithStatus(45678, {
    platform: 'win32',
    processGroupId: 44,
    resolveCommandPathImpl: async () => 'C:\\Windows\\System32\\netstat.exe',
    runCaptureImpl: async () => {
      commands += 1;
      return 'TCP 0.0.0.0:45678 0.0.0.0:0 LISTENING 321';
    },
  });

  assert.deepEqual(out, {
    status: 'unsupported',
    supported: false,
    pids: [],
    reason: 'process-group-listener-discovery-unsupported',
  });
  assert.equal(commands, 0);
});

test('listListenPidsWithStatus preserves listener discovery timeout as inconclusive evidence', async () => {
  const ports = await import('./ports.mjs');
  const timeout = Object.assign(new Error('lsof timed out'), { code: 'ETIMEDOUT' });

  const out = await ports.listListenPidsWithStatus(34567, {
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async () => {
      throw timeout;
    },
    platform: 'linux',
  });

  assert.deepEqual(out, {
    status: 'timeout',
    supported: true,
    pids: [],
    reason: 'listener-discovery-timeout',
  });
});

test('listListenPidsWithStatus can constrain Unix listener discovery to one process group', async () => {
  const ports = await import('./ports.mjs');
  let capturedArgs = null;

  const out = await ports.listListenPidsWithStatus(34567, {
    processGroupId: 44,
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async (_command, args) => {
      capturedArgs = args;
      return '301\n';
    },
    platform: 'darwin',
  });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.pids, [301]);
  assert.deepEqual(capturedArgs, [
    '-nP',
    '-a',
    '-g',
    '44',
    '-iTCP:34567',
    '-sTCP:LISTEN',
    '-t',
  ]);
});

test('listListenPidsWithStatus can constrain Unix listener discovery to exact candidate pids', async () => {
  const ports = await import('./ports.mjs');
  let capturedArgs = null;

  const out = await ports.listListenPidsWithStatus(34567, {
    candidatePids: [301, 302, 301, 0],
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async (_command, args) => {
      capturedArgs = args;
      return '301\n999\n';
    },
    platform: 'darwin',
  });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.pids, [301]);
  assert.deepEqual(capturedArgs, [
    '-nP',
    '-a',
    '-p',
    '301,302',
    '-iTCP:34567',
    '-sTCP:LISTEN',
    '-t',
  ]);
});

test('listListenPidsWithStatus filters Windows listener evidence to exact candidate pids', async () => {
  const ports = await import('./ports.mjs');
  const out = await ports.listListenPidsWithStatus(45678, {
    candidatePids: [321],
    platform: 'win32',
    resolveCommandPathImpl: async () => 'C:\\Windows\\System32\\netstat.exe',
    runCaptureImpl: async () => [
      'TCP 0.0.0.0:45678 0.0.0.0:0 LISTENING 321',
      'TCP [::]:45678 [::]:0 LISTENING 654',
    ].join('\n'),
  });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.pids, [321]);
});

test('listListenPidsWithStatus treats a silent Unix lsof exit 1 as an empty listener set', async () => {
  const ports = await import('./ports.mjs');
  const noMatches = Object.assign(new Error('lsof found no matching listeners'), {
    code: 'EEXIT',
    exitCode: 1,
    out: '',
    err: '',
  });

  const out = await ports.listListenPidsWithStatus(34567, {
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async () => {
      throw noMatches;
    },
    platform: 'linux',
  });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.pids, []);
});

test('listListenPidsWithStatus preserves a diagnostic Unix lsof exit 1 as an error', async () => {
  const ports = await import('./ports.mjs');
  const failure = Object.assign(new Error('lsof failed'), {
    code: 'EEXIT',
    exitCode: 1,
    out: '',
    err: 'lsof: permission denied',
  });

  const out = await ports.listListenPidsWithStatus(34567, {
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async () => {
      throw failure;
    },
    platform: 'linux',
  });

  assert.equal(out.status, 'error');
  assert.equal(out.reason, 'listener-discovery-error');
  assert.deepEqual(out.pids, []);
});

test('listListenPidsWithStatus preserves a Windows netstat exit 1 as an error', async () => {
  const ports = await import('./ports.mjs');
  const failure = Object.assign(new Error('netstat failed'), {
    code: 'EEXIT',
    exitCode: 1,
    out: '',
    err: 'Access is denied',
  });

  const out = await ports.listListenPidsWithStatus(45678, {
    platform: 'win32',
    resolveCommandPathImpl: async () => 'C:\\Windows\\System32\\netstat.exe',
    runCaptureImpl: async () => {
      throw failure;
    },
  });

  assert.equal(out.status, 'error');
  assert.equal(out.reason, 'listener-discovery-error');
  assert.deepEqual(out.pids, []);
});

test('listListenPidsWithStatus distinguishes command failure from an empty listener set', async () => {
  const ports = await import('./ports.mjs');
  const failure = Object.assign(new Error('lsof failed'), { code: 'EACCES' });

  const out = await ports.listListenPidsWithStatus(34567, {
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async () => {
      throw failure;
    },
    platform: 'linux',
  });

  assert.equal(out.status, 'error');
  assert.equal(out.supported, true);
  assert.deepEqual(out.pids, []);
  assert.equal(out.reason, 'listener-discovery-error');
});

test('listListenPidsWithStatus excludes Windows connection rows that netstat mislabels as LISTENING', async () => {
  const { listListenPidsWithStatus } = await import('./ports.mjs');
  const observation = await listListenPidsWithStatus(53944, {
    platform: 'win32',
    resolveCommandPathImpl: async () => 'C:\\Windows\\System32\\netstat.exe',
    runCaptureImpl: async () => [
      '  TCP    127.0.0.1:53944        127.0.0.1:0            LISTENING       111',
      '  TCP    127.0.0.1:53944        127.0.0.1:62454        LISTENING       222',
      '  TCP    [::1]:53944            [::1]:0                LISTENING       333',
      '  TCP    0.0.0.0:53944          0.0.0.0:0              LISTENING       444',
      '  TCP    [::]:53944             [::]:0                 LISTENING       555',
    ].join('\n'),
  });

  assert.deepEqual(observation, { status: 'ok', supported: true, pids: [444, 555] });
});
