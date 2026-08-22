import { defineProtocolString } from '../../plugins/actions/protocolComposableSchema.js';

/** One opaque composer instance identity carries no surrounding whitespace. */
const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;
export const MAX_COMPOSER_INSTANCE_ID_CODE_POINTS_V1 = 256;

/**
 * The canonical grammar for one opaque composer instance identity, authored as
 * a validator-neutral composable so schemas that must publish a portable JSON
 * Schema can embed it. `ComposerInstanceIdSchema` in `composerAttachmentV1.ts`
 * is the incumbent Zod spelling of this same grammar, not a second one.
 *
 * It lives in its own leaf because the composer-scope grammar in
 * `plugins/ui/composerRef.ts` embeds it and is published to the browser-safe
 * public authoring surface; reaching it through `composerAttachmentV1.ts` would
 * drag that module's attachment, media, mention and contribution-identity graph
 * into every feature-protocol browser bundle.
 */
export const ComposerInstanceIdProtocolSchema = defineProtocolString({
  minLength: 1,
  maxLength: MAX_COMPOSER_INSTANCE_ID_CODE_POINTS_V1,
  pattern: NO_OUTER_WHITESPACE_PATTERN.source,
});
