import type { ApprovalRequest } from '@happier-dev/protocol';
import { ComputerSecretFillRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { BrowserAutomationSecretFillRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import type { PrivateSecretContinuationV1 } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';

type Binding<T> = T extends PrivateSecretContinuationV1
    ? Pick<T, 'actionId' | 'request' | 'requestId'> & Readonly<{ expectedServerIdentityId: string | null }>
    : never;
export type ConfidentialSecretApproval = Binding<PrivateSecretContinuationV1>;

/** Presentation classification only; the existing private continuation owns admission. */
export function isConfidentialSecretApprovalAction(actionId: string): boolean {
    return actionId === 'computer.secret.fill' || actionId === 'browser.automation.secret.fill';
}

export function readConfidentialSecretApproval(approval: ApprovalRequest): ConfidentialSecretApproval | null {
    if (approval.v !== 2) return null;
    const binding = { requestId: approval.executionOriginV1.requestId,
        expectedServerIdentityId: approval.executionOriginV1.serverIdentityId ?? null };
    if (approval.actionId === 'computer.secret.fill') {
        const parsed = ComputerSecretFillRequestV1Schema.safeParse(approval.actionArgs);
        return parsed.success ? { ...binding, actionId: 'computer.secret.fill', request: parsed.data } : null;
    }
    if (approval.actionId === 'browser.automation.secret.fill') {
        const parsed = BrowserAutomationSecretFillRequestV1Schema.safeParse(approval.actionArgs);
        return parsed.success ? { ...binding, actionId: 'browser.automation.secret.fill', request: parsed.data } : null;
    }
    return null;
}
