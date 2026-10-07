import * as React from 'react';
import type { ComposerReferenceCandidatePageV1, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiContributionIdentityV1 } from '@happier-dev/plugin-sdk/ui';

import { resolveTriageCrossCopyContext } from './crossCopyContext.js';
import type { TriageSourcePanelOperationV1, TriageSourcePanelResultV1 } from './sourcePanelProtocol.js';

export type TriageSourcePanelCommandV1 = Readonly<{ title: string; operation: TriageSourcePanelOperationV1 }>;
export type TriageSourcePanelHandlerV1 = (operation: TriageSourcePanelOperationV1, signal: AbortSignal) => Promise<TriageSourcePanelResultV1>;
export type TriageSourcePanelActionsV1 = Readonly<{
  bind(kind: TriageSourcePanelOperationV1['kind'], invoke: TriageSourcePanelHandlerV1, commands: readonly TriageSourcePanelCommandV1[]): () => void;
  execute(operation: TriageSourcePanelOperationV1, signal?: AbortSignal): Promise<TriageSourcePanelResultV1>;
}>;

/**
 * The child-to-parent half of Triage's selected-evidence disclosure seam.
 *
 * A source detail is the only surface that knows what "the thing the reader is
 * looking at" is in its own provider's terms, so it is the only surface that can
 * offer to put a reference to it into the message the reader was writing. It is
 * NOT the surface that may touch that message: the Composer the detail was
 * opened from is addressed by an exact `originComposer` carried in Triage's own
 * closed launch input, and handing that address down here would make every
 * source an independent Composer writer with its own read/apply/token rules.
 *
 * So the address never crosses this boundary. The source discloses one bounded
 * identity-only candidate and the already-mounted Triage parent performs the one
 * revision-checked transaction against the exact bound draft, exactly as the
 * post-mutation seam beside this one keeps the aggregate re-read with the parent.
 *
 * The resolver form is deliberate: the source's own selection or confirmation
 * runs INSIDE the parent's currentness fence, so a candidate that settles after
 * the reader moved to another entry — or after the detail unmounted — is aborted
 * and cannot reach the draft.
 */

/**
 * One disclosure-approved candidate, qualified by the reference contribution
 * that resolves it at dispatch.
 *
 * The candidate shape is the public Composer provider's own bounded page item,
 * not a Triage mirror: Triage never receives, stores or interprets the selected
 * provider response bytes, and the reference identity is what re-reads them at
 * dispatch time.
 */
export type TriageEvidenceCandidateV1 = Readonly<{
  reference: PluginUiContributionIdentityV1;
  candidate: ComposerReferenceCandidatePageV1[number];
}>;

/**
 * The source's own disclosure step. `null` means the reader cancelled it. The
 * signal belongs to this exact request and is aborted on replacement or unmount,
 * so a source that opens its own picker here must forward it.
 */
export type TriageEvidenceDisclosureResolverV1 = (
  signal: AbortSignal,
) => Promise<TriageEvidenceCandidateV1 | null>;

/**
 * What became of one disclosure, in terms a source can act on without learning
 * anything about the draft.
 *
 * `inert` is the honest answer for a request the parent superseded or that
 * arrived with no Triage parent mounted at all: nothing was applied and nothing
 * failed. It is distinct from `cancelled`, which is the reader's own withdrawal.
 */
export type TriageEvidenceDisclosureOutcomeV1 =
  | Readonly<{ kind: 'applied' }>
  /** The draft already holds this exact reference; nothing needed to change. */
  | Readonly<{ kind: 'settled' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'inert' }>
  | Readonly<{ kind: 'refused'; reason: string }>;

/** The shared Action result describes the existing disclosure owner's settled outcome. */
export function triageEvidenceDisclosureActionResultV1(outcome: TriageEvidenceDisclosureOutcomeV1): TriageSourcePanelResultV1 {
  return { status: outcome.kind === 'applied' || outcome.kind === 'settled' ? 'applied'
    : outcome.kind === 'inert' ? 'unavailable' : 'rejected' };
}

export type TriageEvidenceDisclosureV1 = Readonly<{
  /** Mounted intents share the parent's existing Action address, never its draft authority. */
  panelActions?: TriageSourcePanelActionsV1;
  /**
   * Whether a Composer origin is currently addressable for this detail. A
   * source offers its disclosure control only while this is true: a control
   * whose one reachable outcome is a refusal is false availability.
   */
  available: boolean;
  disclose(
    resolve: TriageEvidenceDisclosureResolverV1,
    options?: PluginCancellationOptions,
  ): Promise<TriageEvidenceDisclosureOutcomeV1>;
}>;

const INERT: TriageEvidenceDisclosureOutcomeV1 = Object.freeze({ kind: 'inert' });

/**
 * No Triage parent is mounted, so there is no draft to disclose into. The
 * resolver is deliberately NOT invoked: running a source's own selection for a
 * disclosure that can reach nothing would show the reader a picker whose result
 * is discarded.
 */
const NO_EVIDENCE_DISCLOSURE: TriageEvidenceDisclosureV1 = Object.freeze({
  available: false,
  disclose: async () => INERT,
});

/**
 * The parent installing this seam and the source reading it are separate plugin
 * artifacts, each with its own bundled copy of this module, so the context
 * object itself is agreed across copies. See `crossCopyContext.ts`.
 */
const TRIAGE_EVIDENCE_DISCLOSURE_CONTEXT_KEY = Symbol.for(
  'happier.triageSources.privateEvidenceDisclosureContext.v1',
);

const TriageEvidenceDisclosureContext = resolveTriageCrossCopyContext<TriageEvidenceDisclosureV1>(
  TRIAGE_EVIDENCE_DISCLOSURE_CONTEXT_KEY,
  NO_EVIDENCE_DISCLOSURE,
);

export function TriageEvidenceDisclosureProvider(props: Readonly<{
  disclosure: TriageEvidenceDisclosureV1;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <TriageEvidenceDisclosureContext.Provider value={props.disclosure}>
      {props.children}
    </TriageEvidenceDisclosureContext.Provider>
  );
}

/** The one disclosure a mounted source detail may make into the originating draft. */
export function useTriageEvidenceDisclosure(): TriageEvidenceDisclosureV1 {
  return React.useContext(TriageEvidenceDisclosureContext);
}
