import { z } from 'zod';

/**
 * Which artwork this device draws behind the Supporter pass (lab round 5b, the owner's seven picks).
 * A look, not a fact about the supporter: it lives on the device and is never sent to the server.
 * `glyph-number` is the approved launch art, the holder's number made of the glyph field's cells.
 */
export const SUPPORTER_PASS_STYLE_IDS = [
    'glyph-number',
    'glyph-sunrise',
    'smile-planet',
    'dawn-halftone',
    'holo-foil',
    'star-chart',
    'embossed-number',
] as const;

export type SupporterPassStyleId = (typeof SUPPORTER_PASS_STYLE_IDS)[number];

export const SupporterPassStyleIdSchema = z.enum(SUPPORTER_PASS_STYLE_IDS);

export const DEFAULT_SUPPORTER_PASS_STYLE_ID: SupporterPassStyleId = 'glyph-number';

/**
 * The pass's finish on this device: dark graphite or light paper, whatever the app theme. Dark is
 * the default (owner, 2026-11-27: the graphite card reads as the more premium object).
 */
export const SUPPORTER_PASS_FINISH_IDS = ['dark', 'light'] as const;

export type SupporterPassFinishId = (typeof SUPPORTER_PASS_FINISH_IDS)[number];

export const SupporterPassFinishIdSchema = z.enum(SUPPORTER_PASS_FINISH_IDS);

export const DEFAULT_SUPPORTER_PASS_FINISH_ID: SupporterPassFinishId = 'dark';
