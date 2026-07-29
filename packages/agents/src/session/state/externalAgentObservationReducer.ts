import {
  ExternalAgentObservationEvidenceV1Schema,
  ExternalAgentObservationSnapshotV1Schema,
  ExternalAgentObservationTargetV1Schema,
  reserveExternalSessionCompletedBoundaryV1,
  type ExternalAgentObservationEvidenceV1,
  type ExternalAgentObservationEvidenceClassV1,
  type ExternalAgentObservationSnapshotV1,
  type ExternalAgentObservationStatusV1,
  type ExternalAgentObservationTargetV1,
  type ExternalSessionCompletedBoundaryV1,
} from '@happier-dev/protocol';

export type {
  ExternalAgentObservationEvidenceV1,
  ExternalAgentObservationSnapshotV1,
  ExternalAgentObservationStatusV1,
  ExternalAgentObservationTargetV1,
} from '@happier-dev/protocol';

type TimedAxisValue<TValue extends string> = Readonly<{
  value: TValue;
  observedAtMs?: number;
  expiresAtMs?: number;
}>;

type TimedEvidenceClaim<TValue extends string> = TimedAxisValue<TValue> & Readonly<{
  claimKind: 'explicit' | 'recent_activity';
}>;

type TimedEvidenceClaims<TValue extends string> = Readonly<
  Partial<Record<ExternalAgentObservationEvidenceClassV1, TimedEvidenceClaim<TValue>>>
>;

export type ExternalAgentObservationBoundaryV1 =
  | Readonly<{
    value: 'unknown';
    observedAtMs?: number;
  }>
  | Readonly<{
    value: 'known';
    boundaryId: string;
    observedAtMs: number;
  }>;

type BoundaryEvidenceClaims = Readonly<
  Partial<Record<ExternalAgentObservationEvidenceClassV1, ExternalAgentObservationBoundaryV1>>
>;

export type ExternalAgentObservationReductionV1 = Readonly<{
  target: ExternalAgentObservationTargetV1;
  evidenceByClass: Readonly<{
    liveness: TimedEvidenceClaims<'running' | 'stopped' | 'unknown'>;
    turnPhase: TimedEvidenceClaims<ExternalAgentObservationStatusV1>;
    boundary: BoundaryEvidenceClaims;
  }>;
  axes: Readonly<{
    liveness: TimedAxisValue<'running' | 'stopped' | 'unknown'>;
    turnPhase: TimedAxisValue<ExternalAgentObservationStatusV1>;
    boundary: ExternalAgentObservationBoundaryV1;
  }>;
  snapshot: ExternalAgentObservationSnapshotV1;
  nextExpiryAtMs?: number;
}>;

const LIVENESS_EVIDENCE_PREFERENCE = [
  'process_probe',
  'agent_native',
  'reconciliation',
] as const satisfies readonly ExternalAgentObservationEvidenceClassV1[];

const TURN_PHASE_EVIDENCE_PREFERENCE = [
  'agent_native',
  'qualified_hook',
  'file_watch',
  'reconciliation',
] as const satisfies readonly ExternalAgentObservationEvidenceClassV1[];

const BOUNDARY_EVIDENCE_CLASSES = [
  'agent_native',
  'qualified_hook',
  'file_watch',
  'reconciliation',
] as const satisfies readonly ExternalAgentObservationEvidenceClassV1[];

function includesEvidenceClass(
  classes: readonly ExternalAgentObservationEvidenceClassV1[],
  evidenceClass: ExternalAgentObservationEvidenceClassV1,
): boolean {
  return classes.includes(evidenceClass);
}

function sameTarget(
  left: ExternalAgentObservationTargetV1,
  right: ExternalAgentObservationTargetV1,
): boolean {
  return left.linkGeneration === right.linkGeneration
    && left.qualifiedLinkIdentity.v === right.qualifiedLinkIdentity.v
    && left.qualifiedLinkIdentity.agent.pluginId === right.qualifiedLinkIdentity.agent.pluginId
    && left.qualifiedLinkIdentity.agent.localId === right.qualifiedLinkIdentity.agent.localId
    && left.qualifiedLinkIdentity.source.kind === right.qualifiedLinkIdentity.source.kind
    && left.qualifiedLinkIdentity.source.contractVersion
      === right.qualifiedLinkIdentity.source.contractVersion;
}

