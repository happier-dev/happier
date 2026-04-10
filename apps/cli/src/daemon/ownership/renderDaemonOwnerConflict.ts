import type { CurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { buildDaemonTakeoverHint } from '@/daemon/ownership/resolveDaemonTakeoverDecision';

type DaemonOwnerConflictIntent =
  | 'session-autostart'
  | 'daemon-start'
  | 'daemon-start-sync'
  | 'daemon-stop'
  | 'daemon-restart';

function describeOwner(owner: CurrentDaemonOwner): string {
  if (owner.serviceManaged === true) {
    return 'background service';
  }
  if (owner.serviceManaged === false) {
    return 'manual relay runtime';
  }
  return 'relay owner';
}

function buildOwnerDetails(owner: CurrentDaemonOwner): string[] {
  const details = [
    `Current owner: ${describeOwner(owner)}`,
    `Current release channel: ${owner.state.startedWithPublicReleaseChannel ?? 'unknown'}`,
    `Current CLI version: ${owner.state.startedWithCliVersion}`,
  ];
  if (owner.state.serviceLabel) {
    details.push(`Background service label: ${owner.state.serviceLabel}`);
  }
  return details;
}

export function renderDaemonOwnerConflict(params: Readonly<{
  intent: DaemonOwnerConflictIntent;
  owner: CurrentDaemonOwner;
}>): Readonly<{ title: string; lines: readonly string[] }> {
  const owner = params.owner;
  const details = buildOwnerDetails(owner);

  if (params.intent === 'session-autostart') {
    return {
      title: owner.serviceManaged === true
        ? 'A different background service already owns this relay.'
        : owner.serviceManaged === false
          ? 'A different relay runtime already owns this relay.'
          : 'A different relay owner already owns this relay.',
      lines: [
        ...details,
        owner.serviceManaged
          ? 'Happier will continue without switching it.'
          : owner.serviceManaged === false
            ? 'Happier will continue without starting another relay runtime.'
            : 'Happier will continue without changing the current relay owner.',
        owner.serviceManaged
          ? 'Use `happier service restart` if you want to switch the background service to this installation.'
          : owner.serviceManaged === false
            ? 'Use `happier daemon restart` if you want to replace the current manual relay runtime.'
            : 'Restart the current relay owner before trying to switch this invocation.',
      ],
    };
  }

  if (params.intent === 'daemon-start') {
    return {
      title: owner.serviceManaged === true
        ? 'A background service already owns this relay.'
        : owner.serviceManaged === false
          ? 'Another relay runtime already owns this relay.'
          : 'Another relay owner already owns this relay.',
      lines: [
        ...details,
        owner.serviceManaged
          ? 'Use `happier service restart` if you want to switch the background service to this installation.'
          : owner.serviceManaged === false
            ? buildDaemonTakeoverHint({ commandPath: 'happier daemon', action: 'start' })
            : 'Stop the current relay owner before starting another one.',
      ],
    };
  }

  if (params.intent === 'daemon-start-sync') {
    return {
      title: owner.serviceManaged === true
        ? 'A background service already owns this relay.'
        : owner.serviceManaged === false
          ? 'Another relay runtime already owns this relay.'
          : 'Another relay owner already owns this relay.',
      lines: [
        ...details,
        owner.serviceManaged
          ? 'Use `happier service restart` if you want to switch the background service to this installation.'
          : owner.serviceManaged === false
            ? buildDaemonTakeoverHint({ commandPath: 'happier daemon', action: 'start-sync' })
            : 'Stop the current relay owner before starting another one.',
      ],
    };
  }

  if (params.intent === 'daemon-stop') {
    return {
      title: owner.serviceManaged === true
        ? 'The current relay owner is managed by a background service.'
        : 'The current relay owner source could not be determined safely.',
      lines: [
        ...details,
        owner.serviceManaged === true
          ? 'Use `happier service stop` instead of `happier daemon stop`.'
          : 'Use `happier service stop` only if you know the current owner came from the background service.',
      ],
    };
  }

  if (owner.serviceManaged === true) {
    return {
      title: 'The current relay owner is managed by a background service.',
      lines: [
        ...details,
        'Use `happier service restart` instead of `happier daemon restart`.',
      ],
    };
  }

  if (owner.serviceManaged === false) {
    return {
      title: 'Another relay runtime already owns this relay.',
      lines: [
        ...details,
        buildDaemonTakeoverHint({ commandPath: 'happier daemon', action: 'restart' }),
      ],
    };
  }

  return {
    title: 'The current relay owner source could not be determined safely.',
    lines: [
      ...details,
      'Use `happier service restart` only if you know the current owner came from the background service.',
    ],
  };
}
