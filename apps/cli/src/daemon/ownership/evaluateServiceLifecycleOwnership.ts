import type { CurrentDaemonOwner, DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';

export type DaemonServiceLifecycleConflict =
  | Readonly<{ kind: 'unknown-owner-conflict'; owner: CurrentDaemonOwner }>
  | Readonly<{ kind: 'manual-owner-conflict'; owner: CurrentDaemonOwner }>
  | Readonly<{ kind: 'other-service-conflict'; owner: CurrentDaemonOwner }>;

export function evaluateDaemonServiceLifecycleOwnership(params: Readonly<{
  ownership: DaemonOwnerEvaluation;
  expectedServiceLabel: string;
}>): Readonly<{ kind: 'ok' }> | DaemonServiceLifecycleConflict {
  const expectedServiceLabel = params.expectedServiceLabel.trim();
  if (!expectedServiceLabel) {
    throw new Error('expectedServiceLabel is required');
  }
  if (params.ownership.kind === 'none') {
    return { kind: 'ok' };
  }

  const owner = params.ownership.owner;
  if (owner.serviceManaged === null) {
    return { kind: 'unknown-owner-conflict', owner };
  }

  if (owner.serviceManaged === false) {
    return { kind: 'manual-owner-conflict', owner };
  }

  if (owner.state.serviceLabel === expectedServiceLabel) {
    return { kind: 'ok' };
  }

  return { kind: 'other-service-conflict', owner };
}

function buildOwnerDetails(owner: CurrentDaemonOwner): string[] {
  const lines = [
    `Current release channel: ${owner.state.startedWithPublicReleaseChannel ?? 'unknown'}`,
    `Current CLI version: ${owner.state.startedWithCliVersion}`,
  ];
  if (owner.state.serviceLabel) {
    lines.push(`Current background service label: ${owner.state.serviceLabel}`);
  }
  return lines;
}

export function renderDaemonServiceLifecycleOwnershipConflict(params: Readonly<{
  action: 'install' | 'start' | 'restart';
  conflict: DaemonServiceLifecycleConflict;
}>): Readonly<{ title: string; lines: readonly string[] }> {
  const owner = params.conflict.owner;
  if (params.conflict.kind === 'unknown-owner-conflict') {
    const actionDescription = params.action === 'install'
      ? 'install the background service'
      : `${params.action} the background service`;
    return {
      title: 'The current relay owner source could not be determined safely.',
      lines: [
        ...buildOwnerDetails(owner),
        `Stop the current relay owner before trying to ${actionDescription}.`,
      ],
    };
  }

  if (params.conflict.kind === 'manual-owner-conflict') {
    const actionDescription = params.action === 'install'
      ? 'install the background service'
      : `${params.action} the background service`;
    return {
      title: 'A manual relay runtime currently owns this relay.',
      lines: [
        ...buildOwnerDetails(owner),
        `Use \`happier daemon stop\` before trying to ${actionDescription}.`,
      ],
    };
  }

  const actionDescription = params.action === 'install'
    ? 'install a different background service'
    : `${params.action} a different background service`;
  return {
    title: 'Another background service currently owns this relay.',
    lines: [
      ...buildOwnerDetails(owner),
      `Use \`happier service stop\` or \`happier service repair\` before trying to ${actionDescription}.`,
    ],
  };
}

export function renderDaemonServiceStopOwnershipNote(params: Readonly<{
  ownership: DaemonOwnerEvaluation;
  expectedServiceLabel: string;
}>): Readonly<{ title: string; lines: readonly string[] }> | null {
  if (params.ownership.kind === 'none') {
    return null;
  }

  const owner = params.ownership.owner;
  if (owner.serviceManaged === true && owner.state.serviceLabel === params.expectedServiceLabel) {
    return null;
  }

  if (owner.serviceManaged === true) {
    return {
      title: 'Stopping this background service will not stop the current relay owner.',
      lines: [
        ...buildOwnerDetails(owner),
        'A different background service currently owns this relay.',
        'Use `happier service stop` from the currently owning installation, or run `happier service status` to inspect the active owner.',
      ],
    };
  }

  if (owner.serviceManaged === false) {
    return {
      title: 'Stopping this background service will not stop the current relay owner.',
      lines: [
        ...buildOwnerDetails(owner),
        'A manual relay runtime currently owns this relay.',
        'Use `happier daemon stop` if you also want to stop the current relay owner.',
      ],
    };
  }

  return {
    title: 'Stopping this background service will not stop the current relay owner.',
    lines: [
      ...buildOwnerDetails(owner),
      'The current relay owner source could not be determined safely.',
      'Stop the current relay owner separately if you also need to switch ownership.',
    ],
  };
}

export function renderDaemonServiceRepairOwnershipNote(params: Readonly<{
  ownership: DaemonOwnerEvaluation;
}>): Readonly<{ title: string; lines: readonly string[] }> | null {
  if (params.ownership.kind === 'none') {
    return null;
  }

  const owner = params.ownership.owner;
  if (owner.serviceManaged === true) {
    return null;
  }

  if (owner.serviceManaged === false) {
    return {
      title: 'Repairing background services will not stop the current relay owner.',
      lines: [
        ...buildOwnerDetails(owner),
        'A manual relay runtime currently owns this relay.',
        'Use `happier daemon stop` or `happier daemon restart` if you also need to switch the current relay owner.',
      ],
    };
  }

  return {
    title: 'Repairing background services will not stop the current relay owner.',
    lines: [
      ...buildOwnerDetails(owner),
      'The current relay owner source could not be determined safely.',
      'Stop the current relay owner separately if you also need to switch ownership.',
    ],
  };
}
