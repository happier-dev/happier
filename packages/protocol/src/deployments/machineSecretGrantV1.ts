import { z } from '../zodRuntimePolicy.js';
import { AccessProviderRefV1Schema } from '../plugins/contributions/catalog.js';

import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { EnvironmentVariableBindingGrantReferenceV1Schema, EnvironmentVariableBindingV1Schema } from './storedAppInputV1.js';

const recipient = { v: z.literal(1), machineId: id, installationId: id };
const secretSubject = z.strictObject({ ...recipient, kind: z.literal('secret'), environmentId: id,
    resourceId: id, resourceRevision: revision });
const valuesSubject = z.strictObject({ ...recipient, kind: z.literal('environmentValues'), environmentId: id,
    binding: z.strictObject({ purpose: z.literal('variable'),
        phase: EnvironmentVariableBindingV1Schema.shape.phase, grantRef: EnvironmentVariableBindingGrantReferenceV1Schema }) });
const legacyValuesSubject = z.strictObject({ ...recipient, kind: z.literal('environmentValues'), environmentId: id,
    binding: z.strictObject({ purpose: z.literal('variable'), phase: EnvironmentVariableBindingV1Schema.shape.phase,
        name: EnvironmentVariableBindingV1Schema.shape.name }) });
const connectorSubject = z.strictObject({ ...recipient, kind: z.literal('connectorToken'),
    provider: AccessProviderRefV1Schema, connectorId: id });

/** The exact authenticated installation subject; Environment revisions are deliberately absent. */
export const MachineSecretGrantSubjectV1Schema = z.discriminatedUnion('kind', [secretSubject, valuesSubject, connectorSubject]);
/** Retained name-addressed subjects are readable only; mutation schemas remain opaque-reference-only. */
export const MachineSecretGrantSubjectStoredReadV1Schema = z.union([MachineSecretGrantSubjectV1Schema, legacyValuesSubject]);
export type MachineSecretGrantSubjectStoredReadV1 = z.infer<typeof MachineSecretGrantSubjectStoredReadV1Schema>;
export type MachineSecretGrantSubjectV1 = z.infer<typeof MachineSecretGrantSubjectV1Schema>;
export type MachineConnectorSecretGrantSubjectV1 = Extract<MachineSecretGrantSubjectV1, { kind: 'connectorToken' }>;
export const MachineConnectorSecretGrantSubjectV1Schema = connectorSubject;

const sealedContent = z.string().check(z.minLength(1));
/** One closed installation envelope for Saved Secrets, non-secret definitions and Machine connectors. */
export const MachineSecretGrantV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ ...secretSubject.shape, sealedContent }),
    z.strictObject({ ...valuesSubject.shape, sealedContent }),
    z.strictObject({ ...connectorSubject.shape, sealedContent }),
]);
export const MachineSecretGrantStoredReadV1Schema = z.union([MachineSecretGrantV1Schema,
    z.strictObject({ ...legacyValuesSubject.shape, sealedContent })]);
export type MachineSecretGrantV1 = z.infer<typeof MachineSecretGrantStoredReadV1Schema>;

/** Arm-specific identity, independent of ciphertext, authors and unrelated Environment edits. */
export function machineSecretGrantSubjectKey(subject: MachineSecretGrantSubjectStoredReadV1): string {
    const recipientKey = [subject.v, subject.kind, subject.machineId, subject.installationId];
    switch (subject.kind) {
        case 'secret': return JSON.stringify([...recipientKey, subject.environmentId, subject.resourceId, subject.resourceRevision]);
        case 'environmentValues': return JSON.stringify([...recipientKey, subject.environmentId,
            ...('name' in subject.binding
                ? [subject.binding.purpose, subject.binding.phase, subject.binding.name]
                : [subject.binding.purpose, subject.binding.phase, subject.binding.grantRef])]);
        case 'connectorToken': return 'kind' in subject.provider
            ? JSON.stringify([...recipientKey, { kind: subject.provider.kind, id: subject.provider.id }, subject.connectorId])
            : JSON.stringify([...recipientKey, subject.provider.pluginId, subject.provider.localId, subject.connectorId]);
    }
}

/** Inverse of the sole grant-reference encoding; noncanonical or unknown subjects fail closed. */
export function parseMachineSecretGrantSubjectKey(key: string): MachineSecretGrantSubjectStoredReadV1 | null {
    try {
        const parts: unknown = JSON.parse(key);
        if (!Array.isArray(parts)) return null;
        const [v, kind, machineId, installationId, ...subject] = parts;
        const common = { v, kind, machineId, installationId };
        const parsed = MachineSecretGrantSubjectStoredReadV1Schema.safeParse(kind === 'secret'
            ? { ...common, environmentId: subject[0], resourceId: subject[1], resourceRevision: subject[2] }
            : kind === 'environmentValues'
                ? { ...common, environmentId: subject[0], binding: { purpose: subject[1], phase: subject[2],
                    ...(EnvironmentVariableBindingGrantReferenceV1Schema.safeParse(subject[3]).success ? { grantRef: subject[3] } : { name: subject[3] }) } }
                : subject.length === 2
                    ? { ...common, provider: subject[0], connectorId: subject[1] }
                    : { ...common, provider: { pluginId: subject[0], localId: subject[1] }, connectorId: subject[2] });
        return parsed.success && machineSecretGrantSubjectKey(parsed.data) === key ? parsed.data : null;
    } catch { return null; }
}
