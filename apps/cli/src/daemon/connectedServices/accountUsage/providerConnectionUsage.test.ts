import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

// This architectural cost contract prevents a second admission of the same
// usage ticket before dispatch. Runtime protections live in probe's real suite.
it('admits each usage source once before dispatch', async () => {
  const source = await readFile(new URL('./providerConnectionUsage.ts', import.meta.url), 'utf8');
  expect([...source.matchAll(/input\.authorization\.(?:authorize|revalidate)\(/g)]).toHaveLength(1);
});
