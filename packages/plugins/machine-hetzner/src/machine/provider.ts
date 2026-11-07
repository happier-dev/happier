import { createHetznerNativeClient } from './nativeClient.js';
import { MACHINE_PROVISIONER_CLOUD_SSH_USER } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { HetznerNativeClientOptions } from './nativeClient.js';
import { HetznerAcquireV1Schema, HetznerNativeError, parseHetznerValue } from './schemas.js';

export const HETZNER_PLUGIN_ID = 'happier.machine.hetzner';
export const HETZNER_PROVISIONER_ID = 'hetzner';
function firstIpv6Host(subnet: string | undefined) {
  if (!subnet) return undefined;
  // Hetzner assigns ::1 in the returned /64 to its default cloud images.
  // https://docs.hetzner.com/cloud/servers/faq/#why-can-i-not-connect-to-my-ipv6-only-cloud-server
  const [prefix, width] = subnet.split('/');
  if (width !== '64') throw new HetznerNativeError('native_ssh_address_unavailable');
  try {
    const network = new URL(`http://[${prefix}]/`).hostname.slice(1, -1);
    if (network.endsWith('::')) return `${network}1`;
  } catch { /* Invalid native addresses never reach SSH. */ }
  throw new HetznerNativeError('native_ssh_address_unavailable');
}
/** Vendor facts only. The host owns custody, enrollment, SSH trust and installation. */
export function createHetznerProvider(options: HetznerNativeClientOptions) {
  const native = createHetznerNativeClient(options);
  return {
    check: native.check, options: native.options, inspect: native.inspect,
    recover: native.recover, power: native.power, destroy: native.destroy,
    async acquire(rawInput: unknown) {
      const input = parseHetznerValue(HetznerAcquireV1Schema, rawInput);
      if (!input.launch.publicNetworking.ipv4 && !input.launch.publicNetworking.ipv6) {
        return { kind: 'rejected' as const, code: 'native_ssh_network_unavailable', nativeCause: { localCause: 'native_ssh_network_unavailable' as const } };
      }
      return native.acquire(input);
    },
    async bootstrap(rawResource: unknown) {
      const observed = await native.inspect(rawResource);
      if (observed.kind === 'absent') throw new HetznerNativeError('native_identity_not_found');
      // Only an observed native start can advance without another user effect.
      // Stopping, deleting and unknown transitions do not prove startup.
      if (['initializing', 'starting'].includes(observed.server.status)) throw new HetznerNativeError('native_not_ready');
      if (observed.power !== 'running') throw new HetznerNativeError('native_resource_unavailable');
      const address = observed.server.public_net.ipv4?.ip ?? firstIpv6Host(observed.server.public_net.ipv6?.ip);
      if (!address) throw new HetznerNativeError('native_not_ready');
      // Local-only address facts are not public Action results or enrollment carriers.
      return { kind: 'ssh' as const, address, port: 22, username: MACHINE_PROVISIONER_CLOUD_SSH_USER };
    },
  };
}
