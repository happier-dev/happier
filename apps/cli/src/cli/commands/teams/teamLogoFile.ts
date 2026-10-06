import { readFile } from 'node:fs/promises';

import { TEAM_LOGO_ACCEPTED_MIME_TYPES_V1, TEAM_LOGO_MAX_SOURCE_BYTES_V1 } from '@happier-dev/protocol/teams/logo';
import type { TeamLogoMimeTypeV1, TeamLogoSourceV1 } from '@happier-dev/protocol';

import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';

/**
 * The CLI's local-file adapter for a Team logo.
 *
 * `teams.logo.set` takes inline bytes, which the app's picker produces from the
 * platform image picker. A terminal has a path instead, so without this adapter
 * the only way to set a logo from the CLI is to base64-encode the file by hand
 * and paste megabytes onto the command line. It produces the same
 * `TeamLogoSourceV1` the picker does and decides nothing else: the published
 * geometry, re-encoding and blob custody stay with the server's media owner.
 *
 * The type is read from the file's own leading bytes rather than its extension
 * or a caller-supplied flag. A renamed `.png` that is really a PDF must be
 * refused here, where the mistake is cheap to explain, rather than becoming a
 * `mimeType` the Home believes and the decoder then rejects.
 */

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Object.freeze([0xff, 0xd8, 0xff]);

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
    return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

export function readTeamLogoMimeTypeFromBytes(bytes: Uint8Array): TeamLogoMimeTypeV1 | null {
    if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
    if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
    return null;
}

export type TeamLogoFileDeps = Readonly<{
    readFileFn: (path: string) => Promise<Uint8Array>;
}>;

const DEFAULT_DEPS: TeamLogoFileDeps = { readFileFn: async (path) => await readFile(path) };

function invalidArgument(message: string): never {
    throw Object.assign(new Error(message), { code: 'invalid_arguments' });
}

/** Reads one local image file as the canonical Team-logo input. */
export async function readTeamLogoSourceFromFile(
    path: string,
    deps: Partial<TeamLogoFileDeps> = {},
): Promise<TeamLogoSourceV1> {
    const resolved = resolveAbsolutePathFromWorkingDirectory(path);
    if (resolved === null) invalidArgument('Provide a path to a PNG or JPEG image file.');
    const readFileFn = deps.readFileFn ?? DEFAULT_DEPS.readFileFn;
    let bytes: Uint8Array;
    try {
        bytes = await readFileFn(resolved);
    } catch (cause) {
        invalidArgument(`Could not read ${resolved}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (bytes.byteLength === 0) invalidArgument(`${resolved} is empty.`);
    if (bytes.byteLength > TEAM_LOGO_MAX_SOURCE_BYTES_V1) {
        invalidArgument(
            `${resolved} is ${bytes.byteLength} bytes; a Team logo may be at most ${TEAM_LOGO_MAX_SOURCE_BYTES_V1} bytes.`,
        );
    }
    const mimeType = readTeamLogoMimeTypeFromBytes(bytes);
    if (!mimeType) {
        invalidArgument(
            `${resolved} is not one of the accepted image types (${TEAM_LOGO_ACCEPTED_MIME_TYPES_V1.join(', ')}).`,
        );
    }
    return {
        mimeType,
        dataBase64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    };
}
