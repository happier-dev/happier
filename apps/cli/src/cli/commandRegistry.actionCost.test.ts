import { describe, expect, it, vi } from 'vitest';
import * as schemaProjection from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { resolveAdmittedActionCliCommand } from './commandRegistry';

describe('Action command admission cost', () => {
  it('does not project unrelated friendly command schemas for generic invoke', async () => {
    const projections = vi.spyOn(schemaProjection, 'zodSchemaToJsonSchemaObject');
    try {
      expect(await resolveAdmittedActionCliCommand(['actions', 'invoke', 'inbox.get', '--input-json', '{}'])).toBeNull();
      expect(await resolveAdmittedActionCliCommand(['actions', 'unknown'])).toBeNull();
      expect(await resolveAdmittedActionCliCommand(['unknown'])).toBeNull();
      expect(projections).toHaveBeenCalledTimes(0);

      expect(await resolveAdmittedActionCliCommand(['actions', 'search', 'machine']))
        .toMatchObject({ actionId: 'action.spec.search' });
      expect(projections.mock.calls.length).toBeGreaterThan(0);
    } finally {
      projections.mockRestore();
    }
  });
});
