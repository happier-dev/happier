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

  it('rejects shell-like basenames', () => {
    const badLookup = structuredClone(descriptor()) as any;
    badLookup.installedCheck.lookupNames = ['ollama;evil'];
    expect(ProviderDetectionDescriptorV1Schema.safeParse(badLookup).success).toBe(false);
  });

  it('requires availability probes to name the endpoint candidates use', () => {
    const missingEndpoint = structuredClone(descriptor()) as any;
    delete missingEndpoint.availabilityProbe.endpointTemplateId;
    expect(ProviderDetectionDescriptorV1Schema.safeParse(missingEndpoint).success).toBe(false);
  });

  it('rejects the retired private managed-start declaration', () => {
    expect(ProviderDetectionDescriptorV1Schema.safeParse({
      ...descriptor(),
      managedStart: { lookupNames: ['ollama'], fixedArgs: ['serve'] },
    }).success).toBe(false);
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
    // The command grammar stays bounded; the output *format* is not part of it.
    value.catalogFallback.fixedArgs = ['list; rm -rf /'];
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(false);
  });

  it('accepts a Provider-contributed command-output format while keeping the id grammar bounded', () => {
    const value = structuredClone(descriptor()) as any;
    value.catalogFallback = {
      endpointTemplateId: 'native',
      lookupNames: ['acme'],
      fixedArgs: ['models', '--plain'],
      parser: 'acme-list-v1',
    };
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(true);

    value.catalogFallback.parser = 'acme list v1';
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(false);
  });

  it('keeps the local-readiness shortcut vocabulary closed to the two host-implemented criteria', () => {
    // Unlike the catalog formats, `presenceCheck` names a host-implemented
    // criterion with no plugin-supplied implementation behind it. It refines a
    // discovery status label; readiness itself is decided by the required,
    // open-format `availabilityProbe`.
    const value = structuredClone(descriptor()) as any;
    value.presenceCheck = { lookupNames: ['lms'], fixedArgs: ['daemon', 'status'], parser: 'exit-zero-running' };
    expect(ProviderDetectionDescriptorV1Schema.safeParse(value).success).toBe(true);
    value.presenceCheck.parser = 'acme-status-json';
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
