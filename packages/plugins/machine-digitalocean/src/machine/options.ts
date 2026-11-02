import type { MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { createDigitalOceanNativeClient } from './nativeClient.js';
import type { NativeImage } from './schemas.js';

type NativeOptions = Awaited<ReturnType<ReturnType<typeof createDigitalOceanNativeClient>['options']>>;

function supportsBootstrap(image: NativeImage): boolean {
  // DigitalOcean's provide-user-data documentation (verified 2026-10-08)
  // documents root cloud-init on these base images. Architecture is detected
  // by the host installer; an image name is not architecture evidence.
  return image.type === 'base' && (image.distribution === 'Ubuntu' || image.distribution === 'CentOS');
}

/** Native dimensions and constraints for reviewing a launch. */
export function projectDigitalOceanOptions(facts: NativeOptions): MachineProvisionerOptionsResultV1 {
  if (facts.kind !== 'available') return { dimensions: { size: [], image: [], location: [], network: [], duration: [] },
    code: 'provider_unavailable', };
  const images = facts.images.filter(supportsBootstrap);
  const regionIds = new Set(facts.regions.map(region => region.slug));
  return { base: { launch: {}, }, dimensions: {
    size: facts.sizes.map(size => ({
      id: size.slug, title: `${size.slug} · ${size.vcpus} CPU · ${size.memory} MB · ${size.disk} GB`,
      assignments: [{ path: 'sizeSlug', value: size.slug }], available: size.available, prices: size.prices,
      nativeFacts: { size: { id: size.slug, title: size.slug,
        cpuCores: size.vcpus, memoryBytes: size.memory * 1024 ** 2, diskBytes: size.disk * 1000 ** 3 },
        monthlyCapStatus: size.monthlyCapStatus }, })),
    image: images.map(image => ({
      id: String(image.id), title: image.name, assignments: [{ path: 'imageId', value: image.id }],
      available: image.status === 'available', nativeFacts: { image: { id: String(image.id), title: image.name,
        ...(image.description ? { description: image.description } : {}) } }, })),
    location: facts.regions.map(region => ({
      id: region.slug, title: region.name, assignments: [{ path: 'regionSlug', value: region.slug }], available: region.available,
      nativeFacts: { location: { id: region.slug, title: region.name } }, })),
    network: [false, true].map(ipv6 => ({
      id: String(Number(ipv6)), title: ipv6 ? 'IPv4 + IPv6' : 'IPv4',
      assignments: [{ path: 'publicNetworking.ipv6', value: ipv6 }], nativeFacts: {
        network: { id: String(Number(ipv6)), title: ipv6 ? 'IPv4 + IPv6' : 'IPv4' }, }, })), duration: [], }, constraints: [
    ...facts.sizes.map(size => ({ when: { dimension: 'size' as const, optionIds: [size.slug] },
      requires: { dimension: 'location' as const, optionIds: facts.regions
        .filter(region => size.regions.includes(region.slug) && region.sizes.includes(size.slug)).map(region => region.slug) } })),
    ...images.map(image => ({ when: { dimension: 'image' as const, optionIds: [String(image.id)] },
      requires: { dimension: 'location' as const, optionIds: image.regions.filter(region => regionIds.has(region)) } })),
  ] };
}
