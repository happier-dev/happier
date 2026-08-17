function normalizeRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function resolveRuntimeRemoteServiceObservation(runtime, service) {
  const serviceName = String(service ?? '').trim();
  const placement = normalizeRecord(runtime?.placement);
  const remoteTargets = normalizeRecord(runtime?.remoteTargets);
  const target = typeof placement[serviceName] === 'string'
    && !['local', 'disabled'].includes(placement[serviceName])
    ? placement[serviceName]
    : null;
  const state = target ? normalizeRecord(remoteTargets[target]) : {};
  const serviceStatus = normalizeRecord(state.serviceStatus)[serviceName];
  const status = typeof serviceStatus === 'string'
    ? serviceStatus
    : (typeof state.status === 'string' ? state.status : null);
  return {
    target,
    running: Boolean(target && normalizeRecord(state.services)[serviceName] === true && status === 'running'),
    status,
  };
}

export function shouldPresentRuntimeServiceEndpoint(runtime, service) {
  const observation = resolveRuntimeRemoteServiceObservation(runtime, service);
  return !observation.target || observation.running;
}

export function formatRuntimeExpoDevClientLines(runtime, payload) {
  const observation = resolveRuntimeRemoteServiceObservation(runtime, 'expo');
  if (observation.target && !observation.running) {
    const targetState = normalizeRecord(normalizeRecord(runtime?.remoteTargets)[observation.target]);
    const status = observation.status ?? 'unknown';
    const phase = typeof targetState.phase === 'string' && targetState.phase.trim()
      ? ` phase=${targetState.phase.trim()}`
      : '';
    return [
      'expo dev-client:',
      `  pending: ${observation.target} status=${status}${phase}`,
    ];
  }

  return [
    'expo dev-client links:',
    ...(payload?.metroUrl ? [`  metro: ${payload.metroUrl}`] : []),
    ...(payload?.scheme && payload?.deepLink ? [`  link:  ${payload.deepLink}`] : []),
  ];
}

export function formatRuntimePlacementSummaryLines(runtime) {
  const placement = normalizeRecord(runtime?.placement);
  const remoteTargets = normalizeRecord(runtime?.remoteTargets);
  const lines = [];
  const placedServices = ['server', 'expo', 'daemon']
    .filter((service) => typeof placement[service] === 'string' && placement[service].trim());
  if (placedServices.length > 0) {
    lines.push('placement:');
    for (const service of placedServices) lines.push(`  ${service}: ${placement[service]}`);
  }
  const targets = Object.entries(remoteTargets);
  if (targets.length > 0) {
    lines.push('remote targets:');
    for (const [name, rawState] of targets) {
      const state = normalizeRecord(rawState);
      const services = Object.entries(normalizeRecord(state.services))
        .filter(([, enabled]) => enabled === true)
        .map(([service]) => service);
      if (state.commands === true) services.push('commands');
      const suffix = [
        services.length > 0 ? `(${services.join(', ')})` : '',
        state.phase ? `phase=${state.phase}` : '',
        state.error ? `error=${state.error}` : '',
      ].filter(Boolean).join(' ');
      lines.push(`  ${name}: ${state.status ?? 'unknown'}${suffix ? ` ${suffix}` : ''}`);
    }
  }
  return lines;
}
