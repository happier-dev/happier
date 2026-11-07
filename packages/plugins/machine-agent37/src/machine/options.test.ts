import { expect, it } from 'vitest';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { options } from './options.js';
import { Agent37LaunchSchema } from './schemas.js';

it('projects both guest kinds, every documented shape and region with kind-specific rates', () => {
  const result = MachineProvisionerOptionsResultV1Schema.parse(options());
  expect(result.dimensions.image.map(o => o.title)).toEqual(['VM: Ubuntu desktop', 'Container', 'Performance']);
  expect(result.dimensions.location.map(o => o.id)).toEqual(['us', 'eu', 'ap-south']);
  expect(result.dimensions.size.map(o => o.id)).toEqual(['2-4', '4-8', '4-16', '4-32']);
  for (const image of ['vm', 'default', 'performance']) {
    for (const size of result.dimensions.size) {
      const projected = projectMachineProvisionerSelectionV1({ options: result, launchSchema: Agent37LaunchSchema.jsonSchema,
        selection: { image, size: size.id, location: 'us' } });
      expect(projected).toMatchObject({ kind: 'ready', guestPlatform: 'linux', enrollmentRole: 'sandbox',
        launch: { kind: image, size: size.id, region: 'us' }, retention: { supportedIntents: ['start', 'stop', 'delete'] } });
      expect(projected.nativeFacts.size?.cpuCores).toBeLessThanOrEqual(4);
      expect(projected.prices).toHaveLength(1);
      if (size.id === '2-4') expect(projected.prices[0]).toMatchObject({ amount: image === 'vm' ? '12.08' : image === 'performance' ? '18.68' : '5.48', currency: 'USD' });
    }
  }
});
it('admits VM and Performance outside the US and excludes default containers there', () => {
  for (const location of ['eu', 'ap-south']) {
    const projected = projectMachineProvisionerSelectionV1({ options: options(), launchSchema: Agent37LaunchSchema.jsonSchema,
      selection: { image: 'default', size: '2-4', location } });
    expect(projected.kind).not.toBe('ready');
    expect(Agent37LaunchSchema.safeParse({ kind: 'default', size: '2-4', region: location }).success).toBe(false);
    expect(projectMachineProvisionerSelectionV1({ options: options(), launchSchema: Agent37LaunchSchema.jsonSchema,
      selection: { image: 'vm', size: '2-4', location } }).kind).toBe('ready');
  }
});
