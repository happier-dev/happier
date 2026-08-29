import { describe, expect, it } from 'vitest';
import { IrohTestController } from './irohTestController';

describe('IrohTestController', () => {
  it('forces direct and relay paths for native fixtures', () => {
    const controller = new IrohTestController();
    controller.forceDirectOnly();
    controller.assertForcedPath('direct');
    controller.forceRelayOnly();
    controller.assertForcedPath('relay');
    controller.restoreAutomatic();
    expect(controller.getObservedPath()).toBe('unknown');
  });

  it('fails closed when relay is disabled', () => {
    const controller = new IrohTestController({ policy: 'disabled' });
    expect(() => controller.forceRelayOnly()).toThrow(/relay policy is disabled/);
  });
});