function isExpired(value: Readonly<{ expiresAtMs?: number }>, nowMs: number): boolean {
  return value.expiresAtMs !== undefined && value.expiresAtMs <= nowMs;
}

function expireClaim<TValue extends string>(
  value: TimedEvidenceClaim<TValue>,
  nowMs: number,
): TimedEvidenceClaim<TValue> {
  if (!isExpired(value, nowMs)) return value;
  return {
    value: 'unknown' as TValue,
    claimKind: value.claimKind,
    ...(value.observedAtMs === undefined ? {} : { observedAtMs: value.observedAtMs }),
  };
}

function applyTimedClaim<TValue extends string>(
  current: TimedEvidenceClaim<TValue> | undefined,
  candidate: TimedEvidenceClaim<TValue>,
): TimedEvidenceClaim<TValue> {
  const currentAt = current?.observedAtMs ?? Number.NEGATIVE_INFINITY;
  const candidateAt = candidate.observedAtMs ?? Number.NEGATIVE_INFINITY;
  if (current && candidateAt < currentAt) return current;
  if (
    current
    && current.value !== 'unknown'
    && current.claimKind === 'explicit'
    && candidate.claimKind === 'recent_activity'
  ) {
    return current;
  }
  if (candidateAt > currentAt) return candidate;
  if (!current) return candidate;
  if (
    current.claimKind === 'recent_activity'
    && candidate.claimKind === 'explicit'
  ) {
    return candidate;
  }
  if (candidate.value !== current.value) {
    const expiresAtMs = Math.max(
      current.expiresAtMs ?? 0,
      candidate.expiresAtMs ?? 0,
    );
    return {
      value: 'unknown' as TValue,
      claimKind: 'explicit',
      observedAtMs: candidateAt,
      ...(expiresAtMs > 0 ? { expiresAtMs } : {}),
    };
  }
  return {
    ...candidate,
    claimKind: current.claimKind === 'explicit' ? 'explicit' : candidate.claimKind,
    ...(current.expiresAtMs === undefined && candidate.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: Math.max(current.expiresAtMs ?? 0, candidate.expiresAtMs ?? 0) }),
  };
}

function expireClaims<TValue extends string>(
  claims: TimedEvidenceClaims<TValue>,
  nowMs: number,
): TimedEvidenceClaims<TValue> {
  const next: Partial<
    Record<ExternalAgentObservationEvidenceClassV1, TimedEvidenceClaim<TValue>>
  > = {};
  for (const evidenceClass of Object.keys(claims) as ExternalAgentObservationEvidenceClassV1[]) {
    const claim = claims[evidenceClass];
    if (claim) next[evidenceClass] = expireClaim(claim, nowMs);
  }
  return next;
}

function selectPreferredClaim<TValue extends string>(
  claims: TimedEvidenceClaims<TValue>,
  preference: readonly ExternalAgentObservationEvidenceClassV1[],
): TimedAxisValue<TValue> {
  for (const evidenceClass of preference) {
    const claim = claims[evidenceClass];
    if (claim && claim.value !== 'unknown') return claim;
  }
  let newestUnknown: TimedEvidenceClaim<TValue> | undefined;
  for (const evidenceClass of preference) {
    const claim = claims[evidenceClass];
    if (
      claim
      && (
        !newestUnknown
        || (claim.observedAtMs ?? Number.NEGATIVE_INFINITY)
          > (newestUnknown.observedAtMs ?? Number.NEGATIVE_INFINITY)
      )
    ) {
      newestUnknown = claim;
    }
  }
  return newestUnknown ?? { value: 'unknown' as TValue };
}

function updateTimedClaim<TValue extends string>(
  claims: TimedEvidenceClaims<TValue>,
  evidenceClass: ExternalAgentObservationEvidenceClassV1,
  candidate: TimedEvidenceClaim<TValue>,
): TimedEvidenceClaims<TValue> {
  return {
    ...claims,
    [evidenceClass]: applyTimedClaim(claims[evidenceClass], candidate),
  };
}

