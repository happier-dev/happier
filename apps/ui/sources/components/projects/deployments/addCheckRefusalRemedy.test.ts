import { describe, expect, it } from 'vitest';

import { readAddCheckRefusalRemedyTarget } from './addCheckRefusalRemedy';

const refusal = (path: string) => ({ ok: false as const, errorCode: 'invalid_input',
  details: { issues: [{ code: 'invalid_input', path, severity: 'error', message: 'Edit the saved source.' }] } });
const saved = { automationId: 'environment-checks', triggerId: 'health' };
const other = { automationId: 'workflow', triggerId: 'watch' };

describe('Add check refusal remedy (R15)', () => {
  it('leads a "different Machine" refusal to the saved source that holds it', () => {
    expect(readAddCheckRefusalRemedyTarget(refusal('/trigger/observationTransport'), [saved, other], saved)).toEqual(other);
    expect(readAddCheckRefusalRemedyTarget(refusal('/trigger/observationTransport'), [saved], null)).toEqual(saved);
  });

  it('offers nothing when the refusal is about something else or no saved source is known', () => {
    expect(readAddCheckRefusalRemedyTarget(refusal('/trigger/filter'), [saved], null)).toBeUndefined();
    expect(readAddCheckRefusalRemedyTarget(refusal('/trigger/observationTransport'), [saved], saved)).toBeUndefined();
    expect(readAddCheckRefusalRemedyTarget({ ok: false, errorCode: 'currentness_conflict' }, [other], null)).toBeUndefined();
  });
});
