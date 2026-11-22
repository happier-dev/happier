import fs from 'node:fs';
import path from 'node:path';

export function resolveHostedImages({ selected, channel, sha, repoRoot, namespace }) {
  if (!selected) return [];
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Hosted images require an exact source SHA');
  const consumers = [...new Set(selected.split(',').map((value) => value.trim()))];
  for (const service of consumers) {
    if (!['api', 'worker', 'ui'].includes(service)) throw new Error(`Unsupported hosted service: ${service}`);
  }
  return [
    { service: 'relay-server', target: 'relay-server', package: 'server', consumers: consumers.filter((value) => value !== 'ui') },
    { service: 'webapp', target: 'webapp', package: 'ui', consumers: consumers.filter((value) => value === 'ui') },
  ].filter((spec) => spec.consumers.length).map((spec) => {
    const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', spec.package, 'package.json'), 'utf8'));
    const tag = `${version}-${channel}-${sha}`;
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error(`Invalid image version for ${spec.service}`);
    return { ...spec, image: `${namespace}/${spec.service}:${tag}` };
  });
}
