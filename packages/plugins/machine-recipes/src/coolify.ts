import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { COOLIFY_INSTALL_SCRIPT } from './coolifyInstallScript.js';

/** Vendor-owned resources only; shared Docker, images and networks are retained. */
export const coolify: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Coolify', software: true, icon: 'desktop',
  description: 'Deploy and manage your apps from your own server. Removing it also deletes Coolify’s data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  steps: [
    { id: 'data-parent', kind: 'script', shell: 'sh', body: 'mkdir -p -- /data\n', affects: 'none' },
    { id: 'data', kind: 'directory', path: '/data/coolify', owner: 'root', group: 'root', mode: 0o700 },
    // The native footprint records initial absence. Restore vendor ownership
    // every Apply, including when the checked installer is already satisfied.
    { id: 'data-owner', kind: 'script', shell: 'sh', body: 'chown 9999:root /data/coolify\n', affects: 'none' },
    { id: 'install', kind: 'script', shell: 'bash', body: COOLIFY_INSTALL_SCRIPT, affects: 'dockerEngine',
      review: { title: 'Exclusive web ports', description: 'Coolify’s proxy needs exclusive use of host ports 80 and 443. Choose either Coolify or Dokploy on this Machine; their default proxies cannot share these ports. Other services already using these ports must be moved or removed first.' },
      check: { body: `[ "$(uname -s)" = Linux ] || exit 2
command -v docker >/dev/null 2>&1 || exit 1
docker info >/dev/null 2>&1 || exit 2
containers=$(docker container ls --all --format '{{.Names}}') || exit 2
printf '%s\n' "$containers" | grep -Fxq coolify
`, unsatisfiedExitCodes: [1] } },
  ],
  removeSteps: [{ id: 'remove', kind: 'script', shell: 'sh', affects: 'dockerEngine', body: `set -eu
[ "$(uname -s)" = Linux ] || exit 2
docker info >/dev/null
containers=$(docker container ls --all --format '{{.Names}}')
for name in coolify coolify-db coolify-redis coolify-sentinel coolify-realtime coolify-proxy; do
  if printf '%s\n' "$containers" | grep -Fxq "$name"; then docker container rm --force "$name"; fi
done
volumes=$(docker volume ls --format '{{.Name}}')
for name in coolify-db coolify-redis; do
  if printf '%s\n' "$volumes" | grep -Fxq "$name"; then docker volume rm "$name"; fi
done
rm -rf -- /data/coolify
` }],
};
