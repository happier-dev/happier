import type { HomeQrCompletionTarget } from '@happier-dev/cli-common/homeEnrollment';

import type { HomeQrEnrollmentTarget } from './qrStart';

export function createAccountCompletionTarget(target: HomeQrEnrollmentTarget, token: string): HomeQrCompletionTarget {
    return {
        homeServerIdentityId: target.descriptor.homeServerIdentityId,
        request: (path, init) => target.createRequest({
            ...(target.serverId ? { serverId: target.serverId } : {}),
            credentials: { token },
        })(path, init, { includeAuth: true, retry: 'none' }),
    };
}
