import { expect, it } from 'vitest';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { options } from './options.js';
import { Agent37LaunchSchema } from './schemas.js';

it('offers Performance at four times container compute in every documented region', () => {
  for (const location of ['us', 'eu', 'ap-south']) {
    const selected = projectMachineProvisionerSelectionV1({ options: options(), launchSchema: Agent37LaunchSchema.jsonSchema,
      selection: { image: 'performance', size: '2-4', location } });
    expect(selected).toMatchObject({ kind: 'ready', guestPlatform: 'linux', launch: { kind: 'performance', region: location },
      prices: [{ amount: '18.68', currency: 'USD' }] });
  }
});
