import { describe, expect, it } from 'vitest';

import { ProviderDetectionDescriptorV1Schema } from './v1.js';

function descriptor() {
  return {
    v: 1,
    listener: { executableBasenames: ['ollama', 'LM Studio.exe'], argvMatch: { mode: 'containsAll', tokens: ['serve'] }, defaultPorts: [11434] },
    availabilityProbe: { endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' },
    installedCheck: { lookupNames: ['ollama', 'ollama.exe'] },
    managedStart: { lookupNames: ['ollama'], fixedArgs: ['serve'] },
  } as const;
}

describe('ProviderDetectionDescriptorV1Schema', () => {
  it('accepts platform executable basenames with dots, spaces and hyphens', () => {
    expect(ProviderDetectionDescriptorV1Schema.safeParse(descriptor()).success).toBe(true);
  });

  it.each(['/tmp/ollama', '../ollama', 'C:\\tools\\ollama.exe'])('rejects lookup path instead of PATH/application basename: %s', (lookupName) => {
    const value = structuredClone(descriptor()) as any;
    value.installedCheck.lookupNames = [lookupName];
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(false);
  });

  it('rejects shell-like basenames and environment-assignment argv while allowing ordinary flag values', () => {
    const badLookup = structuredClone(descriptor()) as any;
    badLookup.installedCheck.lookupNames = ['ollama;evil'];
    expect(ProviderDetectionDescriptorV1Schema.safeParse(badLookup).success).toBe(false);

    const badArg = structuredClone(descriptor()) as any;
    badArg.managedStart.fixedArgs = ['OLLAMA_HOST=127.0.0.1:11434'];
    expect(ProviderDetectionDescriptorV1Schema.safeParse(badArg).success).toBe(false);

    const goodArg = structuredClone(descriptor()) as any;
    goodArg.managedStart.fixedArgs = ['serve', '--host=127.0.0.1'];
    expect(ProviderDetectionDescriptorV1Schema.safeParse(goodArg).success).toBe(true);
  });

  it('requires availability probes to name the endpoint that candidates and managed starts use', () => {
    const missingEndpoint = structuredClone(descriptor()) as any;
    delete missingEndpoint.availabilityProbe.endpointTemplateId;
    expect(ProviderDetectionDescriptorV1Schema.safeParse(missingEndpoint).success).toBe(false);

    const staleManagedHealthPath = structuredClone(descriptor()) as any;
    staleManagedHealthPath.managedStart.healthPath = '/different/health';
    expect(ProviderDetectionDescriptorV1Schema.safeParse(staleManagedHealthPath).success).toBe(false);
  });
});
