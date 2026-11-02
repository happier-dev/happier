/**
 * A Bot's face identity: one body, one colour and one seed that every style renders (the directive's "styles combine").
 * Absent choices derive deterministically from the seed (a Bot's Session id, or the Another-face seed it saved, as
 * `getSessionAvatarId` decides), so two Bots in one folder differ and a Bot looks the same on every device and style.
 * The choosable ids and the style list are the protocol's (`sessionBotFaceV1`); this module only maps them to art.
 */
import { BotFaceStyleSchema, type BotFaceStyle, type BotFaceShapeV1, type SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { BOT_FACE_BODIES, BOT_FACE_BODY_IDS, BOT_FACE_COLOUR_IDS, type BotFaceBodyId, type BotFaceColourId } from './botFaceArt';

export type { BotFaceStyle };
/** The shipped styles, in picker order (Dither first, the default). */
export const BOT_FACE_STYLES: readonly BotFaceStyle[] = BotFaceStyleSchema.options;

export type BotFaceIdentity = Readonly<{ body: BotFaceBodyId; colour: BotFaceColourId; seed: number; shape?: BotFaceShapeV1 }>;

/** Every style consumes this admitted art; body is only the compatibility fallback when an outline is present. */
export const resolveBotFaceArt = (identity: BotFaceIdentity) => identity.shape ?? BOT_FACE_BODIES[identity.body];

/**
 * The bodies a seed draws from: the original 34. Later bodies (the cat) are appended to the protocol list and chosen
 * only explicitly, so adding one never moves an existing Bot's seeded body or colour, on this client or an older one.
 */
const SEEDED_BODY_IDS = BOT_FACE_BODY_IDS.slice(0, 34);

/** FNV-1a: a stable 32-bit number for a seed string. */
export function botFaceSeedNumber(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** The identity a seed and a saved face describe; a saved body or colour wins over the seeded one. */
export function resolveBotFaceIdentity(seed: string, face?: Pick<SessionBotFaceV1, 'body' | 'palette' | 'shape'> | null): BotFaceIdentity {
    const n = botFaceSeedNumber(seed);
    return {
        body: face?.body ?? SEEDED_BODY_IDS[n % SEEDED_BODY_IDS.length],
        colour: face?.palette ?? BOT_FACE_COLOUR_IDS[Math.floor(n / SEEDED_BODY_IDS.length) % BOT_FACE_COLOUR_IDS.length],
        seed: n,
        ...(face?.shape ? { shape: face.shape } : {}),
    };
}
