import { describe, expect, it, vi } from 'vitest';

import { promptSpeechEndpointChange } from './endpointConsent';

describe('speech endpoint consent interaction', () => {
  it('binds HTTP consent to the exact normalized origin and selected machine', async () => {
    const confirmInsecureOrigin = vi.fn(async () => true);
    await expect(promptSpeechEndpointChange({
      currentBaseUrl: '', currentConsent: '', currentConsentMachineId: '',
      machineId: 'machine-a', machineLabel: 'Machine A',
      promptBaseUrl: async () => 'http://localhost:11434/v1',
      confirmInsecureOrigin,
      showInvalidEndpoint: vi.fn(),
    })).resolves.toEqual({
      baseUrl: 'http://localhost:11434/v1',
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: 'machine-a',
    });
    expect(confirmInsecureOrigin).toHaveBeenCalledWith({ origin: 'http://localhost:11434', machineLabel: 'Machine A' });
  });

  it('clears prior consent for HTTPS and refuses HTTP without a selected machine', async () => {
    await expect(promptSpeechEndpointChange({
      currentBaseUrl: '', currentConsent: 'http://old', currentConsentMachineId: 'machine-a',
      machineId: 'machine-a', machineLabel: 'Machine A',
      promptBaseUrl: async () => 'https://speech.example/v1',
      confirmInsecureOrigin: vi.fn(), showInvalidEndpoint: vi.fn(),
    })).resolves.toEqual({
      baseUrl: 'https://speech.example/v1',
      insecureLocalOriginConsent: '',
      insecureLocalConsentMachineId: '',
    });
    const invalid = vi.fn();
    await expect(promptSpeechEndpointChange({
      currentBaseUrl: '', currentConsent: '', currentConsentMachineId: '',
      machineId: null, machineLabel: null,
      promptBaseUrl: async () => 'http://localhost:11434/v1',
      confirmInsecureOrigin: vi.fn(), showInvalidEndpoint: invalid,
    })).resolves.toBeNull();
    expect(invalid).toHaveBeenCalledWith('machine_unavailable');
  });
});
