import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';
import {
    readConnectedAccountRequestAuthCapabilityFile,
} from '@happier-dev/agents/request-auth';

import {
    createConnectedAccountRequestAuthSubjectRegistry,
} from './ConnectedAccountRequestAuthSubjectRegistry';
import {
    removeConnectedAccountRequestAuthCapabilityFileIfOwned,
} from './capabilityFile';
import {
    ConnectedAccountRequestAuthError,
    createConnectedAccountRequestAuthService,
    type ConnectedAccountRequestAuthResolvedBinding,
    ConnectedAccountRequestAuthSubject,
} from './ConnectedAccountRequestAuthService';
import {
    scopeConnectedAccountSessionPurposeBindingLease,
    type ConnectedAccountSessionPurposeBindingLease,
} from '../purposeBindings/ConnectedAccountPurposeBindingOwner';

const roots: string[] = [];
const consumer = {
    pluginId: 'happier.agent.test',
    localId: 'request-auth-consumer',
} as const;
const service = {
    pluginId: 'happier.connected-account.test',
    localId: 'subscription',
} as const;
const purpose = {
    consumer,
    purpose: 'model-request',
} as const;
const binding: QualifiedConnectedAccountPurposeBindingV1 = {
    purpose,
    target: {
        kind: 'group',
        service,
        groupId: 'fallbacks',
    },
};
const use = {
    purpose,
    materialization: {
        kind: 'httpHeaders' as const,
        origin: 'https://api.example.test',
        headerNames: ['authorization'],
    },
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function subject(
    isCurrent: () => boolean = () => true,
    registerRedaction: (values: readonly string[]) => void = () => undefined,
): ConnectedAccountRequestAuthSubject {
    return {
        subjectId: 'session:one/run:wrapper-one',
        isCurrent,
        registerRedaction,
        resolvePurposeUse: (requested) => (
            JSON.stringify(requested) === JSON.stringify(purpose)
                ? { binding, use }
                : null
        ),
        listPurposeUses: () => [{ binding, use }],
    };
}

describe('ConnectedAccountRequestAuthSubjectRegistry', () => {
    it('preserves host-issued catalog compatibility provenance only on the authenticated private principal', async () => {
        const agentRoot = await mkdtemp(
            join(tmpdir(), 'happier-request-auth-agent-'),
        );
        const managedRoot = await mkdtemp(
            join(tmpdir(), 'happier-request-auth-managed-'),
        );
        roots.push(agentRoot, managedRoot);
        const managedPurpose = {
            consumer: {
                pluginId: 'happier.provider.test',
                localId: 'managed-runtime',
            },
            purpose: 'upstream-request',
        } as const;
        const managedBinding: QualifiedConnectedAccountPurposeBindingV1 = {
            purpose: managedPurpose,
            target: {
                kind: 'account',
                account: { service, accountId: 'managed' },
            },
        };
        const managedUse = {
            purpose: managedPurpose,
            materialization: {
                kind: 'httpHeaders' as const,
                origin: 'https://managed.example.test',
                headerNames: ['authorization'],
            },
        };
        let current = true;
        const unionLease: ConnectedAccountSessionPurposeBindingLease = {
            subjectId: 'agent-session:canonical',
            isCurrent: () => current,
            resolvePurposeBinding: (requested) => (
                JSON.stringify(requested) === JSON.stringify(purpose)
                    ? binding
                    : JSON.stringify(requested) === JSON.stringify(managedPurpose)
                        ? managedBinding
                        : null
            ),
            listPurposeBindings: () => current ? [binding, managedBinding] : [],
            dispose: () => {
                current = false;
            },
        };
        const agentRedactions: string[][] = [];
        const managedRedactions: string[][] = [];
        const agentSubject = scopeConnectedAccountSessionPurposeBindingLease({
            lease: unionLease,
            subjectId: unionLease.subjectId,
            uses: [use],
            legacyServiceKeyedCompatibility: true,
            registerRedaction: (values) => agentRedactions.push([...values]),
        });
        const managedSubject = scopeConnectedAccountSessionPurposeBindingLease({
            lease: unionLease,
            subjectId: unionLease.subjectId,
            uses: [managedUse],
            registerRedaction: (values) => managedRedactions.push([...values]),
        });
        const registry = createConnectedAccountRequestAuthSubjectRegistry();
        const agentCapability = await registry.activate({
            subject: agentSubject,
            materializedRootDir: agentRoot,
            materializationId: 'agent',
            httpPort: 43_123,
        });
        const managedCapability = await registry.activate({
            subject: managedSubject,
            materializedRootDir: managedRoot,
            materializationId: 'managed',
            httpPort: 43_123,
        });
        const agentSecret = (
            await readConnectedAccountRequestAuthCapabilityFile(agentCapability.path)
        )?.capability;
        const managedSecret = (
            await readConnectedAccountRequestAuthCapabilityFile(managedCapability.path)
        )?.capability;
        const agentPrincipal = registry.authenticate(agentSecret);
        const managedPrincipal = registry.authenticate(managedSecret);
        const requestAuth = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: ({ binding: currentBinding }) => ({
                account: currentBinding.target.kind === 'account'
                    ? currentBinding.target.account
                    : { service: currentBinding.target.service, accountId: 'resolved' },
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                ...(currentBinding.target.kind === 'group'
                    ? {
                        group: {
                            groupId: currentBinding.target.groupId,
                            generation: 1,
                        },
                    }
                    : {}),
            } satisfies ConnectedAccountRequestAuthResolvedBinding),
            materializeBearer: async () => ({ accessToken: 'secret' }),
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_changed' }),
        });

        expect(agentPrincipal).not.toBeNull();
        expect(managedPrincipal).not.toBeNull();
        expect(agentCapability).not.toHaveProperty(
            'legacyServiceKeyedCompatibility',
        );
        expect(managedCapability).not.toHaveProperty(
            'legacyServiceKeyedCompatibility',
        );
        expect(agentPrincipal?.legacyServiceKeyedCompatibility).toBe(true);
        expect(managedPrincipal?.legacyServiceKeyedCompatibility).toBeUndefined();
        await expect(requestAuth.validateRequestAuth({
            subject: agentPrincipal!,
            purpose,
        })).resolves.toBeUndefined();
        await expect(requestAuth.validateRequestAuth({
            subject: managedPrincipal!,
            purpose: managedPurpose,
        })).resolves.toBeUndefined();
        agentPrincipal!.registerRedaction(['agent-secret']);
        managedPrincipal!.registerRedaction(['managed-secret']);
        expect(agentRedactions).toEqual([['agent-secret']]);
        expect(managedRedactions).toEqual([['managed-secret']]);
        for (const [principal, forbiddenPurpose] of [
            [agentPrincipal!, managedPurpose],
            [managedPrincipal!, purpose],
        ] as const) {
            try {
                await requestAuth.validateRequestAuth({
                    subject: principal,
                    purpose: forbiddenPurpose,
                });
                throw new Error('expected cross-purpose authorization to fail');
            } catch (error) {
                expect(error).toBeInstanceOf(ConnectedAccountRequestAuthError);
                expect(error).toMatchObject({
                    code: 'request_auth_purpose_forbidden',
                });
            }
        }

        unionLease.dispose();
        expect(registry.authenticate(agentSecret)).toBeNull();
        expect(registry.authenticate(managedSecret)).toBeNull();
        expect(agentPrincipal?.isCurrent()).toBe(false);
        expect(managedPrincipal?.isCurrent()).toBe(false);
        expect(() => agentPrincipal?.registerRedaction(['stale-agent-secret']))
            .toThrow('request_auth_not_active');
        expect(agentRedactions).toEqual([['agent-secret']]);
    });

    it('does not activate authority when the just-written capability cannot be verified', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-subject-'));
        roots.push(root);
        const stagedPath = join(root, 'request-auth', 'capability.json');
        const removeCapabilityFileIfOwned = vi.fn(async () => true);
        const registry = createConnectedAccountRequestAuthSubjectRegistry({
            writeCapabilityFile: async () => ({
                path: stagedPath,
                materializationId: 'wrapper-one',
                subjectScopeDigest: 'a'.repeat(64),
                capabilityDigest: 'b'.repeat(64),
            }),
            verifyCapabilityFile: async () => null,
            removeCapabilityFileIfOwned,
        });

        await expect(registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_123,
        })).rejects.toThrow('request_auth_capability_verification_failed');
        expect(registry.authenticate('unverified-capability')).toBeNull();
        expect(removeCapabilityFileIfOwned).toHaveBeenCalledOnce();
        expect(removeCapabilityFileIfOwned).toHaveBeenCalledWith({
            descriptor: expect.objectContaining({ path: stagedPath }),
            materializedRootDir: root,
        });
    });

    it('rolls back staged map and file authority exactly once when finalization fails after commit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-finalize-'));
        roots.push(root);
        const removeCapabilityFileIfOwned = vi.fn(
            removeConnectedAccountRequestAuthCapabilityFileIfOwned,
        );
        let registry!: ReturnType<
            typeof createConnectedAccountRequestAuthSubjectRegistry
        >;
        let secret = '';
        const authorityDuringFinalization: Array<string | null> = [];
        registry = createConnectedAccountRequestAuthSubjectRegistry({
            removeCapabilityFileIfOwned,
        });

        await expect(registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-finalize',
            httpPort: 43_123,
            finalizeStagedAuthorityCommit: async (
                _descriptor,
                commit,
            ) => {
                secret = (
                    await readConnectedAccountRequestAuthCapabilityFile(
                        join(root, 'request-auth', 'capability.json'),
                    )
                )?.capability ?? '';
                authorityDuringFinalization.push(
                    registry.authenticate(secret)?.subjectId ?? null,
                );
                commit();
                authorityDuringFinalization.push(
                    registry.authenticate(secret)?.subjectId ?? null,
                );
                throw new Error('final_authority_proof_failed');
            },
        })).rejects.toThrow('final_authority_proof_failed');

        expect(authorityDuringFinalization).toEqual([
            null,
            'session:one/run:wrapper-one',
        ]);
        expect(registry.authenticate(secret)).toBeNull();
        expect(removeCapabilityFileIfOwned).toHaveBeenCalledOnce();
        await expect(readConnectedAccountRequestAuthCapabilityFile(
            join(root, 'request-auth', 'capability.json'),
        )).resolves.toBeNull();
    });

    it('closes an abandoned staged commit so it cannot publish authority later', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-abandoned-'));
        roots.push(root);
        const removeCapabilityFileIfOwned = vi.fn(
            removeConnectedAccountRequestAuthCapabilityFileIfOwned,
        );
        const registry = createConnectedAccountRequestAuthSubjectRegistry({
            removeCapabilityFileIfOwned,
        });
        const staged: { commit?: () => void } = {};
        let secret = '';

        await expect(registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-abandoned',
            httpPort: 43_123,
            finalizeStagedAuthorityCommit: async (
                _descriptor,
                commit,
            ) => {
                staged.commit = commit;
                secret = (
                    await readConnectedAccountRequestAuthCapabilityFile(
                        join(root, 'request-auth', 'capability.json'),
                    )
                )?.capability ?? '';
            },
        })).rejects.toThrow('request_auth_authority_commit_missing');

        expect(registry.authenticate(secret)).toBeNull();
        expect(removeCapabilityFileIfOwned).toHaveBeenCalledOnce();
        expect(() => staged.commit?.()).toThrow(
            'request_auth_authority_commit_invalid',
        );
        expect(registry.authenticate(secret)).toBeNull();
    });

    it('fails before activation, then authenticates only the scoped capability for the current subject', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-subject-'));
        roots.push(root);
        let current = true;
        const registry = createConnectedAccountRequestAuthSubjectRegistry();
        expect(registry.authenticate('not-active')).toBeNull();

        const capability = await registry.activate({
            subject: subject(() => current),
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_123,
        });
        const document = await readConnectedAccountRequestAuthCapabilityFile(capability.path);

        expect(document).toMatchObject({
            materializationId: 'wrapper-one',
            subjectScopeDigest: capability.subjectScopeDigest,
        });
        expect(registry.authenticate(document?.capability)).toMatchObject({
            subjectId: 'session:one/run:wrapper-one',
        });
        expect(registry.authenticate('daemon-master-control-token')).toBeNull();
        current = false;
        expect(registry.authenticate(document?.capability)).toBeNull();
    });

    it('replaces authority atomically at one materialization and rejects the old capability', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-subject-'));
        roots.push(root);
        const registry = createConnectedAccountRequestAuthSubjectRegistry();
        const first = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_123,
        });
        const oldSecret = (await readConnectedAccountRequestAuthCapabilityFile(first.path))?.capability;
        const second = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_124,
        });
        const newSecret = (await readConnectedAccountRequestAuthCapabilityFile(second.path))?.capability;

        expect(newSecret).not.toBe(oldSecret);
        expect(registry.authenticate(oldSecret)).toBeNull();
        expect(registry.authenticate(newSecret)).not.toBeNull();
    });

    it('invalidates registry authority before removing the private file on retirement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-subject-'));
        roots.push(root);
        const observations: boolean[] = [];
        let registry!: ReturnType<typeof createConnectedAccountRequestAuthSubjectRegistry>;
        let secret = '';
        registry = createConnectedAccountRequestAuthSubjectRegistry({
            removeCapabilityFileIfOwned: async (input) => {
                observations.push(registry.authenticate(secret) === null);
                return await removeConnectedAccountRequestAuthCapabilityFileIfOwned(
                    input,
                );
            },
        });
        const capability = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_123,
        });
        secret = (await readConnectedAccountRequestAuthCapabilityFile(capability.path))?.capability ?? '';
        const capturedPrincipal = registry.authenticate(secret);

        await registry.retire(capability);

        expect(observations).toEqual([true]);
        expect(registry.authenticate(secret)).toBeNull();
        expect(capturedPrincipal?.isCurrent()).toBe(false);
        expect(capturedPrincipal?.resolvePurposeUse(purpose)).toBeNull();
        expect(capturedPrincipal?.listPurposeUses()).toEqual([]);
    });

    it('keeps failed retirement cleanup retryable without restoring authority', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-retry-'));
        roots.push(root);
        const removeCapabilityFileIfOwned = vi.fn(
            removeConnectedAccountRequestAuthCapabilityFileIfOwned,
        );
        removeCapabilityFileIfOwned.mockRejectedValueOnce(
            new Error('capability_cleanup_busy'),
        );
        const registry = createConnectedAccountRequestAuthSubjectRegistry({
            removeCapabilityFileIfOwned,
        });
        const capability = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-retry',
            httpPort: 43_123,
        });
        const secret = (
            await readConnectedAccountRequestAuthCapabilityFile(capability.path)
        )?.capability;
        const capturedPrincipal = registry.authenticate(secret);

        await expect(registry.retire(capability)).rejects.toThrow(
            'capability_cleanup_busy',
        );
        expect(registry.authenticate(secret)).toBeNull();
        expect(capturedPrincipal?.isCurrent()).toBe(false);
        await expect(readConnectedAccountRequestAuthCapabilityFile(
            capability.path,
        )).resolves.not.toBeNull();

        await expect(registry.retire(capability)).resolves.toBeUndefined();
        expect(removeCapabilityFileIfOwned).toHaveBeenCalledTimes(2);
        await expect(readConnectedAccountRequestAuthCapabilityFile(
            capability.path,
        )).resolves.toBeNull();

        await expect(registry.retire(capability)).resolves.toBeUndefined();
        expect(removeCapabilityFileIfOwned).toHaveBeenCalledTimes(2);
    });

    it('cannot remove replacement authority when retrying failed retirement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-retry-'));
        roots.push(root);
        const removeCapabilityFileIfOwned = vi.fn(
            removeConnectedAccountRequestAuthCapabilityFileIfOwned,
        );
        removeCapabilityFileIfOwned.mockRejectedValueOnce(
            new Error('capability_cleanup_busy'),
        );
        const registry = createConnectedAccountRequestAuthSubjectRegistry({
            removeCapabilityFileIfOwned,
        });
        const capabilityA = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-retry',
            httpPort: 43_123,
        });
        const secretA = (
            await readConnectedAccountRequestAuthCapabilityFile(capabilityA.path)
        )?.capability;

        await expect(registry.retire(capabilityA)).rejects.toThrow(
            'capability_cleanup_busy',
        );
        const capabilityB = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-retry',
            httpPort: 43_124,
        });
        const secretB = (
            await readConnectedAccountRequestAuthCapabilityFile(capabilityB.path)
        )?.capability;

        await expect(registry.retire(capabilityA)).resolves.toBeUndefined();
        expect(registry.authenticate(secretA)).toBeNull();
        expect(registry.authenticate(secretB)).not.toBeNull();
        await expect(readConnectedAccountRequestAuthCapabilityFile(
            capabilityB.path,
        )).resolves.toMatchObject({
            capability: secretB,
            httpPort: 43_124,
        });

        await registry.retire(capabilityB);
        expect(registry.authenticate(secretB)).toBeNull();
    });

    it('scope digest is derived from purpose intent and contains no resolved group member', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-subject-'));
        roots.push(root);
        const registry = createConnectedAccountRequestAuthSubjectRegistry();
        const capability = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_123,
        });
        const raw = JSON.stringify(await readConnectedAccountRequestAuthCapabilityFile(capability.path));

        expect(capability.subjectScopeDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(raw).not.toContain('profileId');
        expect(raw).not.toContain('activeProfileId');
        expect(raw).not.toContain('generation');
    });

    it('binds the exact request-auth descriptor into the subject and capability digests', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-subject-'));
        roots.push(root);
        const registry = createConnectedAccountRequestAuthSubjectRegistry();
        const first = await registry.activate({
            subject: subject(),
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_123,
        });
        const changedUse = {
            ...use,
            materialization: {
                ...use.materialization,
                origin: 'https://rotated.example.test',
            },
        };
        const second = await registry.activate({
            subject: {
                subjectId: 'session:one/run:wrapper-one',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => ({
                    binding,
                    use: changedUse,
                }),
                listPurposeUses: () => [{
                    binding,
                    use: changedUse,
                }],
            },
            materializedRootDir: root,
            materializationId: 'wrapper-one',
            httpPort: 43_123,
        });

        expect(second.subjectScopeDigest).not.toBe(first.subjectScopeDigest);
        expect(second.capabilityDigest).not.toBe(first.capabilityDigest);
    });
});
