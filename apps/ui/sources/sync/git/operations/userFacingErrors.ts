import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';

export function getGitUserFacingError(input: Parameters<typeof getScmUserFacingError>[0]): string {
    return getScmUserFacingError(input);
}

