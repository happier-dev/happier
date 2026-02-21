// @ts-check

/**
 * @typedef {{
 *   summary: string;
 *   usage: string;
 *   options?: string[];
 *   bullets: string[];
 *   examples: string[];
 * }} CommandHelpSpec
 */

/** @type {Record<string, CommandHelpSpec>} */
export const COMMAND_HELP_DOCKER = {
  'docker-publish': {
    summary: 'Build and publish multi-arch Docker images (Docker Hub + optional GHCR).',
    usage:
      'node scripts/pipeline/run.mjs docker-publish --channel <preview|stable> [--registries <csv>] [--sha <sha>] [--dry-run]',
    options: [
      '--channel <preview|stable>        Required.',
      '--registries <csv>               e.g. dockerhub,ghcr (default: env/auto).',
      '--sha <sha>                      Optional; override tag SHA.',
      '--push-latest <bool>             true|false (default: true).',
      '--build-relay <bool>             true|false (default: true).',
      '--build-dev-box <bool>           true|false (default: true).',
      '--allow-dirty <bool>             true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Uses Docker buildx; ensure Docker Desktop is running.',
      'GHCR publishing uses your `gh` auth; Docker Hub uses DOCKERHUB_USERNAME/DOCKERHUB_TOKEN.',
    ],
    examples: ['node scripts/pipeline/run.mjs docker-publish --channel preview --registries dockerhub,ghcr --dry-run'],
  },
};

