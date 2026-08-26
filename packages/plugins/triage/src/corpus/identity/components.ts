import type {
    TriageEntryRefV1,
    TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';

/**
 * The identity components of every durable tag, in the exact order the identity
 * derivation consumes them.
 *
 * These builders exist so that one ordered tuple has one owner. Every component
 * is passed as its own element: the derivation frames elements structurally, so
 * a delimiter, a zero byte or a 512-byte component inside a contract-valid
 * identity cannot merge two entries into one row. Nothing here joins, sorts,
 * stringifies or normalizes a component — `collisionScope` and `entryId` are
 * consumed exactly as the source returned them.
 */

/**
 * The host-stamped source rendering used inside identity component tuples.
 *
 * This rendering is injective because a plugin id may not contain `/`, so the
 * first `/` is unambiguously the boundary. It is not a general-purpose path:
 * appending a third `/`-bearing component to it would not be injective.
 *
 * A contributed source's `localId` is therefore a durable address, not a label.
 * Renaming one retires every row keyed under the old rendering — configured
 * source instances, pins, session links — with no error at the rename site. It
 * is safe today only because no Account Collection row exists yet for any
 * source; the day one does, a rename needs a row migration, not an edit.
 */
export function renderSourceQualifiedId(source: PluginContributionIdentity): string {
    return `${source.pluginId}/${source.localId}`;
}

/**
 * Whether two values name the same contributed source.
 *
 * It lives beside `renderSourceQualifiedId` because it answers the same question that
 * rendering does — *is this the same source?* — and the two must never disagree: the
 * rendering keys durable rows while this predicate decides whether an entry may be
 * dispatched, opened, or checked out through a given configured instance. That gate is
 * security-adjacent (`composer/attachmentValue.ts` names the connected account the
 * dispatch resolver reauthorizes), and it was previously re-spelled inline at every
 * gate and every filter predicate that needed it.
 *
 * The comparison is component-wise rather than over the rendered string. Rendering is
 * injective, so both answers agree today; comparing components keeps that true without
 * depending on the rendering staying injective, and costs nothing.
 */
export function sameTriageSourceIdentity(
    left: PluginContributionIdentity,
    right: PluginContributionIdentity,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Whether two source-published references identify the same Triage entry.
 * This is intentionally component-wise: callers use it at admission and
 * dispatch boundaries where reconstructing a joined identity would create a
 * second parser for the durable entry tuple.
 */
export function sameTriageEntryReference(
    left: TriageEntryRefV1,
    right: TriageEntryRefV1,
): boolean {
    return sameTriageSourceIdentity(left.source, right.source)
        && left.kindId === right.kindId
        && left.collisionScope === right.collisionScope
        && left.entryId === right.entryId;
}

/**
 * The canonical entry reference, as ordered identity components.
 *
 * It addresses no row of its own: nothing provider-derived is stored. It is the
 * shared tuple every durable reference to an entry keys on — a pin's row id, and
 * a Session link's row id and index prefix — so that one entry has one identity
 * on every device and through every connection. The configured connection is
 * deliberately absent: an entry observed through two connections is one entry,
 * so pinning it twice from two machines is unrepresentable rather than merely
 * unlikely.
 */
export function entryReferenceComponents(entryRef: TriageEntryRefV1): readonly string[] {
    return [
        renderSourceQualifiedId(entryRef.source),
        entryRef.kindId,
        entryRef.collisionScope,
        entryRef.entryId,
    ];
}

/**
 * `source-instances.instanceTag` — the deterministic row address of one exact
 * configured tuple.
 *
 * Every semantic leaf of the account binding has its own named position, so
 * object property order, a serializer change, and a delimiter inside an account
 * id are all irrelevant. The tuple is never stringified as one component.
 */
export function configuredSourceInstanceTagComponents(input: Readonly<{
    source: PluginContributionIdentity;
    binding: TriageSourceInstanceDraftV1['binding'];
    localInstanceKey: string;
}>): readonly string[] {
    return [
        input.source.pluginId,
        input.source.localId,
        input.binding.purpose,
        input.binding.account.service.pluginId,
        input.binding.account.service.localId,
        input.binding.account.accountId,
        input.localInstanceKey,
    ];
}

/**
 * `session-links.linkTag`.
 *
 * The immutable entry ref at link creation is the identity, so an authoritative
 * merge can retarget the link's current entry without changing the row it lives
 * in.
 */
export function sessionLinkTagComponents(
    identityEntryRef: TriageEntryRefV1,
    sessionId: string,
): readonly string[] {
    return [...entryReferenceComponents(identityEntryRef), sessionId];
}

/**
 * `session-links.entryTag` — the projected index prefix over the link's CURRENT
 * entry ref, derived in the links collection's own domain. A tag is never
 * copied from one collection to another, even when the components match.
 */
export function sessionLinkEntryTagComponents(entryRef: TriageEntryRefV1): readonly string[] {
    return entryReferenceComponents(entryRef);
}

/**
 * `user-marks.markTag`.
 *
 * Pin, Unpin and Account-mode transition must all address the one mark row, so
 * this is the exact ordered entry-reference tuple and nothing device-local.
 */
export function userMarkTagComponents(entryRef: TriageEntryRefV1): readonly string[] {
    return entryReferenceComponents(entryRef);
}
