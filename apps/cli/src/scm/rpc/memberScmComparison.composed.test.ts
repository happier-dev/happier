import { it } from 'vitest';
import { runMemberScmComparisonRealUid } from './__tests__/memberScmComparisonRealUid.composed';

it.skipIf(process.platform !== 'linux' || process.env.HAPPIER_RUN_REAL_UID_INTEGRATION !== '1')(
  'captures, investigates and commits member-owned Git through the real credential-free worker UID', runMemberScmComparisonRealUid, 120_000);
