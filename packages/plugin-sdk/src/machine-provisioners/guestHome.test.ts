import { describe, expect, it } from 'vitest';

import { isMachineProvisionerGuestHomeOnControllerHost } from './index.public.js';

const guestHome = { origin: 'https://home.example.test:9443', addresses: ['100.64.0.5'] };

describe('isMachineProvisionerGuestHomeOnControllerHost', () => {
  it('uses the published host identity even when the Home URL has a different hostname', () => {
    expect(isMachineProvisionerGuestHomeOnControllerHost({
      ...guestHome,
      hostIdentity: { homeMachineHost: 'controller.local', controllerMachineHost: 'CONTROLLER' },
    })).toBe(true);
  });

  it('requires matching host identity', () => {
    expect(isMachineProvisionerGuestHomeOnControllerHost({
      ...guestHome,
      hostIdentity: { homeMachineHost: 'remote', controllerMachineHost: 'controller' },
    })).toBe(false);
    expect(isMachineProvisionerGuestHomeOnControllerHost(guestHome)).toBe(false);
    expect(isMachineProvisionerGuestHomeOnControllerHost()).toBe(false);
  });
});
