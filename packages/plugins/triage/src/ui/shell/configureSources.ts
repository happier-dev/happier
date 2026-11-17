import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  admitTriageSourceDescriptorV1,
  type TriageConfigureSourceOfferV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageConfigureSourceOfferV1 } from '../../corpus/configuration/sourceSetupOffer.js';

/**
 * Where the shell sends a reader who has nothing configured.
 *
 * The unconfigured screen could always name the remedy — "connect a source in
 * Settings" — and could never perform it. Not because navigating to another
 * plugin's page is forbidden (`openSurface` admits a structured reference
 * naming any plugin, and the host's Surface Registry owns admission), but
 * because Triage had no way to NAME the page: the V1 descriptor declared a
 * source's purpose, its display name and its kinds, and nothing about the
 * Settings page every source already ships.
 *
 * `settingsPageId` closes that, and this is the one place the shell turns the
 * host's admitted-contribution snapshot into destinations. The plugin half of
 * each destination is the CONTRIBUTOR the host admitted, never a plugin id read
 * out of descriptor bytes — a source may nominate its own page and cannot
 * nominate anyone else's.
 */

export type { TriageConfigureSourceOfferV1 } from '@happier-dev/triage-protocol/v1';

const NONE: readonly TriageConfigureSourceOfferV1[] = Object.freeze([]);

/**
 * Every admitted V1 source that named a Settings page, in the order the host
 * published them.
 *
 * A source that named none is absent rather than defaulted: the alternative is
 * a control that navigates nowhere, which is the failure this exists to end
 * rather than to relocate. A descriptor this build cannot parse is absent for
 * the same reason.
 */
export function planTriageConfigureSourceOffersV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  /** Only the sources that bring tasks, each named by its task kinds (the Tasks first run). */
  options: Readonly<{ tasks?: boolean }> = {},
): readonly TriageConfigureSourceOfferV1[] {
  if (targetedContributions === undefined) return NONE;
  const point = targetedContributions.points.find(
    (candidate) => candidate.pointId === TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  );
  const snapshot = point?.protocols.find(
    (candidate) => candidate.protocol.id === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1
      && candidate.protocol.version === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  );
  if (snapshot === undefined) return NONE;
  const offers: TriageConfigureSourceOfferV1[] = [];
  for (const contribution of snapshot.contributions) {
    const admitted = admitTriageSourceDescriptorV1(contribution.descriptor);
    if (!admitted.ok || admitted.descriptor.accountDataInstance !== undefined) continue;
    const descriptor = options.tasks === true
      ? { ...admitted.descriptor, kinds: admitted.descriptor.kinds.filter((kind) => kind.task === true) }
      : admitted.descriptor;
    if (descriptor.kinds.length === 0) continue;
    const offer = createTriageConfigureSourceOfferV1(contribution.contributor.pluginId, descriptor);
    if (offer !== undefined) offers.push(offer);
  }
  return Object.freeze(offers);
}
