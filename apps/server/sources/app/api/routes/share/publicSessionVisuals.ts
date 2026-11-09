import { readPublishedSessionVisualMessages, type PublishedSessionVisualProjection } from '@happier-dev/session-core/transcript';
import type { PublicSessionOpenedMessage } from './publicShareViewerClient';

/** The same transcript normalizer/reducer and exact acknowledgement parser as authenticated replay. */
export type PublicSessionVisualProjection = PublishedSessionVisualProjection;
export function readPublicSessionVisualMessages(messages: readonly PublicSessionOpenedMessage[]): ReadonlyMap<string, readonly PublicSessionVisualProjection[]> {
    return readPublishedSessionVisualMessages(messages.map(message => ({ ...message, visualReadable: Boolean(message.loadVisual) })));
}
