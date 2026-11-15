import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { LocalServicePublicPreviewActions } from './publicPreviewActions';
import type {
  ServiceRowCopyUrlHandler,
  ServiceRowForgetHandler,
  ServiceRowManagedControlHandler,
  ServiceRowOpenHandler,
  ServiceRowStartHandler,
  ServiceRowTerminateHandler,
} from './ServiceRowView';

/**
 * Every effect a Services entry can have, already bound to one surface's Action admission (see
 * `useLocalServiceEntryActions`). The opener is the surface's own: it depends on where a browser
 * view can open, so the admission hook never supplies it.
 */
export type LocalServiceEntryHandlers = Readonly<{
  onOpenServiceInBrowser?: ServiceRowOpenHandler;
  onStartLauncherTarget?: ServiceRowStartHandler;
  onTerminateDetectedService?: ServiceRowTerminateHandler;
  onForgetDetectedService?: ServiceRowForgetHandler;
  onStopManagedService?: ServiceRowManagedControlHandler;
  onRestartManagedService?: ServiceRowManagedControlHandler;
  onCopyServiceUrl?: ServiceRowCopyUrlHandler;
  onClearLauncherHistory?: () => Promise<unknown>;
  publicPreviewActions?: LocalServicePublicPreviewActions;
}>;

/** What one entry offers: the single decision both the Services row and the Processes port menu draw. */
export type LocalServiceEntryActions = Readonly<{
  /** The target Open hands to the surface's opener, when the entry is openable and the surface can open. */
  open: LocalServiceLaunchTarget | null;
  start: LocalServiceLaunchTarget | null;
  /** A detected listener with ownership evidence: `localServices.actions.terminateDetected`. */
  terminateDetected: boolean;
  forget: boolean;
  /** A managed lifetime the supervisor controls, while it is live: `localServices.actions.stopManaged`. */
  stopManaged: boolean;
  restartManaged: boolean;
  /** Where it answers, as a URL: Copy address's value. */
  address: string | null;
  /**
   * Why Open cannot reach the service from this device, when the private-preview access owner has
   * said so for its registered preview (`preview_private_route_unavailable`: loopback on another
   * machine with no route here). Only known where the caller passes that owner's preview state.
   */
  openUnavailableReason: string | null;
}>;

/**
 * A managed native occurrence whose state is unknown, or stopped while its starter tree is still
 * owned (CA2-02). It is not Running, but it is not settled either: it keeps Stop for cleanup.
 */
export function hasUnsettledLocalServiceCustody(row: ServiceRow): boolean {
  return (
    row.target.source === 'managed_service' &&
    row.target.actions.includes('manage') &&
    (row.reasonCode === 'managed_service_native_state_unknown' ||
      row.reasonCode === 'managed_service_native_cleanup_unconfirmed')
  );
}

/**
 * The row's address, as a URL.
 *
 * An IPv6 literal must be bracketed or the result is not a URL at all — `http://::1:5173` has no
 * meaningful port. The projected address label is preferred for display; this URL-shaped value
 * remains the copy action's source and the fallback when no display label is available.
 */
export function formatLocalServiceRowAddress(row: ServiceRow): string | null {
  // A managed lifetime's observed endpoint is its address when no listener row is joined.
  if (!row.host) return row.target.endpointUrl ?? null;
  // A service bound to every interface answers on localhost: show and copy that, never the bind
  // address (`0.0.0.0`, `::`), which is not somewhere a person can go.
  const wildcard =
    row.host === '0.0.0.0' ||
    row.host === '::' ||
    row.host === '[::]' ||
    row.host === '*';
  const bound = wildcard ? 'localhost' : row.host;
  const host =
    bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound;
  const scheme =
    row.scheme && row.scheme !== 'unknown' ? `${row.scheme}://` : '';
  return `${scheme}${host}${row.portLabel ?? ''}`;
}

export function resolveLocalServiceEntryActions(
  row: ServiceRow,
  handlers: LocalServiceEntryHandlers,
  previews?: LocalServicePreviewState | null,
): LocalServiceEntryActions {
  const primary = row.primaryAction;
  const open =
    primary?.kind === 'open' && handlers.onOpenServiceInBrowser
      ? primary.openTarget
      : null;
  const previewTarget = open?.browserTarget;
  const preview =
    previewTarget?.kind === 'localServicePreview'
      ? previews?.previewsById.get(previewTarget.targetId)
      : undefined;
  // Stop and Restart exist only where the supervisor actually controls the lifetime (`manage`), and
  // only while it is live: a settled or never-started declaration has nothing to stop.
  const managedLive =
    row.target.source === 'managed_service' &&
    row.target.actions.includes('manage') &&
    (row.status === 'running' ||
      row.status === 'starting' ||
      row.status === 'stopping' ||
      hasUnsettledLocalServiceCustody(row));
  return {
    open,
    start:
      primary?.kind === 'start' && handlers.onStartLauncherTarget
        ? primary.target
        : null,
    terminateDetected:
      row.target.source === 'inventory_entry' &&
      row.target.actions.includes('terminate_detected') &&
      Boolean(handlers.onTerminateDetectedService),
    // `forget` hides a detected row or a managed occurrence's history; it needs no daemon capability
    // bit because the suppression is always available, and it never stops anything.
    forget:
      (row.target.source === 'inventory_entry' ||
        row.target.source === 'managed_service') &&
      Boolean(handlers.onForgetDetectedService),
    stopManaged: managedLive && Boolean(handlers.onStopManagedService),
    restartManaged:
      managedLive &&
      row.status === 'running' &&
      Boolean(handlers.onRestartManagedService),
    // A stopped or failed Service answers nowhere: there is no address to copy until it runs again.
    address: row.status === 'stopped' || row.status === 'failed' ? null : formatLocalServiceRowAddress(row),
    openUnavailableReason:
      preview?.accessUnavailableReasonCode === 'preview_private_route_unavailable'
        ? t('browserShell.unavailable.previewElsewhere')
        : null,
  };
}

/** Copy address, through the one copy owner; a refused copy says so instead of failing silently. */
export async function copyLocalServiceAddress(
  target: LocalServiceLaunchTarget,
  address: string,
  onCopyServiceUrl: ServiceRowCopyUrlHandler | undefined,
  copyToClipboard: (value: string) => Promise<boolean>,
): Promise<boolean> {
  const copied = onCopyServiceUrl
    ? await onCopyServiceUrl(target, address)
    : target.source === 'managed_service'
      ? false
      : await copyToClipboard(address);
  if (!copied) {
    Modal.alert(
      t('localServices.actions.failureTitle.copyAddress'),
      resolveReasonCopy({ reasonCode: null, kind: 'localServiceAction' }).body,
    );
  }
  return copied;
}
