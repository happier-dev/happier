import { describe, expect, it } from 'vitest';

import {
  ProviderDetectionDescriptorV1Schema,
  ProviderDiscoveryCandidateV1Schema,
  ProviderLocalInstallationSummaryV1Schema,
} from './v1.js';

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

  it('accepts only the bounded trusted catalog-command fallback grammar', () => {
    const value = structuredClone(descriptor()) as any;
    value.catalogFallback = {
      endpointTemplateId: 'native',
      lookupNames: ['ollama'],
      fixedArgs: ['list'],
      parser: 'ollama-list-table',
      endpointEnvName: 'OLLAMA_HOST',
    };
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(true);

    value.catalogFallback.endpointEnvName = 'OLLAMA_HOST=evil';
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(false);
    value.catalogFallback.endpointEnvName = 'OLLAMA_HOST';
    value.catalogFallback.parser = 'arbitrary-command-output';
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(false);
  });
});

describe('ProviderDiscoveryCandidateV1Schema', () => {
  const candidate = {
    v: 1,
    machineId: 'machine-a',
    contributionKey: 'happier.provider.ollama/ollama',
    providerName: 'Ollama',
    endpointTemplateId: 'ollama-native',
    normalizedEndpointUrl: 'http://127.0.0.1:22434/',
    evidence: { kind: 'attributed_listener' },
    ownership: 'adopted',
    connection: { status: 'enable_default' },
  } as const;

  it('keeps a contribution candidate distinct from a configured connection', () => {
    expect(ProviderDiscoveryCandidateV1Schema.parse(candidate)).toEqual(candidate);
    expect(ProviderDiscoveryCandidateV1Schema.safeParse({
      ...candidate,
      connectionId: 'pc_ollama',
    }).success).toBe(false);
  });

  it('requires a connection id only for an exact endpoint match', () => {
    expect(ProviderDiscoveryCandidateV1Schema.safeParse({
      ...candidate,
      connection: { status: 'matched', connectionId: 'pc_ollama' },
    }).success).toBe(true);
    expect(ProviderDiscoveryCandidateV1Schema.safeParse({
      ...candidate,
      connection: { status: 'enable_default', connectionId: 'pc_ollama' },
    }).success).toBe(false);
  });

  it.each([
    'http://0.0.0.0:11434',
    'http://[::]:11434',
    'http://user:secret@127.0.0.1:11434',
    'http://127.0.0.1:11434?token=secret',
  ])('rejects unsafe or non-canonical candidate endpoint: %s', (normalizedEndpointUrl) => {
    expect(ProviderDiscoveryCandidateV1Schema.safeParse({
      ...candidate,
      normalizedEndpointUrl,
    }).success).toBe(false);
  });
});

describe('ProviderLocalInstallationSummaryV1Schema', () => {
  it('keeps installation/presence separate from endpoint availability and ownership', () => {
    const value = {
      v: 1,
      machineId: 'machine-a',
      contributionKey: 'happier.provider.lmstudio/lmstudio',
      providerName: 'LM Studio',
      status: 'app_running_server_off',
      managedStartAvailable: false,
    } as const;
    expect(ProviderLocalInstallationSummaryV1Schema.parse(value)).toEqual(value);
    expect(ProviderLocalInstallationSummaryV1Schema.safeParse({
      ...value, health: 'available', ownership: 'owned',
    }).success).toBe(false);
  });
});
