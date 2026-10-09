import { createHetznerNativeClient } from './nativeClient.js';
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
        return { kind: 'rejected' as const, code: 'native_ssh_network_unavailable' };
      }
      const current = await native.options();
      const size = current.sizes.find(value => value.name === input.launch.serverTypeId || String(value.id) === input.launch.serverTypeId);
      const images = current.images.filter(value => (value.name === input.launch.imageId || String(value.id) === input.launch.imageId)
        && value.architecture === size?.architecture && value.status === 'available' && value.deprecated === null);
      const image = images.length === 1 ? images[0] : undefined;
      const location = current.locations.find(value => value.name === input.launch.locationId || String(value.id) === input.launch.locationId);
      if (!size || !image || !location || image.status !== 'available' || image.deprecated !== null || size.architecture !== image.architecture
        || !size.prices.some(value => value.location === location.name)
        || (size.deprecation?.unavailable_after && Date.parse(size.deprecation.unavailable_after) <= current.observedAt)) {
        return { kind: 'rejected' as const, code: 'native_options_changed' };
      }
      return native.acquire(input);
    },
    async bootstrap(rawResource: unknown) {
      const observed = await native.inspect(rawResource);
      if (observed.kind === 'absent') throw new HetznerNativeError('native_identity_not_found');
      if (observed.power !== 'running') throw new HetznerNativeError('native_not_ready');
      const address = observed.server.public_net.ipv4?.ip ?? firstIpv6Host(observed.server.public_net.ipv6?.ip);
      if (!address) throw new HetznerNativeError('native_ssh_address_unavailable');
      // Local-only address facts are not public Action results or enrollment carriers.
      return { kind: 'ssh' as const, address, port: 22, username: 'root' };
    },
  };
}
