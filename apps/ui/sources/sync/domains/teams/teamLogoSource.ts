import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
    TEAM_LOGO_ACCEPTED_MIME_TYPES_V1,
    TEAM_LOGO_MAX_SOURCE_BYTES_V1,
    TeamLogoMimeTypeV1Schema,
    type TeamLogoMimeTypeV1,
    type TeamLogoSourceV1,
} from '@happier-dev/protocol/teams';

/**
 * Turns a picked image into the Team-logo admission payload.
 *
 * The accepted formats and the byte budget are the media boundary's, imported
 * from it rather than restated: a client that invented its own limits would let
 * an upload through that the processor then refuses, or refuse one it accepts.
 *
 * Rejection happens before encoding, so an oversized selection never allocates
 * a base64 string a third larger than a file the Home would not have taken.
 */

export type TeamLogoSourceResult =
    | Readonly<{ status: 'ok'; source: TeamLogoSourceV1 }>
    | Readonly<{ status: 'invalid'; reason: 'unsupported_format' | 'too_large' }>;

/**
 * A picker reports a media type with the casing and parameters the platform
 * happens to use. Only the type itself is meaningful here.
 */
function normalizeMimeType(raw: string | null | undefined): TeamLogoMimeTypeV1 | null {
    if (typeof raw !== 'string') return null;
    const candidate = raw.split(';')[0]?.trim().toLowerCase() ?? '';
    const parsed = TeamLogoMimeTypeV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

export function createTeamLogoSource(params: Readonly<{
    bytes: Uint8Array;
    mimeType: string | null | undefined;
}>): TeamLogoSourceResult {
    const mimeType = normalizeMimeType(params.mimeType);
    // An unreported type is not assumed: guessing would submit bytes the
    // processor may not be able to decode at all.
    if (!mimeType) return { status: 'invalid', reason: 'unsupported_format' };
    // A zero-byte selection is not an image; the boundary rejects it too, and
    // reporting it as a format problem keeps one message for "that is not a
    // usable picture" rather than inventing a third outcome.
    if (params.bytes.length === 0) return { status: 'invalid', reason: 'unsupported_format' };
    if (params.bytes.length > TEAM_LOGO_MAX_SOURCE_BYTES_V1) return { status: 'invalid', reason: 'too_large' };

    return {
        status: 'ok',
        source: { mimeType, dataBase64: encodeBase64(params.bytes, 'base64') },
    };
}

/**
 * The formats this boundary accepts, in its own order.
 *
 * The platform image pickers cannot be narrowed to a media-type list, so this
 * is what a rejection tells the person to pick instead; restating the formats
 * in copy would be a second answer to a question this boundary already owns.
 */
export const TEAM_LOGO_ACCEPTED_MIME_TYPES = TEAM_LOGO_ACCEPTED_MIME_TYPES_V1;