function applyTimedRetrievalFailure<TValue extends string>(
  claims: TimedEvidenceClaims<TValue>,
  evidenceClass: ExternalAgentObservationEvidenceClassV1,
  observedAtMs: number,
): TimedEvidenceClaims<TValue> {
  const current = claims[evidenceClass];
  if (current && current.value !== 'unknown') return claims;
  return updateTimedClaim(claims, evidenceClass, {
    value: 'unknown' as TValue,
    claimKind: 'explicit',
    observedAtMs,
  });
}

function applyBoundaryClaim(
  current: ExternalAgentObservationBoundaryV1,
  candidate: ExternalAgentObservationBoundaryV1,
): ExternalAgentObservationBoundaryV1 {
  const currentAt = current.observedAtMs ?? Number.NEGATIVE_INFINITY;
  const candidateAt = candidate.observedAtMs ?? Number.NEGATIVE_INFINITY;
  if (candidateAt < currentAt) return current;
  if (candidate.value === 'unknown') {
    if (candidateAt > currentAt) return candidate;
    return {
      value: 'unknown',
      observedAtMs: candidateAt,
    };
  }
  if (current.value === 'unknown') {
    if (candidateAt === currentAt) {
      return {
        value: 'unknown',
        observedAtMs: candidateAt,
      };
    }
    const reservation = reserveExternalSessionCompletedBoundaryV1(null, {
      id: candidate.boundaryId,
      observedAtMs: candidate.observedAtMs,
    });
    return toObservationBoundary(reservation.boundary);
  }

  const reservation = reserveExternalSessionCompletedBoundaryV1(
    {
      id: current.boundaryId,
      observedAtMs: current.observedAtMs,
    },
    {
      id: candidate.boundaryId,
      observedAtMs: candidate.observedAtMs,
    },
  );
  switch (reservation.outcome) {
    case 'reserved':
      return toObservationBoundary(reservation.boundary);
    case 'replay':
    case 'stale':
      return current;
    case 'conflict':
      return {
        value: 'unknown',
        observedAtMs: candidate.observedAtMs,
      };
  }
}

function toObservationBoundary(
  boundary: ExternalSessionCompletedBoundaryV1,
): ExternalAgentObservationBoundaryV1 {
  return {
    value: 'known',
    boundaryId: boundary.id,
    observedAtMs: boundary.observedAtMs,
  };
}

function processIdentityIsVerified(
  evidence: Extract<ExternalAgentObservationEvidenceV1, { kind: 'process_liveness' }>,
): boolean {
  return evidence.startTimeVerified
    && evidence.processStartedAtMs !== null;
}

function getNextExpiryAtMs(
  evidenceByClass: ExternalAgentObservationReductionV1['evidenceByClass'],
  nowMs: number,
): number | undefined {
  const expiries = [
    ...Object.values(evidenceByClass.liveness),
    ...Object.values(evidenceByClass.turnPhase),
  ]
    .map((claim) => claim?.expiresAtMs)
    .filter((value): value is number => value !== undefined && value > nowMs);
  return expiries.length > 0 ? Math.min(...expiries) : undefined;
}

