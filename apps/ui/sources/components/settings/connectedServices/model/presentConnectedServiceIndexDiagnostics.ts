import type { ConnectedServiceRegistryEntry, ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ConnectedAccountDescriptorProjectionErrorReason } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { t } from '@/text';

type IndexDiagnosticsPresentation = Readonly<{
  primary: string | null;
  supportDetails: string | null;
}>;

// These are failed registry reads, not failed account mutations. Each bounded
// read outcome uses the existing account-preserving read notice, including a
// malformed or unsupported machine response; none claims a change was sent.
const REGISTRY_READ_FAILURE_COPY = {
  unsupported: 'connectedServicesSettings.projectionErrorDescription',
  malformed: 'connectedServicesSettings.projectionErrorDescription',
  transport: 'connectedServicesSettings.projectionErrorDescription',
  partial_machine_failure: 'connectedServicesSettings.projectionErrorDescription',
} as const satisfies Record<ConnectedAccountDescriptorProjectionErrorReason, string>;

export function presentConnectedServiceRegistryReadFailure(reason: ConnectedAccountDescriptorProjectionErrorReason | null): string {
  return t((reason ? REGISTRY_READ_FAILURE_COPY[reason] : null) ?? 'connectedServicesSettings.projectionErrorDescription');
}

/**
 * The registry read failure the page and the "+" menu each explain once, or null while the read is current.
 * Machine coverage does not own Account declarations. Partial coverage stays
 * in the typed diagnostics without asking the person to repair unrelated Machines.
 */
export function presentConnectedServiceRegistryReadState(snapshot: Readonly<{
  status: ConnectedServiceRegistrySnapshot['status'];
  errorReason: ConnectedAccountDescriptorProjectionErrorReason | null;
}>): string | null {
  if (snapshot.errorReason === 'partial_machine_failure') return null;
  const failed = snapshot.status === 'error' || (snapshot.status === 'stale' && snapshot.errorReason !== null);
  return failed ? presentConnectedServiceRegistryReadFailure(snapshot.errorReason) : null;
}

export function presentConnectedServiceIndexDiagnosticCopy(code: string): string {
  if (code === 'missing_runtime') return t('connectedServicesSettings.runtimeNotLoaded');
  // Registry diagnostics are read facts, including unknown boundary codes.
  // Never reinterpret them as an attempted Account mutation or display raw text.
  return presentConnectedServiceRegistryReadFailure(null);
}

/** A reason leads a service only when it says something about that service; the generic read failure is the page's. */
function addSpecificReason(primary: Set<string>, code: string): void {
  const copy = presentConnectedServiceIndexDiagnosticCopy(code);
  if (copy !== presentConnectedServiceRegistryReadFailure(null)) primary.add(copy);
}

/** The descriptor projection's reason for a service no answering machine can run (`connectedAccountDescriptorProjection`). */
const EXECUTION_ORIGIN_UNAVAILABLE = 'execution_origin_unavailable';

function appendSafeSupportDetail(values: Set<string>, code: string | null | undefined): void {
  if (!code) return;
  const detail = presentConnectedServiceIndexDiagnosticCopy(code);
  values.add(detail);
}

/**
 * Projects service-specific conflicts, availability and descriptor diagnostics.
 * Registry read failures belong to the page notice, never to each service.
 *
 * The primary row is one message, the highest-priority fact, and consumes only bounded state and
 * read-diagnostic copy.
 * The support disclosure contains the same bounded product-copy
 * projection, never boundary text.
 */
export function presentConnectedServiceIndexDiagnostics(params: Readonly<{
  entry: ConnectedServiceRegistryEntry;
}>): IndexDiagnosticsPresentation {
  const primary = new Set<string>();
  const entry = params.entry;

  if (entry.projectionConflicts?.some(conflict => conflict.kind === 'identity_divergence')) {
    const conflict = t('connectedServicesSettings.identityConflict');
    primary.add(conflict);
  } else if (entry.projectionStatus === 'conflict') primary.add(t('common.blocked'));
  const availabilityState = entry.availability?.state;
  // Only a machine to run it is missing: the page notice and the "+" menu say that once for every service,
  // so the service itself stays quiet (its details keep the fact).
  const waitsForMachine = availabilityState === 'blocked' && entry.availability?.reason === EXECUTION_ORIGIN_UNAVAILABLE;
  // The reason (what is wrong, what to do) leads; the bare state is the headline only when no reason is known.
  const stateCopy = availabilityState === 'blocked' ? t('common.blocked')
    : availabilityState === 'disabled' ? t('common.disabled') : null;
  const details = new Set(primary);
  if (stateCopy) details.add(stateCopy);

  // The descriptor producer keeps sound declarations available through plugin runtime
  // diagnostics. An answered service cannot be presented as a failed registry read.
  if (entry.projectionStatus === 'ready' && entry.availability?.state === 'available') {
    if (entry.diagnostics?.length) details.add(t('settingsPlugins.diagnosticsSnapshotFooter'));
  } else {
    for (const diagnostic of entry.diagnostics ?? []) {
      if (!waitsForMachine) addSpecificReason(primary, diagnostic);
      appendSafeSupportDetail(details, diagnostic);
    }
  }
  if (entry.availability?.state !== 'available') {
    const reason = entry.availability?.reason;
    if (reason && !waitsForMachine) addSpecificReason(primary, reason);
    appendSafeSupportDetail(details, reason);
  }
  if (stateCopy && !waitsForMachine) primary.add(stateCopy);
  return {
    // One message per service: the first fact that needs the user (they are added in priority order).
    // Every distinct fact stays in the support disclosure.
    primary: [...primary].find(Boolean) ?? null,
    supportDetails: details.size > 0 ? [...details].join('\n') : null,
  };
}
