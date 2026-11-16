import { describe, expect, it } from 'vitest';
import { MachineProvisionerAcquireResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createLumeNativeClientForTest as createLumeNativeClient } from './nativeClient.testkit.js';
import { createLumeProvider } from './provider.js';

const resource = { storage: 'home', vmName: 'happier-capacity' };
const launch = { image: { kind: 'native-image', reference: 'ghcr.io/trycua/macos:26' },
  storage: 'home', cpu: 2, memoryBytes: 4294967296, diskBytes: 161061273600 };
const vm = { name: resource.vmName, locationName: resource.storage, status: 'stopped', os: 'macOS',
  cpuCount: launch.cpu, memorySize: launch.memoryBytes, diskSize: { allocated: 31906562048, total: launch.diskBytes },
  ipAddress: null, sshAvailable: null, provisioningOperation: null };
const running = [0, 1].map(index => ({ ...vm, name: `other-${index}`, locationName: index ? 'external' : 'home',
  status: 'running', ipAddress: `192.0.2.${index + 1}`, sshAvailable: true }));
const nativeCause = { localCause: 'native_macos_vm_limit_reached' };

// Only Lume's serve HTTP boundary is replaced. Bodies follow GET /lume/vms
// observed on mac-host (Lume 0.6.1, 2026-11-06); locations span the whole host.
function setup(inventory: unknown = [vm, ...running], target = vm) {
  const requests: string[] = [];
  const native = createLumeNativeClient({ baseUrl: 'http://localhost:7778', fetch: async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === '/lume/vms') return Response.json(inventory);
    if (url.pathname === `/lume/vms/${resource.vmName}`) return Response.json(target);
    if (url.pathname === '/lume/config/locations') return Response.json([{ name: 'home' }]);
    if (url.pathname === '/lume/host/status') return Response.json({ version: '0.6.1' });
    if (url.pathname === '/lume/config') return Response.json({ cachingEnabled: true });
    if (url.pathname === '/lume/pull') return Response.json({ name: resource.vmName, image: 'macos:26' });
    if (url.pathname === '/token') return Response.json({ token: 'anonymous-token' });
    if (url.pathname.includes('/manifests/')) return Response.json({ annotations: { 'org.trycua.lume.disk-size': String(launch.diskBytes) } });
    if (url.pathname.endsWith('/run')) return Response.json({ message: 'VM start initiated', name: resource.vmName, status: 'pending' }, { status: 202 });
    throw new Error('Unexpected native request');
  } });
  return { native, requests, provider: createLumeProvider({ native, observedAt: 123 }) };
}

describe('Lume host macOS capacity', () => {
  it.each([0, 1, 2])('discloses %s running macOS guests in ordinary options without another inventory read', async count => {
    const { provider, requests } = setup([vm, ...running.slice(0, count), ...running.map(item => ({ ...item, os: 'linux' }))]);
    const result = MachineProvisionerOptionsResultV1Schema.parse(await provider.options(launch));
    expect(result.dimensions.image[0]?.nativeFacts?.image?.description).toMatchObject({
      key: 'machineLume.configure.macosVmCount', params: { count, limit: 2 },
    });
    expect(result.dimensions.image[0]?.available).toBe(count < 2);
    if (count === 2) expect(result.dimensions.image[0]?.unavailableReason?.status).toMatchObject({ params: { count, limit: 2 } });
    expect(requests.filter(request => request === 'GET /lume/vms')).toHaveLength(1);
    expect(requests.filter(request => request.startsWith('POST'))).toEqual([]);
  });

  it('does not report zero running guests when the native inventory is unreadable', async () => {
    const { provider } = setup({ error: 'unreadable inventory' });
    const result = MachineProvisionerOptionsResultV1Schema.parse(await provider.options(launch));
    expect(result.dimensions.image[0]?.nativeFacts?.image?.description).toMatchObject({
      key: 'machineLume.configure.macosVmCountUnavailable',
    });
  });

  it('retains native custody when capacity refuses Start after the fresh acquire has pulled a VM', async () => {
    const { provider, requests } = setup();
    expect(MachineProvisionerAcquireResultV1Schema.parse(await provider.acquire(launch, 'capacity')))
      .toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource }, nativeCause });
    expect(requests.filter(request => request === 'POST /lume/pull')).toHaveLength(1);
    expect(requests.filter(request => request.endsWith('/run'))).toEqual([]);
  });

  it('settles acquire and Start with a visible typed cause without dispatching a third native start', async () => {
    const { provider, requests } = setup();
    expect(MachineProvisionerAcquireResultV1Schema.parse(await provider.acquire(launch, 'capacity', resource)))
      .toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource }, nativeCause });
    expect(MachineProvisionerPowerResultV1Schema.parse(await provider.power(resource, 'start')))
      .toMatchObject({ kind: 'refused', code: 'native_macos_vm_limit_reached', nativeCause });
    expect(requests.filter(request => request.startsWith('POST'))).toEqual([]);
  });

  it('keeps stopped observation exact at capacity so a retained Stop can settle and Start keeps its native refusal', async () => {
    const { provider, requests } = setup();
    expect(MachineProvisionerObservationV1Schema.parse(await provider.inspect(resource)))
      .toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
    expect(requests.filter(request => request === 'GET /lume/vms')).toHaveLength(0);
    expect(MachineProvisionerPowerResultV1Schema.parse(await provider.power(resource, 'start')))
      .toMatchObject({ kind: 'refused', code: 'native_macos_vm_limit_reached', nativeCause });
    expect(MachineProvisionerObservationV1Schema.parse(await provider.inspect(resource)))
      .toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
    expect(requests.filter(request => request.endsWith('/run'))).toEqual([]);
  });

  it('discloses the native capacity refusal before Create through the existing option presentation', async () => {
    const { provider, requests } = setup();
    const options = MachineProvisionerOptionsResultV1Schema.parse(await provider.options(launch));
    expect(options.dimensions.image[0]).toMatchObject({ available: false,
      unavailableReason: { code: 'native_macos_vm_limit_reached', status: { params: { count: 2 } } } });
    expect(requests.filter(request => request === 'GET /lume/vms')).toHaveLength(1);
    expect(requests.filter(request => request.startsWith('POST'))).toEqual([]);
  });

  it.each([
    ['one running macOS guest', [vm, running[0]]],
    ['two running Linux guests', [vm, ...running.map(item => ({ ...item, os: 'linux' }))]],
    ['already running target', [{ ...vm, status: 'running' }, running[0]]],
    ['Linux target at macOS capacity', [{ ...vm, os: 'linux' }, ...running]],
  ])('keeps native Start available with %s', async (_name, inventory) => {
    const { native, requests } = setup(inventory);
    expect(await native.run(resource)).toMatchObject({ kind: 'start-accepted' });
    expect(requests.filter(request => request.endsWith('/run'))).toHaveLength(1);
  });
});
