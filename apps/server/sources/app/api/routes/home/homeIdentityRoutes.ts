import type { Fastify } from '@/app/api/types';
import { registerScopedIdentityRoutes } from '@/app/teams/identity/registerTeamIdentityRoutes';
import type { WorkosAdministrationDependencies } from '@/app/teams/identity/teamWorkosAdministration';

/** Home transport selects Home scope; administration remains shared with Teams. */
export function registerHomeIdentityRoutes(app: Fastify, dependencies: WorkosAdministrationDependencies = {}) {
    registerScopedIdentityRoutes(app, dependencies, 'home');
}
