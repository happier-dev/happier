import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderWireProtocol,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import {
  CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
  CLIPROXYAPI_MANAGED_SDK_VERSION,
  MANAGED_PROVIDER_RUNTIME_ADAPTER,
  inspectCliProxyApiManagedRuntimeRecovery,
  prepareCliProxyApiManagedRuntime,
  parseCliProxyApiManagedRecoveryHealth,
  scanCliProxyApiManagedReadiness,
  type CliProxyApiManagedAuthEntry,
} from './managedRuntime.js';

const purpose: QualifiedConnectedAccountPurposeV1 = {
  consumer: {
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  },
  purpose: 'openai-upstream',
};

function authEntry(
  overrides: Partial<CliProxyApiManagedAuthEntry> = {},
): CliProxyApiManagedAuthEntry {
  return {
    id: 'codex',
    provider: 'codex',
    purpose,
    ...overrides,
  };
}

function input(overrides: Readonly<Record<string, unknown>> = {}) {
  const root = resolve('private', 'managed-provider-materialization');
  return {
    materializedRootDir: root,
    materializationId: 'managed-provider-session-a',
    downstreamBearer: 'runtime-only-downstream-secret',
    wrapperBuildVersion: '0.2.10',
    authEntries: [authEntry()],
    protocols: ['openai-responses'] as readonly ProviderWireProtocol[],
    modelListEnabled: false,
    requestAuth: {
      capabilityPath: resolve(root, 'request-auth', 'capability.json'),
    },
    ...overrides,
  };
}

