import { describe, expect, it, vi } from 'vitest';

import { runPublishRemediationAction } from './PublishRemediationAction';

describe('runPublishRemediationAction', () => {
    it('executes remediation only while its action is enabled', async () => {
        const onInstallGh = vi.fn();

        await runPublishRemediationAction({
            action: { kind: 'install-gh', disabled: true },
            onInstallGh,
            setErrorCode: vi.fn(),
        });

        expect(onInstallGh).not.toHaveBeenCalled();

        await runPublishRemediationAction({
            action: { kind: 'install-gh', disabled: false },
            onInstallGh,
            setErrorCode: vi.fn(),
        });
        expect(onInstallGh).toHaveBeenCalledOnce();
    });
});
