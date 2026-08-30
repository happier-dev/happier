function requestedPlacement(placement, requested) {
  return requested ? placement : { mode: 'disabled' };
}

export function resolveDevTargetServicePlans({ targets, policy, requested }) {
  const placements = {
    server: requestedPlacement(policy.server, requested.server),
    expo: requestedPlacement(policy.expo, requested.expo),
    daemon: requestedPlacement(policy.daemons, requested.daemon),
  };
  const local = {
    server: placements.server.mode === 'local',
    expo: placements.expo.mode === 'local',
    daemon: placements.daemon.mode === 'local' || placements.daemon.mode === 'local-and-targets',
  };
  const targetPlans = targets.map((target) => ({
    target,
    services: {
      server: placements.server.mode === 'prefer-target' && placements.server.target === target.name,
      expo: placements.expo.mode === 'prefer-target' && placements.expo.target === target.name,
      daemon:
        (placements.daemon.mode === 'prefer-target' && placements.daemon.target === target.name)
        || (placements.daemon.mode === 'local-and-targets' && placements.daemon.targets.includes(target.name)),
    },
  })).filter((plan) => Object.values(plan.services).some(Boolean));
  return { local, targets: targetPlans };
}

export function resolveServicePlansAfterTargetPreflight({
  configured,
  mutagenAvailable,
  reachableTargets,
}) {
  const unavailableServerPlan = configured.targets.find((plan) => (
    plan.services.server
    && (!mutagenAvailable || !reachableTargets.has(plan.target.name))
  ));
  if (unavailableServerPlan) {
    throw new Error(
      `[dev-targets] persisted server placement is authoritative and ${unavailableServerPlan.target.name} `
      + 'is unavailable during target preflight',
    );
  }
  return configured;
}