describe('CLIProxyAPI managed runtime host adapter', () => {
  it('declares the immutable credential-free catalog source contract', () => {
    expect(MANAGED_PROVIDER_RUNTIME_ADAPTER.catalogSource).toEqual({
      kind: 'transientModelEndpoint',
      contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
      sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
    });
  });

  it('owns exact Agent endpoint materialization for each declared protocol template', () => {
    expect(MANAGED_PROVIDER_RUNTIME_ADAPTER.resolveAgentEndpoint({
      host: '127.0.0.1',
      port: 45_123,
      protocol: 'openai-responses',
      endpointTemplateId: 'cliproxyapi-openai-responses',
    })).toBe('http://127.0.0.1:45123/v1');
    expect(MANAGED_PROVIDER_RUNTIME_ADAPTER.resolveAgentEndpoint({
      host: '127.0.0.1',
      port: 45_123,
      protocol: 'anthropic',
      endpointTemplateId: 'cliproxyapi-anthropic',
    })).toBe('http://127.0.0.1:45123');
    expect(() => MANAGED_PROVIDER_RUNTIME_ADAPTER.resolveAgentEndpoint({
      host: '127.0.0.1',
      port: 45_123,
      protocol: 'anthropic',
      endpointTemplateId: 'cliproxyapi-openai-responses',
    })).toThrow(/endpoint/i);
  });

  it('owns the authorized-purpose to pinned SDK selector-entry mapping', async () => {
    const writeExclusive = vi.fn(async () => undefined);
    const anthropicPurpose: QualifiedConnectedAccountPurposeV1 = {
      ...purpose,
      purpose: 'anthropic-upstream',
    };

    await MANAGED_PROVIDER_RUNTIME_ADAPTER.prepare({
      ...input(),
      purposes: [purpose, anthropicPurpose],
      protocols: ['openai-responses', 'anthropic'],
    }, {
      writeExclusive,
      remove: vi.fn(async () => undefined),
    });

    const written = writeExclusive.mock.calls[0]?.[0];
    const document = JSON.parse(written?.contents ?? '{}') as {
      gateway?: { authEntries?: unknown };
    };
    expect(document.gateway?.authEntries).toEqual([{
      id: 'codex',
      provider: 'codex',
      purpose,
    }, {
      id: 'claude',
      provider: 'claude',
      purpose: anthropicPurpose,
    }]);

    await expect(MANAGED_PROVIDER_RUNTIME_ADAPTER.prepare({
      ...input(),
      purposes: [{ ...purpose, purpose: 'unknown-upstream' }],
    }, {
      writeExclusive,
      remove: vi.fn(async () => undefined),
    })).rejects.toThrow(/purpose/i);
    expect(writeExclusive).toHaveBeenCalledTimes(1);
  });

  it('writes one strict secret-bearing private config through the injected canonical primitive', async () => {
    const writeExclusive = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);

    const preparation = await prepareCliProxyApiManagedRuntime(input(), {
      writeExclusive,
      remove,
    });

    expect(preparation).toMatchObject({
      materializedRootDir: input().materializedRootDir,
      materializationId: 'managed-provider-session-a',
      expectedReadiness: {
        contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
        sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
      },
      prepared: {
        downstreamBearer: 'runtime-only-downstream-secret',
        protocols: ['openai-responses'],
        purposes: [purpose],
      },
    });
    expect(preparation.privateConfigPath).toBe(
      resolve(input().materializedRootDir, 'cliproxyapi-managed.json'),
    );
    expect(writeExclusive).toHaveBeenCalledTimes(1);
    const written = writeExclusive.mock.calls[0]?.[0];
    expect(written?.path).toBe(preparation.privateConfigPath);
    const document = JSON.parse(written?.contents ?? '{}') as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual([
      'gateway',
      'materializationId',
      'requestAuth',
      'v',
      'wrapperBuildVersion',
    ]);
    expect(document).toEqual({
      v: 1,
      materializationId: 'managed-provider-session-a',
      wrapperBuildVersion: '0.2.10',
      gateway: {
        downstreamBearer: 'runtime-only-downstream-secret',
        runtimeDir: resolve(input().materializedRootDir, 'cliproxyapi-runtime'),
        authEntries: [authEntry()],
        protocols: ['openai-responses'],
        modelListEnabled: false,
      },
      requestAuth: input().requestAuth,
    });
    expect(written?.contents.endsWith('\n')).toBe(true);
    expect(written?.contents).not.toContain('"capability":');
    expect(written?.contents).not.toContain('"host":');
    expect(written?.contents).not.toContain('"port":');
    expect(written?.contents).not.toContain('daemonStatePath');

    await preparation.cleanup();
    expect(remove).toHaveBeenCalledExactlyOnceWith(preparation.privateConfigPath);
  });

  it('accepts a materialization id at the exact 256-byte UTF-8 boundary', async () => {
    const materializationId = '😀'.repeat(64);
    const writeExclusive = vi.fn(async () => undefined);

    await expect(prepareCliProxyApiManagedRuntime(
      input({ materializationId }),
      {
        writeExclusive,
        remove: vi.fn(async () => undefined),
      },
    )).resolves.toMatchObject({ materializationId });
    expect(writeExclusive).toHaveBeenCalledOnce();
  });

  it('strictly verifies recovery config without returning its downstream bearer', async () => {
    const writeExclusive = vi.fn(async () => undefined);
    const preparation = await prepareCliProxyApiManagedRuntime(input(), {
      writeExclusive,
      remove: vi.fn(async () => undefined),
    });
    const written = writeExclusive.mock.calls[0]?.[0];
    const recoveryInput = {
      materializedRootDir: input().materializedRootDir,
      materializationId: input().materializationId,
      capabilityPath: input().requestAuth.capabilityPath,
      purposes: [purpose],
      protocols: ['openai-responses'] as const,
      modelListEnabled: false,
    };

    const facts = await inspectCliProxyApiManagedRuntimeRecovery(recoveryInput, {
      read: async () => written?.contents ?? '',
    });

    expect(facts).toEqual({
      privateConfigPath: preparation.privateConfigPath,
      capabilityPath: input().requestAuth.capabilityPath,
      expectedHealth: {
        v: 1,
        contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
        sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
        wrapperBuildVersion: '0.2.10',
        protocols: ['openai-responses'],
        purposes: [purpose],
        modelListEnabled: false,
        materializationId: 'managed-provider-session-a',
      },
    });
    expect(facts).not.toHaveProperty('downstreamBearer');

    const launchFromPreviousCli = JSON.parse(
      written?.contents ?? '{}',
    ) as Record<string, unknown>;
    launchFromPreviousCli.wrapperBuildVersion = '0.2.9';
    await expect(inspectCliProxyApiManagedRuntimeRecovery(recoveryInput, {
      read: async () => JSON.stringify(launchFromPreviousCli),
    })).resolves.toMatchObject({
      expectedHealth: {
        wrapperBuildVersion: '0.2.9',
      },
    });

    const malformed = JSON.parse(written?.contents ?? '{}') as Record<string, unknown>;
    malformed.unexpected = true;
    await expect(inspectCliProxyApiManagedRuntimeRecovery(recoveryInput, {
      read: async () => JSON.stringify(malformed),
    })).resolves.toBeNull();
    await expect(inspectCliProxyApiManagedRuntimeRecovery({
      ...recoveryInput,
      capabilityPath: resolve(input().materializedRootDir, 'other-capability.json'),
    }, {
      read: async () => written?.contents ?? '',
    })).resolves.toBeNull();
  });

  it('accepts only the exact token-free eight-field recovery health identity', () => {
    const expected = {
      v: 1 as const,
      contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
      sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
      wrapperBuildVersion: '0.2.10',
      protocols: ['openai-responses'] as const,
      purposes: [purpose],
      modelListEnabled: false,
      materializationId: 'managed-provider-session-a',
    };
    const exact = JSON.stringify(expected);

    expect(parseCliProxyApiManagedRecoveryHealth(exact, expected)).toEqual(expected);
    for (const invalid of [
      '{',
      JSON.stringify({ ...expected, unexpected: true }),
      JSON.stringify({
        contractVersion: expected.contractVersion,
        sdkVersion: expected.sdkVersion,
      }),
      JSON.stringify({ ...expected, wrapperBuildVersion: '0.2.9' }),
      JSON.stringify({ ...expected, sdkVersion: 'v7.2.94' }),
      JSON.stringify({ ...expected, protocols: ['openai-chat'] }),
      JSON.stringify({
        ...expected,
        purposes: [{ ...purpose, purpose: 'another-purpose' }],
      }),
      JSON.stringify({ ...expected, modelListEnabled: true }),
      JSON.stringify({ ...expected, materializationId: 'stale-materialization' }),
      JSON.stringify({ ...expected, downstreamBearer: 'must-not-parse' }),
    ]) {
      expect(parseCliProxyApiManagedRecoveryHealth(invalid, expected)).toBeNull();
    }
    expect(parseCliProxyApiManagedRecoveryHealth(exact, expected)).not.toHaveProperty(
      'downstreamBearer',
    );
  });

  it('rejects invalid paths, unsupported protocols, and competing selector entries before writing', async () => {
    const writeExclusive = vi.fn(async () => undefined);
    const privateFiles = {
      writeExclusive,
      remove: vi.fn(async () => undefined),
    };
    const cases = [
      input({ materializedRootDir: 'relative-root' }),
      input({ requestAuth: { ...input().requestAuth, capabilityPath: 'relative-capability' } }),
      input({ materializationId: '😀'.repeat(65) }),
      input({ protocols: ['ollama'] }),
      input({ protocols: ['openai-responses', 'openai-responses'] }),
      input({
        authEntries: [
          authEntry(),
          authEntry({ id: 'codex-backup', purpose: { ...purpose, purpose: 'openai-backup' } }),
        ],
      }),
      input({
        authEntries: [
          authEntry(),
          authEntry({
            id: 'codex',
            provider: 'claude',
            purpose: { ...purpose, purpose: 'anthropic-upstream' },
          }),
        ],
      }),
    ];

    for (const invalid of cases) {
      await expect(prepareCliProxyApiManagedRuntime(
        invalid as Parameters<typeof prepareCliProxyApiManagedRuntime>[0],
        privateFiles,
      )).rejects.toThrow();
    }
    expect(writeExclusive).not.toHaveBeenCalled();
  });

  it('scans past pinned SDK logs and accepts only one exact four-key readiness object', () => {
    const expected = {
      contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
      sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
      protocols: ['openai-responses'] as const,
      purposes: [purpose],
    };
    const readiness = JSON.stringify(expected);

    expect(scanCliProxyApiManagedReadiness(
      `API server started successfully on: 127.0.0.1:45123\n${readiness}\n`,
      expected,
    )).toEqual(expected);
    expect(scanCliProxyApiManagedReadiness(
      `${readiness}\n${readiness}\n`,
      expected,
    )).toBeNull();
    expect(scanCliProxyApiManagedReadiness(
      `${JSON.stringify({ ...expected, host: '127.0.0.1' })}\n`,
      expected,
    )).toBeNull();
    expect(scanCliProxyApiManagedReadiness(
      `${JSON.stringify({ ...expected, protocols: ['openai-chat'] })}\n`,
      expected,
    )).toBeNull();
    expect(scanCliProxyApiManagedReadiness(
      `${JSON.stringify({
        ...expected,
        purposes: [{ ...purpose, purpose: 'another-purpose' }],
      })}\n`,
      expected,
    )).toBeNull();
  });

  it('frames readiness from bounded stdout chunks without exposing SDK logs as readiness', async () => {
    const preparation = await prepareCliProxyApiManagedRuntime(input(), {
      writeExclusive: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    });
    const expected = {
      contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
      sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
      protocols: ['openai-responses'] as const,
      purposes: [purpose],
    };
    const waiting = preparation.prepared.readiness.wait();

    preparation.prepared.readiness.outputTee.onChunk(
      'stderr',
      Buffer.from(`${JSON.stringify(expected)}\n`),
    );
    preparation.prepared.readiness.outputTee.onChunk(
      'stdout',
      Buffer.from('API server started successfully on: 127.0.0.1:45123\n{"contract'),
    );
    preparation.prepared.readiness.outputTee.onChunk(
      'stdout',
      Buffer.from(`${JSON.stringify(expected).slice('{"contract'.length)}\n`),
    );

    await expect(waiting).resolves.toEqual(expected);
  });

  it('fails a readiness observer closed on malformed readiness-like output, overflow, or abort', async () => {
    const makePreparation = () => prepareCliProxyApiManagedRuntime(input(), {
      writeExclusive: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    });

    const malformed = await makePreparation();
    const malformedWaiting = malformed.prepared.readiness.wait();
    malformed.prepared.readiness.outputTee.onChunk(
      'stdout',
      Buffer.from(`${JSON.stringify({
        contractVersion: CLIPROXYAPI_MANAGED_CONTRACT_VERSION,
        sdkVersion: CLIPROXYAPI_MANAGED_SDK_VERSION,
        protocols: ['openai-responses'],
        purposes: [purpose],
        port: 45123,
      })}\n`),
    );
    await expect(malformedWaiting).rejects.toThrow(/readiness/i);

    const overflow = await makePreparation();
    const overflowWaiting = overflow.prepared.readiness.wait();
    overflow.prepared.readiness.outputTee.onChunk(
      'stdout',
      Buffer.alloc(513 * 1024, 0x61),
    );
    await expect(overflowWaiting).rejects.toThrow(/bounded/i);

    const aborted = await makePreparation();
    const controller = new AbortController();
    const abortedWaiting = aborted.prepared.readiness.wait(controller.signal);
    controller.abort();
    await expect(abortedWaiting).rejects.toThrow(/aborted/i);
  });
});
