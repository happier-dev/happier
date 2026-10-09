import { createDigitalOceanNativeClient } from './nativeClient.js';
import { dropletAcquireInputSchema, type NativeImage } from './schemas.js';

function supportsBootstrap(image: NativeImage): boolean {
  // DigitalOcean's provide-user-data documentation (verified 2026-10-08)
  // documents root cloud-init on its Ubuntu/CentOS images. This is the
  // currently evidenced subset, not a claim that other native images are
  // unavailable. The host installer owns guest architecture detection.
  return image.type === 'base' && (image.distribution === 'Ubuntu' || image.distribution === 'CentOS');
}

export function createDigitalOceanProvider(options: Parameters<typeof createDigitalOceanNativeClient>[0]) {
  const client = createDigitalOceanNativeClient(options);
  async function discover() {
    const result = await client.options();
    return result.kind === 'available' ? { ...result, images: result.images.map(image => ({ ...image, bootstrapSupported: supportsBootstrap(image) })) } : result;
  }
  return {
    check: client.check,
    options: discover,
    inspect: client.inspect,
    recover: client.recover,
    observeAction: client.observeAction,
    power: client.power,
    destroy: client.destroy,
    async acquire(raw: Parameters<typeof client.create>[0]) {
      const input = dropletAcquireInputSchema.parse(raw);
      const launch = input.launch;
      const facts = await discover();
      if (facts.kind !== 'available') return facts;
      const region = facts.regions.find(value => value.slug === launch.regionSlug && value.available);
      const size = facts.sizes.find(value => value.slug === launch.sizeSlug && value.available && value.regions.includes(launch.regionSlug));
      const image = facts.images.find(value => (typeof launch.imageId === 'number' ? value.id === launch.imageId : value.slug === launch.imageId) && value.bootstrapSupported && value.status === 'available' && value.regions.includes(launch.regionSlug));
      if (!region || !size || !image || !region.sizes.includes(launch.sizeSlug)) return { kind: 'rejected', reason: 'launch-unavailable' } as const;
      return client.create(input);
    },
    bootstrap: client.observeResourceActions,
  };
}
