import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { t } from '@/text';

import { resolveConnectedServiceSettingsErrorMessage } from '../connectedServiceSettingsErrors';

type IndexDiagnosticsPresentation = Readonly<{
  primary: string | null;
  supportDetails: string | null;
}>;

const MAX_SUPPORT_DETAILS = 4;

export function presentConnectedServiceIndexDiagnosticCopy(code: string): string {
  // `missing_runtime` is a bounded projection diagnostic, not free-form
  // provider text. Keep it product-facing while all unknown strings use the
  // canonical typed-error presenter below.
  if (code === 'missing_runtime') return t('common.unavailable');
  return resolveConnectedServiceSettingsErrorMessage({ code });
}

function appendSafeSupportDetail(values: Set<string>, code: string | null | undefined): void {
  if (!code) return;
  const detail = presentConnectedServiceIndexDiagnosticCopy(code);
  if (values.size >= MAX_SUPPORT_DETAILS && !values.has(detail)) return;
  values.add(detail);
}

/**
 * Projects registry lifecycle and descriptor diagnostics for the index.
 *
 * The primary row consumes only bounded state copy or the existing typed-code
 * presenter. The support disclosure contains the same bounded product-copy
 * projection, never boundary text.
 */
export function presentConnectedServiceIndexDiagnostics(params: Readonly<{
  entry: ConnectedServiceRegistryEntry;
  registryErrorReason: string | null;
}>): IndexDiagnosticsPresentation {
  if (!params.entry.projectedDescriptor) {
    return { primary: null, supportDetails: null };
  }

  const primary = new Set<string>();
  const details = new Set<string>();
  const entry = params.entry;

  if (entry.projectionStatus === 'conflict') primary.add(t('common.blocked'));
  if (entry.projectionStatus === 'stale') primary.add(t('common.unavailable'));
  if (entry.availability?.state === 'blocked') primary.add(t('common.blocked'));
  if (entry.availability?.state === 'disabled') primary.add(t('common.disabled'));

  for (const diagnostic of entry.diagnostics ?? []) {
    primary.add(presentConnectedServiceIndexDiagnosticCopy(diagnostic));
    appendSafeSupportDetail(details, diagnostic);
  }
  if (entry.availability?.state !== 'available') {
    const reason = entry.availability?.reason;
    if (reason) primary.add(presentConnectedServiceIndexDiagnosticCopy(reason));
    appendSafeSupportDetail(details, reason);
  }
  if (entry.projectionStatus === 'stale') {
    if (params.registryErrorReason) {
      primary.add(presentConnectedServiceIndexDiagnosticCopy(params.registryErrorReason));
    }
    appendSafeSupportDetail(details, params.registryErrorReason);
  }

  return {
    primary: [...primary].filter(Boolean).join(' · ') || null,
    supportDetails: details.size > 0 ? [...details].join('\n') : null,
  };
}