export function reduceExternalAgentObservationEvidenceV1(params: Readonly<{
  target: ExternalAgentObservationTargetV1;
  current?: ExternalAgentObservationReductionV1 | null;
  evidence: readonly ExternalAgentObservationEvidenceV1[];
  nowMs: number;
}>): ExternalAgentObservationReductionV1 {
  const target = ExternalAgentObservationTargetV1Schema.parse(params.target);
  const current = params.current && sameTarget(params.current.target, target)
    ? params.current
    : null;

  let livenessByClass = expireClaims(
    current?.evidenceByClass.liveness ?? {},
    params.nowMs,
  );
  let turnPhaseByClass = expireClaims(
    current?.evidenceByClass.turnPhase ?? {},
    params.nowMs,
  );
  let boundaryByClass: BoundaryEvidenceClaims = {
    ...(current?.evidenceByClass.boundary ?? {}),
  };
  let boundary = current?.axes.boundary ?? { value: 'unknown' };

  for (const unparsedItem of params.evidence) {
    const parsedItem = ExternalAgentObservationEvidenceV1Schema.safeParse(unparsedItem);
    if (!parsedItem.success) continue;
    const item = parsedItem.data;
    if (!sameTarget(item.target, target)) continue;

    switch (item.kind) {
      case 'liveness':
        if (!includesEvidenceClass(LIVENESS_EVIDENCE_PREFERENCE, item.evidenceClass)) break;
        livenessByClass = updateTimedClaim(livenessByClass, item.evidenceClass, {
          value: item.value,
          claimKind: 'explicit',
          observedAtMs: item.observedAtMs,
          expiresAtMs: item.expiresAtMs,
        });
        break;
      case 'process_liveness':
        livenessByClass = updateTimedClaim(livenessByClass, 'process_probe', {
          value: processIdentityIsVerified(item) ? item.value : 'unknown',
          claimKind: 'explicit',
          observedAtMs: item.observedAtMs,
          expiresAtMs: item.expiresAtMs,
        });
        break;
      case 'turn_phase':
        if (
          !item.evidenceClass
          || !includesEvidenceClass(TURN_PHASE_EVIDENCE_PREFERENCE, item.evidenceClass)
        ) {
          break;
        }
        turnPhaseByClass = updateTimedClaim(turnPhaseByClass, item.evidenceClass, {
          value: item.value,
          claimKind: 'explicit',
          observedAtMs: item.observedAtMs,
          expiresAtMs: item.expiresAtMs,
        });
        break;
      case 'recent_activity':
        if (
          !item.evidenceClass
          || !includesEvidenceClass(TURN_PHASE_EVIDENCE_PREFERENCE, item.evidenceClass)
        ) {
          break;
        }
        turnPhaseByClass = updateTimedClaim(turnPhaseByClass, item.evidenceClass, {
          value: 'recentlyActive',
          claimKind: 'recent_activity',
          observedAtMs: item.observedAtMs,
          expiresAtMs: item.expiresAtMs,
        });
        break;
      case 'completed_boundary':
        if (
          !item.evidenceClass
          || !includesEvidenceClass(BOUNDARY_EVIDENCE_CLASSES, item.evidenceClass)
        ) {
          break;
        }
        const currentClassBoundary = boundaryByClass[item.evidenceClass]
          ?? { value: 'unknown' as const };
        const nextClassBoundary = applyBoundaryClaim(
          currentClassBoundary,
          {
            value: 'known',
            boundaryId: item.boundaryId,
            observedAtMs: item.observedAtMs,
          },
        );
        boundaryByClass = {
          ...boundaryByClass,
          [item.evidenceClass]: nextClassBoundary,
        };
        const classAcceptedCandidate = (
          nextClassBoundary.value === 'known'
          && nextClassBoundary.boundaryId === item.boundaryId
        );
        const classDetectedConflict = (
          currentClassBoundary.value === 'known'
          && nextClassBoundary.value === 'unknown'
          && currentClassBoundary.observedAtMs === item.observedAtMs
          && currentClassBoundary.boundaryId !== item.boundaryId
        );
        if (classAcceptedCandidate || classDetectedConflict) {
          boundary = applyBoundaryClaim(boundary, {
            value: 'known',
            boundaryId: item.boundaryId,
            observedAtMs: item.observedAtMs,
          });
        }
        break;
      case 'successful_empty':
        if (
          !item.evidenceClass
          || !includesEvidenceClass(TURN_PHASE_EVIDENCE_PREFERENCE, item.evidenceClass)
        ) {
          break;
        }
        turnPhaseByClass = updateTimedClaim(turnPhaseByClass, item.evidenceClass, {
          value: item.emptyTurnPhase === 'idle' ? 'idle' : 'unknown',
          claimKind: 'explicit',
          observedAtMs: item.observedAtMs,
          expiresAtMs: item.expiresAtMs,
        });
        break;
      case 'retrieval_failed':
        if (!item.evidenceClass) break;
        if (
          item.axis === 'liveness'
          && includesEvidenceClass(LIVENESS_EVIDENCE_PREFERENCE, item.evidenceClass)
        ) {
          livenessByClass = applyTimedRetrievalFailure(
            livenessByClass,
            item.evidenceClass,
            item.observedAtMs,
          );
        } else if (
          item.axis === 'turn_phase'
          && includesEvidenceClass(TURN_PHASE_EVIDENCE_PREFERENCE, item.evidenceClass)
        ) {
          turnPhaseByClass = applyTimedRetrievalFailure(
            turnPhaseByClass,
            item.evidenceClass,
            item.observedAtMs,
          );
        } else if (
          item.axis === 'boundary'
          && includesEvidenceClass(BOUNDARY_EVIDENCE_CLASSES, item.evidenceClass)
        ) {
          boundaryByClass = {
            ...boundaryByClass,
            [item.evidenceClass]: applyBoundaryClaim(
              boundaryByClass[item.evidenceClass] ?? { value: 'unknown' },
              { value: 'unknown', observedAtMs: item.observedAtMs },
            ),
          };
        }
        break;
      case 'unsupported':
        if (!item.evidenceClass) break;
        if (
          item.axis === 'liveness'
          && includesEvidenceClass(LIVENESS_EVIDENCE_PREFERENCE, item.evidenceClass)
        ) {
          livenessByClass = updateTimedClaim(livenessByClass, item.evidenceClass, {
            value: 'unknown',
            claimKind: 'explicit',
            observedAtMs: item.observedAtMs,
          });
        } else if (
          item.axis === 'turn_phase'
          && includesEvidenceClass(TURN_PHASE_EVIDENCE_PREFERENCE, item.evidenceClass)
        ) {
          turnPhaseByClass = updateTimedClaim(turnPhaseByClass, item.evidenceClass, {
            value: 'unknown',
            claimKind: 'explicit',
            observedAtMs: item.observedAtMs,
          });
        } else if (
          item.axis === 'boundary'
          && includesEvidenceClass(BOUNDARY_EVIDENCE_CLASSES, item.evidenceClass)
        ) {
          boundaryByClass = {
            ...boundaryByClass,
            [item.evidenceClass]: applyBoundaryClaim(
              boundaryByClass[item.evidenceClass] ?? { value: 'unknown' },
              { value: 'unknown', observedAtMs: item.observedAtMs },
            ),
          };
        }
        break;
      case 'lifecycle':
        break;
    }
  }

  livenessByClass = expireClaims(livenessByClass, params.nowMs);
  turnPhaseByClass = expireClaims(turnPhaseByClass, params.nowMs);
  const liveness = selectPreferredClaim(
    livenessByClass,
    LIVENESS_EVIDENCE_PREFERENCE,
  );
  const turnPhase = selectPreferredClaim(
    turnPhaseByClass,
    TURN_PHASE_EVIDENCE_PREFERENCE,
  );

  const snapshot = ExternalAgentObservationSnapshotV1Schema.parse({
    v: 1,
    ...target,
    status: turnPhase.value,
    ...(turnPhase.value === 'unknown' || turnPhase.observedAtMs === undefined
      ? {}
      : { observedAtMs: turnPhase.observedAtMs }),
    ...(turnPhase.value === 'unknown' || turnPhase.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: turnPhase.expiresAtMs }),
    ...(boundary.value === 'known'
      ? { boundary: { id: boundary.boundaryId, observedAtMs: boundary.observedAtMs } }
      : {}),
  });
  const evidenceByClass = {
    liveness: livenessByClass,
    turnPhase: turnPhaseByClass,
    boundary: boundaryByClass,
  };
  const axes = { liveness, turnPhase, boundary };
  const nextExpiryAtMs = getNextExpiryAtMs(evidenceByClass, params.nowMs);

  return {
    target,
    evidenceByClass,
    axes,
    snapshot,
    ...(nextExpiryAtMs === undefined ? {} : { nextExpiryAtMs }),
  };
}
