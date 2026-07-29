function paneToken(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

export function createDevTargetPaneSpecs(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  return [
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
