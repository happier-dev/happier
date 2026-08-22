import { createHash } from 'node:crypto';

import {
    QualifiedConnectedAccountPurposeBindingsV1Schema,
    QualifiedConnectedAccountRequestAuthUseV1Schema,
    qualifiedPurposeKey,
} from '@happier-dev/protocol';
import {
    digestConnectedAccountRequestAuthCapability,
    removeConnectedAccountRequestAuthCapabilityFileIfOwned,
    verifyConnectedAccountRequestAuthCapabilityFile,
    writeConnectedAccountRequestAuthCapabilityFile,
    type ConnectedAccountRequestAuthCapabilityDescriptor,
} from './capabilityFile';

import type {
    ConnectedAccountRequestAuthSubject,
} from './ConnectedAccountRequestAuthService';
import {
    ConnectedAccountRequestAuthError,
} from './ConnectedAccountRequestAuthService';

type SubjectRecord = {
    subject: ConnectedAccountRequestAuthSubject;
    descriptor: ConnectedAccountRequestAuthCapabilityDescriptor;
    materializedRootDir: string;
    authorityCurrent: boolean;
    cleanupPromise: Promise<void> | null;
};

export type ConnectedAccountRequestAuthSubjectRegistry = Readonly<{
    activate: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        materializedRootDir: string;
        materializationId: string;
        httpPort: number;
        /**
         * A lifecycle owner may stage and verify the capability, then run its
         * final proof immediately before this registry's synchronous authority
         * commit. Callers without a final proof omit this callback.
         */
        finalizeStagedAuthorityCommit?: (
            descriptor: ConnectedAccountRequestAuthCapabilityDescriptor,
            commit: () => void,
        ) => Promise<void>;
    }>) => Promise<ConnectedAccountRequestAuthCapabilityDescriptor>;
    retire: (
        descriptor: ConnectedAccountRequestAuthCapabilityDescriptor,
        options?: Readonly<{ removeMaterializedRoot?: boolean }>,
    ) => Promise<void>;
    authenticate: (capability: unknown) => ConnectedAccountRequestAuthSubject | null;
}>;

export type ConnectedAccountRequestAuthSubjectRegistryDependencies = Readonly<{
    writeCapabilityFile?: typeof writeConnectedAccountRequestAuthCapabilityFile;
    verifyCapabilityFile?: typeof verifyConnectedAccountRequestAuthCapabilityFile;
    removeCapabilityFileIfOwned?:
        typeof removeConnectedAccountRequestAuthCapabilityFileIfOwned;
}>;

function materializationKey(input: Readonly<{
    materializedRootDir: string;
    materializationId: string;
}>): string {
    return JSON.stringify([input.materializedRootDir, input.materializationId]);
}

function scopeDigest(subject: ConnectedAccountRequestAuthSubject): string {
    const purposeUses = [...subject.listPurposeUses()]
        .sort((left, right) => qualifiedPurposeKey(left.binding.purpose)
            .localeCompare(qualifiedPurposeKey(right.binding.purpose)));
    const parsed = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
        v: 1,
        bindings: purposeUses.map((purposeUse) => purposeUse.binding),
    });
    const requestAuthUses = purposeUses.map((purposeUse) =>
        QualifiedConnectedAccountRequestAuthUseV1Schema.parse(purposeUse.use));
    for (let index = 0; index < purposeUses.length; index += 1) {
        if (
            qualifiedPurposeKey(parsed.bindings[index]!.purpose)
            !== qualifiedPurposeKey(requestAuthUses[index]!.purpose)
        ) {
            throw new Error('request_auth_subject_binding_use_mismatch');
        }
    }
    return createHash('sha256').update(JSON.stringify({
        subjectId: subject.subjectId,
        purposeBindings: parsed,
        requestAuthUses,
    }), 'utf8').digest('hex');
}

