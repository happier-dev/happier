import { test } from 'vitest';

import { serveDatabaseWorkbenchFixture } from './databaseWorkbenchFixtureProcess';

// The browser owns this run and its transport. The core testkit supplies the
// signed-in Person Action client and the native platform boundaries it needs.
const pipe = process.env.HAPPIER_DBW_BROWSER_FIXTURE_PIPE;
test.skipIf(!pipe)('serve the process-owned DBW browser fixture', async () => {
  await serveDatabaseWorkbenchFixture(pipe!);
}, 0);
