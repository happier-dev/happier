import { expect, it } from 'vitest';

import { stripSessionControlEnvOverrides } from './sessionControlEnvironment';

it('excludes host credential controls from overlays while preserving user-defined Happier variables', () => {
  expect(stripSessionControlEnvOverrides({
    HAPPIER_HOME_DIR: '/private/host',
    HAPPIER_DAEMON_TOKEN: 'host-token',
    happier_session_credential_file: '/private/host-credential',
    HAPPIER_TEST_SELECTED_ACCESS_TOKEN: 'selected-account-token',
  })).toEqual({ HAPPIER_TEST_SELECTED_ACCESS_TOKEN: 'selected-account-token' });
});
