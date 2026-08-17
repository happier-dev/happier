import type { UnsupportedContentKind } from './unsupportedContentMeta';

/**
 * How a transcript placeholder for content we could not render is presented.
 *
 * - `diagnostic`: show the raw normalized fallback text. It carries the offending payload type
 *   (`[Unsupported agent output: <type>]`), which is the detail that made a new unrenderable
 *   Claude record type go unnoticed for a month when it was discarded.
 * - `label`: show the localized short label instead of the raw fallback text.
 * - `hidden`: do not render a transcript row at all.
 */
export type UnsupportedContentPresentation = 'diagnostic' | 'label' | 'hidden';

/**
 * Single owner for placeholder visibility. Placeholders are diagnostics, not conversation
 * content: with developer diagnostics enabled (dev build or the `devModeEnabled` local setting)
 * they stay raw and greppable, and otherwise agent-side placeholders are dropped instead of
 * telling every user that something they cannot act on failed to render. A persisted structured
 * transcript record is the exception: it must stay mounted so its existing unavailable shell can
 * explain that the durable snapshot cannot be rendered without exposing its raw fallback text.
 *
 * A user's own message is never dropped this way. An agent placeholder marks a row that carried
 * no renderable content, but a missing user row is a gap the user knows should be there, so it
 * keeps a labeled placeholder even when diagnostics are off. The same is true of a corrupt or
 * future structured transcript record, whose renderer owns the localized unavailable state.
 */
export function resolveUnsupportedContentPresentation(params: Readonly<{
    kind: UnsupportedContentKind;
    debugInformationEnabled: boolean;
}>): UnsupportedContentPresentation {
    if (params.debugInformationEnabled) return 'diagnostic';
    return params.kind === 'unparsed-user-message' || params.kind === 'unsupported-transcript-record'
        ? 'label'
        : 'hidden';
}
