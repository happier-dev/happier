import { createDigitalOceanNativeClient } from './nativeClient.js';
import { dropletAcquireInputSchema } from './schemas.js';
import { projectDigitalOceanOptions } from './options.js';

export function createDigitalOceanProvider(options: Parameters<typeof createDigitalOceanNativeClient>[0]) {
  const client = createDigitalOceanNativeClient(options);
  return {
    check: client.check,
    async options() { return projectDigitalOceanOptions(await client.options()); },
    inspect: client.inspect,
    recover: client.recover,
    observeAction: client.observeAction,
    power: client.power,
    destroy: client.destroy,
    async acquire(raw: Parameters<typeof client.create>[0]) {
      const input = dropletAcquireInputSchema.parse(raw);
      return client.create(input);
    },
    bootstrap: client.observeResourceActions,
  };
}
