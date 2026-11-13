import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import {
    DeploymentArtifactContentReferenceV1Schema,
    type DeploymentArtifactContentReferenceV1,
} from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';

/** Fake Home HTTP handlers receive the body the real client sent; read it at that transport boundary. */
export function readHomeRequestBody(data: unknown): Readonly<Record<string, unknown>> {
    return readRecord(data);
}

/** The Artifact content reference a Home mutation body carries, optionally under one key. */
export function readHomeRequestArtifactReference(data: unknown, key?: string): DeploymentArtifactContentReferenceV1 {
    const body = readHomeRequestBody(data);
    const source = key === undefined ? body : readRecord(body[key]);
    return DeploymentArtifactContentReferenceV1Schema.parse({ contentArtifactId: source.contentArtifactId,
        contentHeaderVersion: source.contentHeaderVersion, contentBodyVersion: source.contentBodyVersion });
}
