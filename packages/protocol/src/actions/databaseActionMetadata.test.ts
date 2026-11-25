import { describe, expect, it } from 'vitest';

import { DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1 } from './actionIdsDatabaseV1.js';
import { databaseActionMetadata } from './databaseActionMetadata.js';
import { pluginActionDeclarationRequiresConfirmationForInput } from '../plugins/actions/invocation.js';

describe('database capture confirmations', () => {
  it('asks once before capture turns on (or retries), never when it turns off', () => {
    const configure = databaseActionMetadata[DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1];
    const project = { machineId: 'machine', projectId: 'project' };
    const asks = (input: unknown) => pluginActionDeclarationRequiresConfirmationForInput(configure, 'ui', input);
    expect(asks({ project, enabled: true })).toBe(true);
    expect(asks({ project, enabled: true, retry: true })).toBe(true);
    expect(asks({ project, enabled: false })).toBe(false);
  });
});
