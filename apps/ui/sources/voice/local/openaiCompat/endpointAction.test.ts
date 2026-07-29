import { describe, expect, it, vi } from 'vitest';

import { promptOpenAiCompatEndpointChange } from './endpointAction';

describe('promptOpenAiCompatEndpointChange', () => {
  it('normalizes HTTPS and clears stale insecure-origin consent', async () => {
    await expect(promptOpenAiCompatEndpointChange({
      currentBaseUrl: 'http://localhost:11434/v1',
      currentConsent: 'http://localhost:11434',
      currentConsentMachineId: 'machine-a',
      machineId: 'machine-a',
      machineLabel: 'Studio Mac',
      promptBaseUrl: async () => ' HTTPS://API.EXAMPLE.TEST/v1/ ',
      confirmInsecureOrigin: vi.fn(),
      showInvalidEndpoint: vi.fn(),
    })).resolves.toEqual({
      baseUrl: 'https://api.example.test/v1/',
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
    });
  });

  it('binds HTTP consent to the exact normalized origin and names the execution machine', async () => {
    const confirmInsecureOrigin = vi.fn(async () => true);

    await expect(promptOpenAiCompatEndpointChange({
      currentBaseUrl: null,
      currentConsent: null,
      currentConsentMachineId: null,
      machineId: 'machine-a',
      machineLabel: 'Studio Mac',
      promptBaseUrl: async () => 'http://LOCALHOST:11434/v1/',
      confirmInsecureOrigin,
      showInvalidEndpoint: vi.fn(),
    })).resolves.toEqual({
      baseUrl: 'http://localhost:11434/v1/',
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: 'machine-a',
    });

    expect(confirmInsecureOrigin).toHaveBeenCalledWith({
      origin: 'http://localhost:11434',
      machineLabel: 'Studio Mac',
    });
  });

  it('refuses to mint HTTP consent without a selected online machine', async () => {
    const confirmInsecureOrigin = vi.fn();
    const showInvalidEndpoint = vi.fn();

    await expect(promptOpenAiCompatEndpointChange({
      currentBaseUrl: null,
      currentConsent: null,
      currentConsentMachineId: null,
      machineId: null,
      machineLabel: null,
      promptBaseUrl: async () => 'http://192.168.1.20:8000/v1',
      confirmInsecureOrigin,
      showInvalidEndpoint,
    })).resolves.toBeNull();

    expect(confirmInsecureOrigin).not.toHaveBeenCalled();
    expect(showInvalidEndpoint).toHaveBeenCalledWith('machine_unavailable');
  });

  it('invalidates consent on origin change and leaves the old value untouched when confirmation is declined', async () => {
    await expect(promptOpenAiCompatEndpointChange({
      currentBaseUrl: 'http://localhost:11434/v1',
      currentConsent: 'http://localhost:11434',
      currentConsentMachineId: 'machine-a',
      machineId: 'machine-a',
      machineLabel: 'Studio Mac',
      promptBaseUrl: async () => 'http://localhost:11435/v1',
      confirmInsecureOrigin: async () => false,
      showInvalidEndpoint: vi.fn(),
    })).resolves.toBeNull();
  });

  it('rejects userinfo and query-bearing endpoints without persisting them', async () => {
    const showInvalidEndpoint = vi.fn();
    for (const value of [
      'https://user:secret@example.test/v1',
      'https://example.test/v1?api_key=secret',
    ]) {
      await expect(promptOpenAiCompatEndpointChange({
        currentBaseUrl: null,
        currentConsent: null,
        currentConsentMachineId: null,
        machineId: 'machine-a',
        machineLabel: 'Studio Mac',
        promptBaseUrl: async () => value,
        confirmInsecureOrigin: vi.fn(),
        showInvalidEndpoint,
      })).resolves.toBeNull();
    }
    expect(showInvalidEndpoint).toHaveBeenCalledTimes(2);
  });
});
