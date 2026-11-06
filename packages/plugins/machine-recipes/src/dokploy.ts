import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { DOKPLOY_INSTALL_SCRIPT } from './dokployInstallScript.js';

export const dokploy: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Dokploy', software: true, icon: 'desktop',
  description: 'Deploy and manage your apps from your own server. Removing it also deletes Dokploy’s data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  steps: [
    { id: 'data', kind: 'directory', path: '/etc/dokploy', owner: 'root', group: 'root', mode: 0o777 },
    { id: 'install', kind: 'script', shell: 'bash', body: DOKPLOY_INSTALL_SCRIPT, affects: 'dockerEngine',
      review: { title: 'Exclusive web ports and Swarm changes', description: 'Dokploy needs exclusive use of host ports 80, 443 and 3000. Choose either Dokploy or Coolify on this Machine; their default proxies cannot share ports 80 and 443. Other services using these ports must be moved or removed first. The installer reinitializes Docker Swarm and can disrupt existing Swarm workloads. Startup waits for service health; use the operation’s Cancel action if it does not complete.' },
      check: { body: `[ "$(uname -s)" = Linux ] || exit 2
command -v docker >/dev/null 2>&1 || exit 1
docker info >/dev/null 2>&1 || exit 2
services=$(docker service ls --format '{{.Name}}') || exit 1
printf '%s\n' "$services" | grep -Fxq dokploy
`, unsatisfiedExitCodes: [1] } },
  ],
  removeSteps: [{ id: 'remove', kind: 'script', shell: 'sh', affects: 'dockerEngine', body: `set -eu
[ "$(uname -s)" = Linux ] || exit 2
swarm_manager=$(docker info --format '{{.Swarm.ControlAvailable}}')
if [ "$swarm_manager" = true ]; then
  services=$(docker service ls --format '{{.Name}}')
  for name in dokploy dokploy-traefik dokploy-postgres dokploy-redis; do
    if printf '%s\n' "$services" | grep -Fxq "$name"; then docker service rm "$name"; fi
  done
fi
containers=$(docker container ls --all --format '{{.Names}}')
if printf '%s\n' "$containers" | grep -Fxq dokploy-traefik; then docker container rm --force dokploy-traefik; fi
volumes=$(docker volume ls --format '{{.Name}}')
for name in dokploy dokploy-postgres dokploy-redis; do
  if printf '%s\n' "$volumes" | grep -Fxq "$name"; then docker volume rm "$name"; fi
done
if [ "$swarm_manager" = true ]; then
  secrets=$(docker secret ls --format '{{.Name}}')
  for name in dokploy_postgres_password dokploy_auth_secret; do
    if printf '%s\n' "$secrets" | grep -Fxq "$name"; then docker secret rm "$name"; fi
  done
fi
rm -rf -- /etc/dokploy
` }],
};
