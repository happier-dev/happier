function requestedPlacement(placement, requested) {
  return requested ? placement : { mode: 'disabled' };
}

function commandExecutionUsesTarget(commands, targetName) {
  if (commands.mode === 'prefer-target') return commands.target === targetName;
  return commands.mode === 'auto' && commands.targets.includes(targetName);
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
    commands: commandExecutionUsesTarget(policy.commands, target.name),
    services: {
      server: placements.server.mode === 'prefer-target' && placements.server.target === target.name,
      expo: placements.expo.mode === 'prefer-target' && placements.expo.target === target.name,
      daemon:
        (placements.daemon.mode === 'prefer-target' && placements.daemon.target === target.name)
        || (placements.daemon.mode === 'local-and-targets' && placements.daemon.targets.includes(target.name)),
    },
  })).filter((plan) => plan.commands || Object.values(plan.services).some(Boolean));
  return { local, targets: targetPlans };
}

export function resolveServicePlansAfterTargetPreflight({
  configured,
  mutagenAvailable,
  reachableTargets,
}) {
  const local = { ...configured.local };
  const fallbacks = [];
  const targets = configured.targets.map((plan) => {
    const reachable = mutagenAvailable && reachableTargets.has(plan.target.name);
    const services = { ...plan.services };
    const fallbackServices = [];
    if (!reachable) {
      for (const [service, enabled] of Object.entries(services)) {
        if (!enabled || local[service]) continue;
        services[service] = false;
        local[service] = true;
        fallbackServices.push(service);
      }
    }
    if (fallbackServices.length > 0) {
      fallbacks.push({
        target: plan.target.name,
        services: fallbackServices,
        reason: mutagenAvailable ? 'target-unreachable' : 'mutagen-unavailable',
      });
    }
    return { ...plan, services };
  }).filter((plan) => plan.commands || Object.values(plan.services).some(Boolean));
  return { local, targets, fallbacks };
}
