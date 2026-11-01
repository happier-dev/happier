import { expect, it } from 'vitest';

import { createAccountSettingsFailedStatus } from './accountSettingsSyncStatus';

it('shows a terminal failure when the retry owner stops on a non-HappyError', () => {
    const error = Object.assign(new Error('invalid response'), { retryable: false });
    expect(createAccountSettingsFailedStatus({ error })).toMatchObject({ state: 'failed', retryable: false });
});
