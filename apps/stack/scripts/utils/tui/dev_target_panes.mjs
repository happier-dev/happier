function paneToken(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

export function createDevTargetPaneSpecs(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  return [
    { id: 'fabric', title: 'execution fabric', visible: true, kind: 'summary' },
    { id: 'mutagen', title: 'mutagen sync', visible: true, kind: 'log' },
    ...targets.map((target) => {
      const name = paneToken(target.name);
      return { id: `remote-${name}`, title: `remote ${name}`, visible: true, kind: 'log' };
    }),
  ];
}

export function routeDevTargetLogPaneId(normalizedLabel, configuredTargetNames) {
  const label = String(normalizedLabel ?? '').trim().toLowerCase();
  if (label === 'mutagen') return 'mutagen';
  if (!label.startsWith('remote:')) return null;
  const targetName = paneToken(label.slice('remote:'.length));
  return configuredTargetNames?.has(targetName) ? `remote-${targetName}` : null;
}

export function routeRemoteServiceLogPaneId(line, configuredTargetPlans) {
  const match = String(line ?? '').match(/^\[remote:([^\]]+)\]\s+\[([^\]]+)\]\s*/i);
  if (!match) return null;

  const targetName = paneToken(match[1]);
  const plan = configuredTargetPlans?.find(
    (candidate) => paneToken(candidate?.target?.name) === targetName,
  );
  if (!plan) return null;

  const nestedLabel = String(match[2]).trim().toLowerCase();
  if (plan.services?.expo && ['expo', 'mobile', 'ui'].includes(nestedLabel)) return 'expo';
  if (plan.services?.server && nestedLabel.includes('server')) return 'server';
  if (plan.services?.daemon && nestedLabel.includes('daemon')) return 'daemon';
  return null;
}
