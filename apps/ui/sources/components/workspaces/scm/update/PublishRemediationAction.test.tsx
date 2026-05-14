import { describe, expect, it, vi } from 'vitest';

import { runPublishRemediationAction } from './PublishRemediationAction';

describe('runPublishRemediationAction', () => {
    it('does not execute disabled remediation actions', async () => {
        const onInstallGh = vi.fn();

        await runPublishRemediationAction({
            action: { kind: 'install-gh', disabled: true },
            onInstallGh,
            setErrorCode: vi.fn(),
        });

        expect(onInstallGh).not.toHaveBeenCalled();
    });
});
