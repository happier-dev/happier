import { isDeepStrictEqual } from "node:util";

import type {
    QualifiedConnectedServiceCredentialStoredMetadataV4,
} from "../credentialHealthMetadata";

export type QualifiedConnectedAccountPreparedCreate = Readonly<{
    authenticationModeId: string;
    credentialRevision: string;
    credentialBytes: Uint8Array<ArrayBuffer>;
    metadata: QualifiedConnectedServiceCredentialStoredMetadataV4;
    configurationRevision: string | null;
    configurationBytes: Uint8Array<ArrayBuffer> | null;
}>;

function hasEqualBytes(
    left: Uint8Array<ArrayBufferLike> | null,
    right: Uint8Array<ArrayBufferLike> | null,
): boolean {
    if (left === null || right === null) return left === right;
    return left.byteLength === right.byteLength
        && left.every((value, index) => value === right[index]);
}

export function assertQualifiedConnectedAccountPreparedCreateWinner(
    params: Readonly<{
        prepared: QualifiedConnectedAccountPreparedCreate;
        winner: Readonly<{
            authenticationModeId: string | null;
            token: Uint8Array<ArrayBufferLike>;
            metadata: unknown;
            configurationRevision: string | null;
            configurationContent: Uint8Array<ArrayBufferLike> | null;
        }>;
    }>,
): void {
    const matches =
        doesQualifiedConnectedAccountPreparedCreateWinnerMatch(params);
    if (!matches) {
        throw new Error(
            "Qualified Connected Account prepared create winner mismatch",
        );
    }
}

export function doesQualifiedConnectedAccountPreparedCreateWinnerMatch(
    params: Readonly<{
        prepared: QualifiedConnectedAccountPreparedCreate;
        winner: Readonly<{
            authenticationModeId: string | null;
            token: Uint8Array<ArrayBufferLike>;
            metadata: unknown;
            configurationRevision: string | null;
            configurationContent: Uint8Array<ArrayBufferLike> | null;
        }>;
    }>,
): boolean {
    return params.winner.authenticationModeId
            === params.prepared.authenticationModeId
        && hasEqualBytes(
            params.winner.token,
            params.prepared.credentialBytes,
        )
        && isDeepStrictEqual(
            params.winner.metadata,
            params.prepared.metadata,
        )
        && params.winner.configurationRevision
            === params.prepared.configurationRevision
        && hasEqualBytes(
            params.winner.configurationContent,
            params.prepared.configurationBytes,
        );
}
