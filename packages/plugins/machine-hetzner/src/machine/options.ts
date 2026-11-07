import type { MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { HETZNER_NETWORK_LABELS, HETZNER_PRICE_LABELS } from '../ui/translations.js';
import type { createHetznerNativeClient } from './nativeClient.js';

type HetznerOptions = Awaited<ReturnType<ReturnType<typeof createHetznerNativeClient>['options']>>;
// REST v1 Image.os_flavor (hcloud-python v2.11.0, images/domain.py).
// Unknown/custom images carry no guest-platform claim, regardless of their name.
const LINUX_IMAGE_FLAVORS = new Set(['ubuntu', 'centos', 'debian', 'fedora']);
function priceLabel(id: keyof typeof HETZNER_PRICE_LABELS.en) {
  return { key: `machineHetzner.prices.${id}`, fallback: HETZNER_PRICE_LABELS.en[id] };
}
/** Native public-networking choices; the id encodes the two flags. */
const PUBLIC_NETWORKING = [
  { ipv4: true, ipv6: false, label: 'ipv4' }, { ipv4: false, ipv6: true, label: 'ipv6' }, { ipv4: true, ipv6: true, label: 'dual' },
] as const;

/** Native dimensions and constraints for reviewing a launch. */
export function projectHetznerOptions(facts: HetznerOptions): MachineProvisionerOptionsResultV1 {
  const images = facts.images.filter(image => image.status === 'available' && image.deprecated === null);
  const locationIds = new Set(facts.locations.map(location => location.name));
  return { base: { launch: {} }, dimensions: {
    size: facts.sizes.map(size => ({
      id: String(size.id), title: size.name, assignments: [{ path: 'serverTypeId', value: String(size.id) }],
      available: size.prices.length > 0,
      prices: size.prices.filter(price => locationIds.has(price.location)).flatMap(price => [price.hourly, price.monthly].map(nativePrice => ({
        ...nativePrice, label: priceLabel('compute'), when: [{ dimension: 'location' as const, optionIds: [price.location] }],
      }))),
      nativeFacts: { size: { id: String(size.id), title: size.name, cpuCores: size.cores,
        memoryBytes: size.memory * 1024 ** 3, diskBytes: size.disk * 1000 ** 3 } },
    })),
    image: images.map(image => {
      const title = `${image.name ?? String(image.id)} (${image.architecture === 'arm' ? 'ARM64' : 'x86-64'})`;
      return {
        id: String(image.id), title, assignments: [{ path: 'imageId', value: String(image.id) }],
        ...(image.os_flavor && LINUX_IMAGE_FLAVORS.has(image.os_flavor) ? { guestPlatform: 'linux' as const } : {}),
        nativeFacts: { image: { id: String(image.id), title,
          ...(image.description ? { description: image.description } : {}) } },
      };
    }),
    location: facts.locations.map(location => ({
      id: location.name, title: location.description ?? location.name, assignments: [{ path: 'locationId', value: location.name }],
      prices: (facts.primaryIpPrices ?? []).flatMap(ip => ip.prices.filter(price => price.location === location.name)
        .flatMap(price => [price.hourly, price.monthly].map(nativePrice => ({
          ...nativePrice, label: priceLabel(ip.type === 'ipv4' ? 'primaryIpv4' : 'primaryIpv6'),
          // An IP add-on is never a stand-in for an unavailable compute rate.
          when: [{ dimension: 'size' as const, optionIds: facts.sizes
            .filter(size => size.prices.some(price => price.location === location.name)).map(size => String(size.id)) },
            { dimension: 'network' as const, optionIds: PUBLIC_NETWORKING.filter(network => network[ip.type])
              .map(network => `${Number(network.ipv4)}${Number(network.ipv6)}`) }],
        })))),
      nativeFacts: { location: { id: location.name, title: location.description ?? location.name,
        ...(location.country ? { countryCode: location.country } : {}) } },
    })),
    network: PUBLIC_NETWORKING.map(({ label, ...publicNetworking }) => ({
      id: `${Number(publicNetworking.ipv4)}${Number(publicNetworking.ipv6)}`,
      title: { key: `machineHetzner.network.${label}`, fallback: HETZNER_NETWORK_LABELS.en[label] },
      assignments: [{ path: 'publicNetworking', value: publicNetworking }], nativeFacts: {
        network: { id: `${Number(publicNetworking.ipv4)}${Number(publicNetworking.ipv6)}`,
          title: { key: `machineHetzner.network.${label}`, fallback: HETZNER_NETWORK_LABELS.en[label] } },
      },
    })), duration: [],
  }, constraints: [
    ...facts.sizes.map(size => ({ when: { dimension: 'size' as const, optionIds: [String(size.id)] },
      requires: { dimension: 'location' as const, optionIds: size.prices.filter(price => locationIds.has(price.location)).map(price => price.location) } })),
    ...[...new Set(facts.sizes.map(size => size.architecture))].map(architecture => ({
      when: { dimension: 'size' as const, optionIds: facts.sizes.filter(size => size.architecture === architecture).map(size => String(size.id)) },
      requires: { dimension: 'image' as const, optionIds: images.filter(image => image.architecture === architecture).map(image => String(image.id)) },
    })),
  ] };
}

