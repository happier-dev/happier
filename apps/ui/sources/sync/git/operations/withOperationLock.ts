import {
    withSessionProjectScmOperationLock,
    type WithSessionProjectScmOperationResult,
} from '@/scm/operations/withOperationLock';

export type WithSessionProjectGitOperationResult<T> = WithSessionProjectScmOperationResult<T>;

export async function withSessionProjectGitOperationLock<T>(
    input: Parameters<typeof withSessionProjectScmOperationLock<T>>[0]
): Promise<WithSessionProjectGitOperationResult<T>> {
    return withSessionProjectScmOperationLock(input);
}