export function createConnectedAccountRequestAuthSubjectRegistry(
    dependencies: ConnectedAccountRequestAuthSubjectRegistryDependencies = {},
): ConnectedAccountRequestAuthSubjectRegistry {
    const writeCapabilityFile = dependencies.writeCapabilityFile
        ?? writeConnectedAccountRequestAuthCapabilityFile;
    const removeCapabilityFileIfOwned =
        dependencies.removeCapabilityFileIfOwned
        ?? removeConnectedAccountRequestAuthCapabilityFileIfOwned;
    const verifyCapabilityFile = dependencies.verifyCapabilityFile
        ?? verifyConnectedAccountRequestAuthCapabilityFile;
    const recordsByCapabilityDigest = new Map<string, SubjectRecord>();
    const capabilityDigestByMaterialization = new Map<string, string>();

    const retireDigest = (capabilityDigest: string): SubjectRecord | null => {
        const record = recordsByCapabilityDigest.get(capabilityDigest) ?? null;
        if (!record) return null;
        recordsByCapabilityDigest.delete(capabilityDigest);
        const key = materializationKey({
            materializedRootDir: record.materializedRootDir,
            materializationId: record.descriptor.materializationId,
        });
        if (capabilityDigestByMaterialization.get(key) === capabilityDigest) {
            capabilityDigestByMaterialization.delete(key);
        }
        return record;
    };

    const activate: ConnectedAccountRequestAuthSubjectRegistry['activate'] = async (input) => {
        if (!input.subject.isCurrent()) {
            throw new Error('request_auth_not_active');
        }
        const subjectScopeDigest = scopeDigest(input.subject);
        const writtenDescriptor = await writeCapabilityFile({
            rootDir: input.materializedRootDir,
            materializationId: input.materializationId,
            subjectScopeDigest,
            httpPort: input.httpPort,
        });
        const descriptor = await verifyCapabilityFile({
            ...writtenDescriptor,
            materializedRootDir: input.materializedRootDir,
        });
        if (!descriptor) {
            await removeCapabilityFileIfOwned({
                descriptor: writtenDescriptor,
                materializedRootDir: input.materializedRootDir,
            }).catch(() => undefined);
            throw new Error('request_auth_capability_verification_failed');
        }

        const commitAuthority = (): void => {
            if (!input.subject.isCurrent()) {
                throw new Error('request_auth_not_active');
            }
            const key = materializationKey(input);
            const previousDigest = capabilityDigestByMaterialization.get(key);
            recordsByCapabilityDigest.set(descriptor.capabilityDigest, {
                subject: input.subject,
                descriptor,
                materializedRootDir: input.materializedRootDir,
                authorityCurrent: true,
                cleanupPromise: null,
            });
            capabilityDigestByMaterialization.set(key, descriptor.capabilityDigest);
            if (previousDigest && previousDigest !== descriptor.capabilityDigest) {
                retireDigest(previousDigest);
            }
        };
        if (!input.finalizeStagedAuthorityCommit) {
            try {
                commitAuthority();
            } catch (error) {
                await removeCapabilityFileIfOwned({
                    descriptor,
                    materializedRootDir: input.materializedRootDir,
                }).catch(() => undefined);
                throw error;
            }
            return descriptor;
        }

        let commitOpen = true;
        let committed = false;
        const oneShotCommit = (): void => {
            if (!commitOpen || committed) {
                throw new Error('request_auth_authority_commit_invalid');
            }
            commitAuthority();
            committed = true;
        };
        try {
            await input.finalizeStagedAuthorityCommit(
                descriptor,
                oneShotCommit,
            );
            commitOpen = false;
            if (!committed) {
                throw new Error('request_auth_authority_commit_missing');
            }
            return descriptor;
        } catch (error) {
            commitOpen = false;
            const retired = committed
                ? retireDigest(descriptor.capabilityDigest)
                : null;
            if (!committed || retired) {
                await removeCapabilityFileIfOwned({
                    descriptor,
                    materializedRootDir: input.materializedRootDir,
                }).catch(() => undefined);
            }
            throw error;
        }
    };

    const retire: ConnectedAccountRequestAuthSubjectRegistry['retire'] = async (
        descriptor,
        options,
    ) => {
        const record = recordsByCapabilityDigest.get(descriptor.capabilityDigest);
        if (
            !record
            || record.descriptor.path !== descriptor.path
            || record.descriptor.materializationId !== descriptor.materializationId
            || record.descriptor.subjectScopeDigest !== descriptor.subjectScopeDigest
        ) {
            return;
        }
        if (record.authorityCurrent) {
            // Authority is removed synchronously before filesystem cleanup begins.
            record.authorityCurrent = false;
            const key = materializationKey({
                materializedRootDir: record.materializedRootDir,
                materializationId: record.descriptor.materializationId,
            });
            if (
                capabilityDigestByMaterialization.get(key)
                === descriptor.capabilityDigest
            ) {
                capabilityDigestByMaterialization.delete(key);
            }
        }
        if (record.cleanupPromise) {
            return await record.cleanupPromise;
        }
        const cleanup = removeCapabilityFileIfOwned({
            descriptor,
            materializedRootDir: record.materializedRootDir,
            ...(options?.removeMaterializedRoot === true
                ? { removeMaterializedRoot: true }
                : {}),
        }).then(() => {
            if (
                recordsByCapabilityDigest.get(descriptor.capabilityDigest)
                === record
            ) {
                recordsByCapabilityDigest.delete(descriptor.capabilityDigest);
            }
        });
        record.cleanupPromise = cleanup;
        try {
            await cleanup;
        } finally {
            if (record.cleanupPromise === cleanup) {
                record.cleanupPromise = null;
            }
        }
    };

    const authenticate: ConnectedAccountRequestAuthSubjectRegistry['authenticate'] = (capability) => {
        const capabilityDigest = digestConnectedAccountRequestAuthCapability(capability);
        if (!capabilityDigest) return null;
        const record = recordsByCapabilityDigest.get(capabilityDigest);
        if (
            !record
            || !record.authorityCurrent
            || !record.subject.isCurrent()
        ) return null;
        // Return a registry-scoped principal, not the raw subject. A route may carry this
        // principal across an async materialization or recovery boundary; retirement or
        // replacement must invalidate that captured authority as well as future lookups.
        const isPrincipalCurrent = () => (
            recordsByCapabilityDigest.get(capabilityDigest) === record
            && record.authorityCurrent
            && record.subject.isCurrent()
        );
        return Object.freeze({
            subjectId: record.subject.subjectId,
            ...(record.subject.legacyServiceKeyedCompatibility === true
                ? { legacyServiceKeyedCompatibility: true as const }
                : {}),
            isCurrent: isPrincipalCurrent,
            registerRedaction: (values) => {
                if (!isPrincipalCurrent()) {
                    throw new ConnectedAccountRequestAuthError('request_auth_not_active');
                }
                record.subject.registerRedaction(values);
            },
            resolvePurposeUse: (purpose) => (
                isPrincipalCurrent() ? record.subject.resolvePurposeUse(purpose) : null
            ),
            listPurposeUses: () => (
                isPrincipalCurrent() ? record.subject.listPurposeUses() : []
            ),
        });
    };

    return {
        activate,
        retire,
        authenticate,
    };
}
