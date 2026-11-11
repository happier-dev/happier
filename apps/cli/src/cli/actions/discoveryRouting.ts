import { argvBeforeOptionTerminator } from '../processArgs';

/** CI rendering is owned by the Actions host, rather than Action specification lookup. */
export function isDeploymentCiStepCommand(argv: readonly string[]): boolean {
  return argv[0] === 'actions'
    && argv[1] === 'get'
    && argvBeforeOptionTerminator(argv).includes('--github-actions');
}
