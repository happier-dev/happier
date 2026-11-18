import { HomeDeviceApprovalRequestV1Schema, type HomeDeviceApprovalRequestV1 } from '@happier-dev/protocol/auth/accountDirectory';

export function homeDeviceApprovalRequestFixture(
    overrides: Partial<HomeDeviceApprovalRequestV1> = {},
): HomeDeviceApprovalRequestV1 {
    return HomeDeviceApprovalRequestV1Schema.parse({
        approvalId: 'home-approval', accountId: 'account-home', flow: 'account_assertion',
        requesterBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        issuerServerIdentityId: 'srv_directory', issuerSubjectId: 'account-directory',
        deviceLabel: 'New phone', status: 'pending', expiresAtMs: Date.now() + 600_000, decidedAtMs: null,
        ...overrides,
    });
}
