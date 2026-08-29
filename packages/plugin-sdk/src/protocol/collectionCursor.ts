import {
    PluginCollectionOpaqueCursorV1Schema as canonicalPluginCollectionOpaqueCursorV1Schema,
} from '@happier-dev/protocol/plugins/data/collectionOpaqueCursorV1';

import type { ProtocolComposableSchema } from './protocolFacade.js';

/**
 * The Account Data Collection's opaque continuation cursor, as a feature
 * protocol embeds it in its own Action wire shapes.
 *
 * Callers may retain and return the cursor to the Collection owner, but may
 * not decode or persist it. The 4096-character base64url grammar is the
 * canonical Protocol parser's own bound; the SDK adds no second parser,
 * limit, or JSON-Schema owner.
 */
export type ProtocolCollectionOpaqueCursorV1 = string;

/** The canonical Protocol parser remains the sole schema owner. */
export const ProtocolCollectionOpaqueCursorV1Schema: ProtocolComposableSchema<ProtocolCollectionOpaqueCursorV1> =
    canonicalPluginCollectionOpaqueCursorV1Schema;
