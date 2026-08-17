import type {
  TriageDetailSurfaceInputV1,
  TriageEntryPresentationStateV1,
  TriageLinkedSessionProjectionV1,
  TriageRowFactStatusToneV1,
  TriageViewerInvolvementV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * One projected field of the Azure DevOps detail overview.
 *
 * `pending` is its own arm rather than an empty value: an unbuilt tab and an empty tab must not
 * look alike, and a reader who cannot tell them apart concludes the pull request has no reviewers
 * when the truth is that this build has not read them yet.
 */
export type AzureDetailFieldV1 =
  | Readonly<{ kind: 'text'; id: string; label: string; value: string }>
  | Readonly<{ kind: 'status'; id: string; label: string; value: string; tone: TriageRowFactStatusToneV1 }>
  | Readonly<{ kind: 'number'; id: string; label: string; value: number; format: 'compact' | 'plain'; approximate: boolean }>
  | Readonly<{ kind: 'timestamp'; id: string; label: string; atMs: number; format: 'relative' | 'absolute' }>
  | Readonly<{ kind: 'pending'; id: string; label: string }>;

export type AzureDetailOverviewV1 = Readonly<{
  title: string;
  scopeLabel: string;
  displayPath: string | null;
  webUrl: string | null;
  state: Readonly<{ presentation: TriageEntryPresentationStateV1; nativeLabel: string | null }>;
  involvement: readonly TriageViewerInvolvementV1[];
  fields: readonly AzureDetailFieldV1[];
  observedAtMs: number;
  sourceUpdatedAtMs: number | null;
  nativeRevision: string | null;
  projectionTruncated: boolean;
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
}>;

/**
 * Project the host-applied observation into the detail overview this surface renders.
 *
 * It reads only the mounted input, so it is useful before any Azure DevOps request and stays
 * correct when one fails. Nothing here re-derives identity or a route: the applied observation is
 * already the target's stamped record of this exact entry.
 */
export function projectAzureDetailOverview(
  input: TriageDetailSurfaceInputV1,
): AzureDetailOverviewV1 {
  const { observation } = input;
  const fields: AzureDetailFieldV1[] = observation.snapshot.facts.map((fact) => {
    const label = fact.label ?? fact.id;
    switch (fact.value.kind) {
      case 'status':
        return {
          kind: 'status' as const,
          id: fact.id,
          label,
          value: fact.value.value,
          tone: fact.value.tone,
        };
      case 'number':
        return {
          kind: 'number' as const,
          id: fact.id,
          label,
          value: fact.value.value,
          format: fact.value.format,
          approximate: fact.value.approximate === true,
        };
      case 'timestamp':
        return {
          kind: 'timestamp' as const,
          id: fact.id,
          label,
          atMs: fact.value.atMs,
          format: fact.value.format,
        };
      case 'text':
      case 'actor':
        return { kind: 'text' as const, id: fact.id, label, value: fact.value.value };
      default:
        // `detailOnly` names a fact whose value lives in the detail body this build does not read
        // yet. Rendering it as empty text would claim the value is absent rather than unloaded.
        return { kind: 'pending' as const, id: fact.id, label };
    }
  });

  return {
    title: observation.snapshot.title,
    scopeLabel: observation.snapshot.scopeLabel,
    displayPath: observation.locator.displayPath ?? null,
    webUrl: observation.locator.webUrl ?? null,
    state: {
      presentation: observation.snapshot.state.presentation,
      nativeLabel: observation.snapshot.state.nativeLabel ?? null,
    },
    involvement: observation.viewer.involvement,
    // The §6.6 sections are no longer named as pending here: `Activity`,
    // `Files`, `Policies` and `Threads` are real tabs with real reads now, and a
    // badge saying they are unloaded would contradict the panel beside it. The
    // `pending` arm survives for the row facts the LIST defers to the detail
    // body, which is a different claim.
    fields,
    observedAtMs: observation.observedAtMs,
    sourceUpdatedAtMs: observation.sourceUpdatedAtMs ?? null,
    nativeRevision: observation.nativeRevision ?? null,
    projectionTruncated: observation.snapshot.projectionTruncated === true,
    linkedSessions: input.linkedSessions,
  };
}
