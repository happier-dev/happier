import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from './managedProviderOperationAuthority';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('managed Provider operation authority', () => {
  it('rotates one child-stable capability path across independent daemon authorities and fences retired cleanup', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-managed-provider-authority-'));
    roots.push(baseDir);
    const purpose = {
      consumer: { pluginId: 'acme.provider', localId: 'managed' },
      purpose: 'upstream',
    } as const;
    const binding = {
      purpose,
      target: {
        kind: 'account' as const,
        account: {
          service: { pluginId: 'acme.accounts', localId: 'openai' },
          accountId: 'account-1',
        },
      },
    };
    const createPurposeBindingOwner = () => ({
      activatePurposeBindings: () => Object.freeze({
        subjectId:
          'managed-provider-operation:session-provider-claim/provider:acme.provider/managed',
        isCurrent: () => true,
        resolvePurposeBinding: () => binding,
        listPurposeBindings: () => [binding],
        dispose() {},
      }),
    });
    const registryA = createConnectedAccountRequestAuthSubjectRegistry();
    const registryB = createConnectedAccountRequestAuthSubjectRegistry();
    const createAuthority = (
      requestAuthRegistry: typeof registryA,
      httpPort: number,
    ) => createManagedProviderOperationAuthority({
      materializationBaseDir: baseDir,
      purposeBindingOwner: createPurposeBindingOwner(),
      requestAuthRegistry,
      resolveRequestAuthHttpPort: () => httpPort,
      createRedactionLease: () => Object.freeze({ add() {}, close() {} }),
    });
    const activationInput = {
      identity: purpose.consumer,
      operationId: 'session-provider-claim',
      purposes: [purpose],
      purposeBindings: { v: 1 as const, bindings: [binding] },
      requestAuthUses: [{
        purpose,
        materialization: {
          kind: 'httpHeaders' as const,
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
      isCurrent: () => true,
    };

    const activationA = await createAuthority(registryA, 43_123)
      .activate(activationInput);
    const path = activationA.requestAuth!.capabilityPath;
    const documentA = JSON.parse(await readFile(path, 'utf8')) as {
      capability: string;
      httpPort: number;
      materializationId: string;
    };
    const activationB = await createAuthority(registryB, 43_124)
      .activate(activationInput);
    const documentB = JSON.parse(await readFile(path, 'utf8')) as {
      capability: string;
      httpPort: number;
      materializationId: string;
    };

    expect(activationB.requestAuth?.capabilityPath).toBe(path);
    expect(path).not.toContain('session-provider-claim');
    expect(documentB).toMatchObject({ httpPort: 43_124 });
    expect(documentB.materializationId).toBe(documentA.materializationId);
    expect(documentB.capability).not.toBe(documentA.capability);
    expect(registryB.authenticate(documentA.capability)).toBeNull();
    expect(registryB.authenticate(documentB.capability)).not.toBeNull();

    await activationA.cleanup();

    await expect(access(path)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      capability: documentB.capability,
      httpPort: 43_124,
    });

    await activationB.cleanup();

    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('activates one exact purpose lease and invocation-bound request-auth capability, then retires both', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-managed-provider-authority-'));
    roots.push(baseDir);
    const purpose = {
      consumer: { pluginId: 'acme.provider', localId: 'managed' },
      purpose: 'upstream',
    } as const;
    const binding = {
      purpose,
      target: {
        kind: 'account' as const,
        account: {
          service: { pluginId: 'acme.accounts', localId: 'openai' },
          accountId: 'account-1',
        },
      },
    };
    let leaseCurrent = true;
    const disposeLease = vi.fn(() => {
      leaseCurrent = false;
    });
    const activatePurposeBindings = vi.fn(() => Object.freeze({
      subjectId:
        'managed-provider-operation:operation-1/provider:acme.provider/managed',
      isCurrent: () => leaseCurrent,
      resolvePurposeBinding: (candidate: typeof purpose) => (
        JSON.stringify(candidate) === JSON.stringify(purpose) ? binding : null
      ),
      listPurposeBindings: () => leaseCurrent ? [binding] : [],
      dispose: disposeLease,
    }));
    const requestAuthRegistry = createConnectedAccountRequestAuthSubjectRegistry();
    const retireRequestAuth = vi.spyOn(requestAuthRegistry, 'retire');
    const closeRedaction = vi.fn();
    const authority = createManagedProviderOperationAuthority({
      materializationBaseDir: baseDir,
      purposeBindingOwner: { activatePurposeBindings },
      requestAuthRegistry,
      resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => Object.freeze({
        add: vi.fn(),
        close: closeRedaction,
      }),
    });

    const activation = await authority.activate({
      identity: { pluginId: 'acme.provider', localId: 'managed' },
      operationId: 'operation-1',
      purposes: [purpose],
      purposeBindings: { v: 1, bindings: [binding] },
      requestAuthUses: [{
        purpose,
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
      isCurrent: () => true,
    });

    expect(activatePurposeBindings).toHaveBeenCalledWith({
      subject: expect.objectContaining({
        kind: 'managed_provider_operation',
        operationId: 'operation-1',
        pluginId: 'acme.provider',
        providerLocalId: 'managed',
      }),
      purposes: [purpose],
      bindings: [binding],
    });
    expect(activation.exactPurposeBindingSubjectId).toBe(
      'managed-provider-operation:operation-1/provider:acme.provider/managed',
    );
    expect(activation.requestAuth).toMatchObject({
      realm: 'managedProviderStart',
      requestAuthUses: [expect.objectContaining({ purpose: 'upstream' })],
    });
    expect(activation.requestAuth?.isCurrent()).toBe(true);
    await expect(access(activation.requestAuth!.capabilityPath)).resolves.toBeUndefined();

    await activation.cleanup();

    expect(activation.requestAuth?.isCurrent()).toBe(false);
    expect(retireRequestAuth).toHaveBeenCalledOnce();
    expect(disposeLease).toHaveBeenCalledOnce();
    expect(closeRedaction).toHaveBeenCalledOnce();
    await expect(access(activation.requestAuth!.capabilityPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retries only incomplete cleanup after capability retirement fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-managed-provider-authority-'));
    roots.push(baseDir);
    const purpose = {
      consumer: { pluginId: 'acme.provider', localId: 'managed' },
      purpose: 'upstream',
    } as const;
    const binding = {
      purpose,
      target: {
        kind: 'account' as const,
        account: {
          service: { pluginId: 'acme.accounts', localId: 'openai' },
          accountId: 'account-1',
        },
      },
    };
    const disposeLease = vi.fn();
    const closeRedaction = vi.fn();
    const registry = createConnectedAccountRequestAuthSubjectRegistry();
    const retire = vi.fn<typeof registry.retire>()
      .mockRejectedValueOnce(new Error('capability_cleanup_busy'))
      .mockImplementation(registry.retire);
    const authority = createManagedProviderOperationAuthority({
      materializationBaseDir: baseDir,
      purposeBindingOwner: {
        activatePurposeBindings: () => Object.freeze({
          subjectId: 'managed-provider-operation:retry-cleanup',
          isCurrent: () => true,
          resolvePurposeBinding: () => binding,
          listPurposeBindings: () => [binding],
          dispose: disposeLease,
        }),
      },
      requestAuthRegistry: {
        activate: registry.activate,
        retire,
      },
      resolveRequestAuthHttpPort: () => 43_123,
      createRedactionLease: () => Object.freeze({
        add() {},
        close: closeRedaction,
      }),
    });
    const activation = await authority.activate({
      identity: purpose.consumer,
      operationId: 'retry-cleanup',
      purposes: [purpose],
      purposeBindings: { v: 1, bindings: [binding] },
      requestAuthUses: [{
        purpose,
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
      isCurrent: () => true,
    });

    await expect(activation.cleanup()).rejects.toThrow(
      'capability_cleanup_busy',
    );
    expect(activation.requestAuth?.isCurrent()).toBe(false);
    expect(disposeLease).toHaveBeenCalledOnce();
    expect(closeRedaction).toHaveBeenCalledOnce();

    await expect(activation.cleanup()).resolves.toBeUndefined();
    expect(retire).toHaveBeenCalledTimes(2);
    expect(disposeLease).toHaveBeenCalledOnce();
    expect(closeRedaction).toHaveBeenCalledOnce();
    await expect(access(activation.requestAuth!.capabilityPath))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('issues an optional unbound request-auth capability whose broker subject stays unbound', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-managed-provider-authority-'));
    roots.push(baseDir);
    const purpose = {
      consumer: { pluginId: 'happier.provider.cliproxyapi', localId: 'managed' },
      purpose: 'upstream',
    } as const;
    const exactLease = Object.freeze({
      subjectId: 'optional-unbound-provider',
      isCurrent: () => true,
      resolvePurposeBinding: () => null,
      listPurposeBindings: () => Object.freeze([]),
      dispose() {},
    });
    const authority = createManagedProviderOperationAuthority({
      materializationBaseDir: baseDir,
      purposeBindingOwner: {
        activatePurposeBindings: vi.fn(() => exactLease),
      },
      requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
      resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => Object.freeze({ add() {}, close() {} }),
    });

    const activation = await authority.activate({
      identity: purpose.consumer,
      operationId: 'explicit-start-optional-unbound',
      purposes: [purpose],
      purposeBindings: { v: 1, bindings: [] },
      requestAuthUses: [{
        purpose,
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
      isCurrent: () => true,
    });

    expect(exactLease.resolvePurposeBinding()).toBeNull();
    expect(exactLease.listPurposeBindings()).toEqual([]);
    expect(activation.requestAuth).not.toBeNull();
    await activation.cleanup();
  });
});
